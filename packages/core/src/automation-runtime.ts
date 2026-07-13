import {
	parseDuration,
	type AutomationJob,
	type AutomationOwner,
	type AutomationRun,
	type AutomationStore,
} from "@beemax/automation";
import type { DeliveryPort } from "./delivery-port.ts";

export type AutomationExecutor = (job: AutomationJob, signal?: AbortSignal) => Promise<{ output?: string }>;

/** Core owns scheduled-agent lifecycle; Automation supplies persistence only. */
export class AutomationScheduler {
	private timer?: ReturnType<typeof setTimeout>;
	private readonly running = new Set<Promise<void>>();
	private readonly controllers = new Set<AbortController>();
	private readonly shutdownGraceMs = 30_000;
	private stopped = true;
	private readonly store: AutomationStore;
	private readonly execute: AutomationExecutor;
	private readonly maxConcurrent: number;

	constructor(
		store: AutomationStore,
		execute: AutomationExecutor,
		maxConcurrent = 4,
	) {
		this.store = store;
		this.execute = execute;
		this.maxConcurrent = maxConcurrent;
	}

	start(): void { if (this.stopped) { this.stopped = false; this.schedule(0); } }
	wake(): void { if (!this.stopped) { if (this.timer) clearTimeout(this.timer); this.schedule(0); } }
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const controller of this.controllers) controller.abort(new Error("Automation scheduler stopped"));
		await settleWithin([...this.running], this.shutdownGraceMs);
	}
	private schedule(delay: number): void {
		if (!this.stopped) this.timer = setTimeout(() => void this.tick(), Math.max(0, delay));
	}
	private async tick(): Promise<void> {
		if (this.stopped) return;
		try {
			const capacity = Math.max(0, this.maxConcurrent - this.running.size);
			if (capacity > 0) for (const job of this.store.claimDue(Date.now(), capacity)) this.launch(job);
		} catch (error) {
			console.error(`[beemax] automation scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const next = this.store.nextDueAt();
		this.schedule(next === undefined ? 30_000 : Math.min(30_000, Math.max(250, next - Date.now())));
	}
	private launch(job: AutomationJob): void {
		const startedAt = Date.now();
		const controller = new AbortController();
		this.controllers.add(controller);
		const heartbeat = job.claimToken && this.store.renewClaim ? setInterval(() => {
			try { if (!this.store.renewClaim(job.id, job.claimToken!, Date.now() + 15 * 60_000)) controller.abort(new Error(`Automation lease lost: ${job.id}`)); }
			catch (error) { controller.abort(error); }
		}, 60_000) : undefined;
		heartbeat?.unref();
		const promise = (async () => {
			let result: Omit<AutomationRun, "id" | "jobId">;
			try {
				const executed = await this.execute(job, controller.signal);
				result = { startedAt, finishedAt: Date.now(), status: "ok", output: executed.output };
			} catch (error) {
				result = { startedAt, finishedAt: Date.now(), status: "error", error: error instanceof Error ? error.message : String(error) };
			}
			if (this.store.complete(job, result) === false) return;
		})().finally(() => { if (heartbeat) clearInterval(heartbeat); this.controllers.delete(controller); this.running.delete(promise); this.wake(); });
		this.running.add(promise);
	}
}

async function settleWithin(work: Promise<unknown>[], graceMs: number): Promise<void> {
	if (!work.length) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([Promise.allSettled(work), new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); })]);
	if (timer) clearTimeout(timer);
}

export interface HeartbeatConfig {
	enabled: boolean;
	every: string;
	platform: string;
	chatId?: string;
	userId?: string;
	prompt: string;
	ackMaxChars: number;
	timeoutMs: number;
	activeHours?: { start: string; end: string; timezone?: string };
}
export interface HeartbeatExecution { route: AutomationOwner; prompt: string; timeoutMs: number; }
export type HeartbeatExecutor = (input: HeartbeatExecution, signal?: AbortSignal) => Promise<string>;
export type HeartbeatObservation = { kind: "ignored" | "observed" };
export type HeartbeatObserver = (input: HeartbeatExecution & { triggerId: string; occurredAt: number; reason: "interval" | "manual" }, signal?: AbortSignal) => Promise<HeartbeatObservation>;

/** Core policy for proactive checks; the channel delivery function is a port. */
export class HeartbeatRunner {
	private timer?: ReturnType<typeof setTimeout>;
	private running = false;
	private stopped = true;
	private activeRun?: Promise<void>;
	private activeController?: AbortController;
	private readonly intervalMs: number;
	private readonly store: AutomationStore;
	private readonly config: HeartbeatConfig;
	private readonly execute: HeartbeatExecutor;
	private readonly deliveryPort: DeliveryPort;
	private readonly isBusy: () => boolean;
	private readonly observe?: HeartbeatObserver;
	constructor(
		store: AutomationStore,
		config: HeartbeatConfig,
		execute: HeartbeatExecutor,
		deliveryPort: DeliveryPort,
		isBusy: () => boolean,
		observe?: HeartbeatObserver,
	) {
		this.store = store;
		this.config = config;
		this.execute = execute;
		this.deliveryPort = deliveryPort;
		this.isBusy = isBusy;
		this.observe = observe;
		this.intervalMs = parseDuration(config.every);
	}
	start(): void { if (this.stopped && this.config.enabled) { this.stopped = false; this.schedule(this.intervalMs); } }
	setRoute(chatId: string, userId?: string): void { this.config.chatId = chatId; this.config.userId = userId; }
	async wake(): Promise<void> {
		if (this.stopped || !this.config.enabled) return;
		if (this.timer) clearTimeout(this.timer);
		await this.startRun("manual");
	}
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.activeController?.abort(new Error("Heartbeat stopped"));
		if (this.activeRun) await settleWithin([this.activeRun], 30_000);
	}
	private schedule(delay: number): void {
		if (!this.stopped) this.timer = setTimeout(() => void this.startRun("interval"), Math.max(1000, delay));
	}
	private async startRun(reason: "interval" | "manual"): Promise<void> {
		if (this.activeRun) { await this.activeRun; return; }
		const controller = new AbortController(); this.activeController = controller;
		const active = this.run(reason, controller.signal); this.activeRun = active;
		try { await active; } finally { if (this.activeRun === active) { this.activeRun = undefined; this.activeController = undefined; } }
	}
	private async run(reason: "interval" | "manual", signal: AbortSignal): Promise<void> {
		if (this.stopped || this.running) return;
		if (!isWithinActiveHours(this.config.activeHours, Date.now())) {
			this.store.recordHeartbeat("skipped", "quiet-hours"); this.schedule(this.intervalMs); return;
		}
		if (this.isBusy()) {
			this.store.recordHeartbeat("skipped", "agent-busy"); this.schedule(Math.min(60_000, this.intervalMs)); return;
		}
		const route = this.config.chatId
			? { platform: this.config.platform, chatId: this.config.chatId, userId: this.config.userId }
			: this.store.getLastRoute(this.config.platform, this.config.userId);
		if (!route) { this.store.recordHeartbeat("skipped", "no-delivery-route"); this.schedule(this.intervalMs); return; }
		this.running = true;
		try {
			if (this.observe) {
				const occurredAt = Date.now();
				const observed = await Promise.race([this.observe({ route, prompt: this.config.prompt, timeoutMs: this.config.timeoutMs, triggerId: `heartbeat:${this.config.platform}:${route.userId ?? route.chatId}`, occurredAt, reason }, signal), new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
				this.store.recordHeartbeat(observed.kind === "observed" ? "observed" : "ok", reason);
				return;
			}
			const answer = await Promise.race([this.execute({ route, prompt: this.config.prompt, timeoutMs: this.config.timeoutMs }, signal), new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
			const filtered = filterHeartbeatAnswer(answer, this.config.ackMaxChars);
			if (filtered.notify) await this.deliveryPort.sendText(route, filtered.text);
			this.store.recordHeartbeat(filtered.notify ? "alert" : "ok", reason);
		} catch (error) {
			this.store.recordHeartbeat("error", error instanceof Error ? error.message : String(error));
			console.error(`[beemax] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally { this.running = false; this.schedule(this.intervalMs); }
	}
}

export function filterHeartbeatAnswer(answer: string, ackMaxChars = 300): { notify: boolean; text: string } {
	const trimmed = answer.trim(); const token = "HEARTBEAT_OK";
	const remainder = trimmed.startsWith(token) ? trimmed.slice(token.length).trim()
		: trimmed.endsWith(token) ? trimmed.slice(0, -token.length).trim() : undefined;
	if (remainder !== undefined && remainder.length <= ackMaxChars) return { notify: false, text: "" };
	return { notify: trimmed.length > 0, text: remainder && remainder.length > ackMaxChars ? remainder : trimmed };
}
export function isWithinActiveHours(active: HeartbeatConfig["activeHours"], nowMs: number): boolean {
	if (!active) return true;
	const start = parseClock(active.start, false), end = parseClock(active.end, true);
	if (start === undefined || end === undefined) return true;
	if (start === end) return false;
	let formatter: Intl.DateTimeFormat;
	try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: active.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); } catch { return true; }
	const parts = Object.fromEntries(formatter.formatToParts(new Date(nowMs)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
	const current = Number(parts.hour) * 60 + Number(parts.minute);
	return !Number.isFinite(current) ? true : end > start ? current >= start && current < end : current >= start || current < end;
}
function parseClock(value: string, allow24: boolean): number | undefined {
	const match = value.match(/^(\d{2}):(\d{2})$/); if (!match) return undefined;
	const hour = Number(match[1]), minute = Number(match[2]);
	return minute > 59 || hour > 24 || (hour === 24 && (!allow24 || minute !== 0)) ? undefined : hour * 60 + minute;
}

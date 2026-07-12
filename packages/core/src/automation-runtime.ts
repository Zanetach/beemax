import {
	parseDuration,
	type AutomationJob,
	type AutomationOwner,
	type AutomationRun,
	type AutomationStore,
} from "@beemax/automation";
import type { DeliveryPort } from "./delivery-port.ts";
import { conversationOwnerKey } from "./agent-scope.ts";
import type { TaskLedger } from "./task-ledger.ts";

export type AutomationExecutor = (job: AutomationJob) => Promise<{ output?: string }>;

/** Core owns scheduled-agent lifecycle; Automation supplies persistence only. */
export class AutomationScheduler {
	private timer?: ReturnType<typeof setTimeout>;
	private readonly running = new Set<Promise<void>>();
	private stopped = true;
	private readonly store: AutomationStore;
	private readonly execute: AutomationExecutor;
	private readonly maxConcurrent: number;
	private readonly taskLedger?: TaskLedger;

	constructor(
		store: AutomationStore,
		execute: AutomationExecutor,
		maxConcurrent = 4,
		taskLedger?: TaskLedger,
	) {
		this.store = store;
		this.execute = execute;
		this.maxConcurrent = maxConcurrent;
		this.taskLedger = taskLedger;
	}

	start(): void { if (this.stopped) { this.stopped = false; this.schedule(0); } }
	wake(): void { if (!this.stopped) { if (this.timer) clearTimeout(this.timer); this.schedule(0); } }
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		await Promise.allSettled([...this.running]);
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
		const taskId = crypto.randomUUID();
		const runId = crypto.randomUUID();
		this.recordAutomationStart(job, taskId, runId, startedAt);
		const promise = (async () => {
			let result: Omit<AutomationRun, "id" | "jobId">;
			try {
				const executed = await this.execute(job);
				result = { startedAt, finishedAt: Date.now(), status: "ok", output: executed.output };
			} catch (error) {
				result = { startedAt, finishedAt: Date.now(), status: "error", error: error instanceof Error ? error.message : String(error) };
			}
			this.store.complete(job, result);
			this.recordAutomationFinish(taskId, runId, result);
		})().finally(() => { this.running.delete(promise); this.wake(); });
		this.running.add(promise);
	}

	private recordAutomationStart(job: AutomationJob, taskId: string, runId: string, startedAt: number): void {
		if (!this.taskLedger) return;
		try {
			const ownerKey = conversationOwnerKey({ platform: job.platform, chatId: job.chatId, chatType: "dm", userId: job.userId });
			this.taskLedger.record({ id: taskId, ownerKey, kind: "automation", title: job.name, status: "running", evidence: `schedule:${job.id}`, createdAt: startedAt, startedAt });
			this.taskLedger.recordRun({ id: runId, taskId, executor: "automation", status: "running", startedAt });
		} catch (error) { console.error(`[beemax] could not record automation Task start: ${error instanceof Error ? error.message : String(error)}`); }
	}

	private recordAutomationFinish(taskId: string, runId: string, result: Omit<AutomationRun, "id" | "jobId">): void {
		if (!this.taskLedger) return;
		const succeeded = result.status === "ok";
		const output = result.output?.slice(0, 50_000);
		const errorText = result.error?.slice(0, 5_000);
		try {
			this.taskLedger.transition(taskId, { status: succeeded ? "succeeded" : "failed", finishedAt: result.finishedAt, result: output, error: errorText });
			this.taskLedger.transitionRun(runId, { status: succeeded ? "succeeded" : "failed", finishedAt: result.finishedAt, output, error: errorText });
		} catch (error) { console.error(`[beemax] could not record automation Task completion: ${error instanceof Error ? error.message : String(error)}`); }
	}
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
export type HeartbeatExecutor = (input: HeartbeatExecution) => Promise<string>;

/** Core policy for proactive checks; the channel delivery function is a port. */
export class HeartbeatRunner {
	private timer?: ReturnType<typeof setTimeout>;
	private running = false;
	private stopped = true;
	private activeRun?: Promise<void>;
	private readonly intervalMs: number;
	private readonly store: AutomationStore;
	private readonly config: HeartbeatConfig;
	private readonly execute: HeartbeatExecutor;
	private readonly deliveryPort: DeliveryPort;
	private readonly isBusy: () => boolean;
	constructor(
		store: AutomationStore,
		config: HeartbeatConfig,
		execute: HeartbeatExecutor,
		deliveryPort: DeliveryPort,
		isBusy: () => boolean,
	) {
		this.store = store;
		this.config = config;
		this.execute = execute;
		this.deliveryPort = deliveryPort;
		this.isBusy = isBusy;
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
		await this.activeRun?.catch(() => undefined);
	}
	private schedule(delay: number): void {
		if (!this.stopped) this.timer = setTimeout(() => void this.startRun("interval"), Math.max(1000, delay));
	}
	private async startRun(reason: "interval" | "manual"): Promise<void> {
		const active = this.run(reason); this.activeRun = active;
		try { await active; } finally { if (this.activeRun === active) this.activeRun = undefined; }
	}
	private async run(reason: "interval" | "manual"): Promise<void> {
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
			const answer = await this.execute({ route, prompt: this.config.prompt, timeoutMs: this.config.timeoutMs });
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

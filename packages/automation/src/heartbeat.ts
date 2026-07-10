import { parseDuration, type AutomationOwner, type AutomationStore } from "./store.ts";

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

export interface HeartbeatExecution {
	route: AutomationOwner;
	prompt: string;
	timeoutMs: number;
}

export type HeartbeatExecutor = (input: HeartbeatExecution) => Promise<string>;

export class HeartbeatRunner {
	private timer?: ReturnType<typeof setTimeout>;
	private running = false;
	private stopped = true;
	private activeRun?: Promise<void>;
	private readonly intervalMs: number;
	private readonly store: AutomationStore;
	private readonly config: HeartbeatConfig;
	private readonly execute: HeartbeatExecutor;
	private readonly deliver: (route: AutomationOwner, text: string) => Promise<void>;
	private readonly isBusy: () => boolean;

	constructor(
		store: AutomationStore,
		config: HeartbeatConfig,
		execute: HeartbeatExecutor,
		deliver: (route: AutomationOwner, text: string) => Promise<void>,
		isBusy: () => boolean,
	) {
		this.store = store;
		this.config = config;
		this.execute = execute;
		this.deliver = deliver;
		this.isBusy = isBusy;
		this.intervalMs = parseDuration(config.every);
	}

	start(): void {
		if (!this.stopped || !this.config.enabled) return;
		this.stopped = false;
		this.schedule(this.intervalMs);
	}

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
		if (this.stopped) return;
		this.timer = setTimeout(() => void this.startRun("interval"), Math.max(1000, delay));
	}

	private async startRun(reason: "interval" | "manual"): Promise<void> {
		const active = this.run(reason);
		this.activeRun = active;
		try { await active; } finally {
			if (this.activeRun === active) this.activeRun = undefined;
		}
	}

	private async run(reason: "interval" | "manual"): Promise<void> {
		if (this.stopped || this.running) return;
		if (!isWithinActiveHours(this.config.activeHours, Date.now())) {
			this.store.recordHeartbeat("skipped", "quiet-hours");
			this.schedule(this.intervalMs);
			return;
		}
		if (this.isBusy()) {
			this.store.recordHeartbeat("skipped", "agent-busy");
			this.schedule(Math.min(60_000, this.intervalMs));
			return;
		}
		const route = this.config.chatId
			? { platform: this.config.platform, chatId: this.config.chatId, userId: this.config.userId }
			: this.store.getLastRoute(this.config.platform, this.config.userId);
		if (!route) {
			this.store.recordHeartbeat("skipped", "no-delivery-route");
			this.schedule(this.intervalMs);
			return;
		}
		this.running = true;
		try {
			const answer = await this.execute({ route, prompt: this.config.prompt, timeoutMs: this.config.timeoutMs });
			const filtered = filterHeartbeatAnswer(answer, this.config.ackMaxChars);
			if (filtered.notify) await this.deliver(route, filtered.text);
			this.store.recordHeartbeat(filtered.notify ? "alert" : "ok", reason);
		} catch (error) {
			this.store.recordHeartbeat("error", error instanceof Error ? error.message : String(error));
			console.error(`[beemax] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.running = false;
			this.schedule(this.intervalMs);
		}
	}
}

export function filterHeartbeatAnswer(answer: string, ackMaxChars = 300): { notify: boolean; text: string } {
	const trimmed = answer.trim();
	const token = "HEARTBEAT_OK";
	let remainder: string | undefined;
	if (trimmed.startsWith(token)) remainder = trimmed.slice(token.length).trim();
	else if (trimmed.endsWith(token)) remainder = trimmed.slice(0, -token.length).trim();
	if (remainder !== undefined && remainder.length <= ackMaxChars) return { notify: false, text: "" };
	return { notify: trimmed.length > 0, text: remainder && remainder.length > ackMaxChars ? remainder : trimmed };
}

export function isWithinActiveHours(
	active: HeartbeatConfig["activeHours"],
	nowMs: number,
): boolean {
	if (!active) return true;
	const start = parseClock(active.start, false);
	const end = parseClock(active.end, true);
	if (start === undefined || end === undefined) return true;
	if (start === end) return false;
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: active.timezone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
	} catch {
		return true;
	}
	const parts = Object.fromEntries(formatter.formatToParts(new Date(nowMs))
		.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
	const current = Number(parts.hour) * 60 + Number(parts.minute);
	if (!Number.isFinite(current)) return true;
	return end > start ? current >= start && current < end : current >= start || current < end;
}

function parseClock(value: string, allow24: boolean): number | undefined {
	const match = value.match(/^(\d{2}):(\d{2})$/);
	if (!match) return undefined;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (minute > 59 || hour > 24 || (hour === 24 && (!allow24 || minute !== 0))) return undefined;
	return hour * 60 + minute;
}

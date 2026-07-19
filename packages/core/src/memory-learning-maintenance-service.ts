import type { MaintainMemoryInput, MaintenanceResult, MemoryLearningKernel } from "./memory-learning-kernel.ts";

export interface MemoryLearningMaintenanceServiceOptions {
	profileId: string;
	intervalMs?: number;
	maxItems?: number;
	maxModelCalls?: number;
	leaseMs?: number;
	now?: () => number;
	admit?: (ownerKey: string, work: () => Promise<MaintenanceResult>) => Promise<MaintenanceResult>;
	onCycle?: (result: MaintenanceResult, trigger: MaintainMemoryInput["trigger"]) => void;
	onError?: (error: unknown) => void;
}

type MaintenanceKernel = Pick<MemoryLearningKernel, "maintain">;
type MaintenanceTrigger = MaintainMemoryInput["trigger"];

/**
 * Profile-owned, coalescing driver for durable Memory Learning work.
 *
 * The timer only wakes the service. Actual work can be admitted through the
 * Profile task scheduler so learning never creates a second concurrency
 * authority or blocks an interactive turn.
 */
export class MemoryLearningMaintenanceService {
	private readonly kernel: MaintenanceKernel;
	private readonly profileId: string;
	private readonly ownerKey: string;
	private readonly intervalMs: number;
	private readonly maxItems: number;
	private readonly maxModelCalls: number;
	private readonly leaseMs: number;
	private readonly now: () => number;
	private readonly admit: NonNullable<MemoryLearningMaintenanceServiceOptions["admit"]>;
	private readonly onCycle?: MemoryLearningMaintenanceServiceOptions["onCycle"];
	private readonly onError?: MemoryLearningMaintenanceServiceOptions["onError"];
	private timer?: ReturnType<typeof setTimeout>;
	private periodicTimer = false;
	private active?: Promise<MaintenanceResult>;
	private pendingTrigger?: MaintenanceTrigger;
	private stopped = true;
	private readonly idleWaiters = new Set<() => void>();

	constructor(kernel: MaintenanceKernel, options: MemoryLearningMaintenanceServiceOptions) {
		this.kernel = kernel;
		this.profileId = requiredIdentifier(options.profileId, "Memory Learning maintenance Profile");
		this.ownerKey = `profile:${this.profileId}:memory-learning`;
		this.intervalMs = boundedInteger(options.intervalMs, 30_000, 10, 24 * 60 * 60_000);
		this.maxItems = boundedInteger(options.maxItems, 25, 1, 1_000);
		this.maxModelCalls = boundedInteger(options.maxModelCalls, 8, 0, 10_000);
		this.leaseMs = boundedInteger(options.leaseMs, 60_000, 1_000, 24 * 60 * 60_000);
		this.now = options.now ?? Date.now;
		this.admit = options.admit ?? ((_ownerKey, work) => work());
		this.onCycle = options.onCycle;
		this.onError = options.onError;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.request("recovery");
	}

	/** Coalesce any number of durable signal notifications into one extra pass. */
	wake(): void {
		if (this.stopped) return;
		this.request("signal");
	}

	async runOnce(trigger: MaintenanceTrigger = "manual"): Promise<MaintenanceResult> {
		if (this.active) {
			this.pendingTrigger = mergeTrigger(this.pendingTrigger, trigger);
			return this.active;
		}
		return this.execute(trigger);
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle()) return;
		await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.pendingTrigger = undefined;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.periodicTimer = false;
		if (this.active) {
			try { await this.active; } catch { /* already surfaced through onError */ }
		}
		this.resolveIdleWaiters();
	}

	private request(trigger: MaintenanceTrigger): void {
		this.pendingTrigger = mergeTrigger(this.pendingTrigger, trigger);
		if (this.active) return;
		if (this.timer) clearTimeout(this.timer);
		this.scheduleImmediate();
	}

	private scheduleImmediate(): void {
		this.periodicTimer = false;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.stopped) { this.resolveIdleWaiters(); return; }
			const trigger = this.pendingTrigger ?? "scheduled";
			this.pendingTrigger = undefined;
			void this.execute(trigger).catch(() => { /* surfaced through onError */ });
		}, 0);
	}

	private schedulePeriodic(): void {
		if (this.stopped) { this.resolveIdleWaiters(); return; }
		this.periodicTimer = true;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.periodicTimer = false;
			if (this.stopped) { this.resolveIdleWaiters(); return; }
			this.request("scheduled");
		}, this.intervalMs);
		this.timer.unref?.();
		this.resolveIdleWaiters();
	}

	private async execute(trigger: MaintenanceTrigger): Promise<MaintenanceResult> {
		const input: MaintainMemoryInput = {
			profileId: this.profileId,
			trigger,
			maxItems: this.maxItems,
			maxModelCalls: this.maxModelCalls,
			leaseMs: this.leaseMs,
			now: this.now(),
		};
		const cycle = this.admit(this.ownerKey, () => this.kernel.maintain(input));
		this.active = cycle;
		try {
			const result = await cycle;
			this.onCycle?.(result, trigger);
			return result;
		} catch (error) {
			this.onError?.(error);
			throw error;
		} finally {
			if (this.active === cycle) this.active = undefined;
			if (this.stopped) this.resolveIdleWaiters();
			else if (this.pendingTrigger) this.scheduleImmediate();
			else this.schedulePeriodic();
		}
	}

	private isIdle(): boolean {
		return !this.active && !this.pendingTrigger && (!this.timer || this.periodicTimer);
	}

	private resolveIdleWaiters(): void {
		if (!this.isIdle() && !this.stopped) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}
}

function mergeTrigger(current: MaintenanceTrigger | undefined, next: MaintenanceTrigger): MaintenanceTrigger {
	if (!current) return next;
	const priority: Record<MaintenanceTrigger, number> = { scheduled: 0, signal: 1, recovery: 2, manual: 3 };
	return priority[next] > priority[current] ? next : current;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	const normalized = value === undefined ? fallback : Math.trunc(value);
	if (!Number.isFinite(normalized)) return fallback;
	return Math.max(min, Math.min(normalized, max));
}

function requiredIdentifier(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 256) throw new Error(`${label} is invalid`);
	return normalized;
}

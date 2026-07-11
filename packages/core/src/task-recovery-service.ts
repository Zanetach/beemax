import type { TaskLedger, TaskRecoveryResult } from "./task-ledger.ts";
import type { TaskRecoveryRunner, TaskRecoveryRunnerOptions, TaskRecoveryRunnerResult } from "./task-recovery.ts";

export interface TaskRecoveryCycleResult {
	reconciled: TaskRecoveryResult;
	recovery: TaskRecoveryRunnerResult;
}

export interface TaskRecoveryServiceOptions {
	intervalMs?: number;
	runnerOptions?: Omit<TaskRecoveryRunnerOptions, "signal">;
	onCycle?: (result: TaskRecoveryCycleResult) => void;
	onError?: (error: unknown) => void;
}

type RecoveryLedger = Pick<TaskLedger, "reconcileExpiredTaskRuns">;
type RecoveryRunner = Pick<TaskRecoveryRunner, "run">;

/** Continuously reconciles expired Task Runs and resumes only safe durable work. */
export class TaskRecoveryService {
	private readonly ledger: RecoveryLedger;
	private readonly runner?: RecoveryRunner;
	private readonly intervalMs: number;
	private readonly runnerOptions: Omit<TaskRecoveryRunnerOptions, "signal">;
	private readonly onCycle?: (result: TaskRecoveryCycleResult) => void;
	private readonly onError?: (error: unknown) => void;
	private active?: Promise<TaskRecoveryCycleResult>;
	private controller?: AbortController;
	private timer?: ReturnType<typeof setTimeout>;

	constructor(ledger: RecoveryLedger, runner?: RecoveryRunner, options: TaskRecoveryServiceOptions = {}) {
		this.ledger = ledger;
		this.runner = runner;
		this.intervalMs = Math.max(10, Math.trunc(options.intervalMs ?? 30_000));
		this.runnerOptions = options.runnerOptions ?? {};
		this.onCycle = options.onCycle;
		this.onError = options.onError;
	}

	async runOnce(options: TaskRecoveryRunnerOptions = {}): Promise<TaskRecoveryCycleResult> {
		if (this.active) return this.active;
		const cycle = (async (): Promise<TaskRecoveryCycleResult> => {
			const reconciled = this.ledger.reconcileExpiredTaskRuns();
			const recovery = this.runner ? await this.runner.run(options) : { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] };
			return { reconciled, recovery };
		})();
		this.active = cycle;
		try { return await cycle; }
		finally { if (this.active === cycle) this.active = undefined; }
	}

	start(signal?: AbortSignal): void {
		if (this.controller) return;
		const controller = new AbortController();
		this.controller = controller;
		if (signal?.aborted) controller.abort(signal.reason);
		else signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
		if (!controller.signal.aborted) this.schedule(0, controller);
	}

	async stop(reason: unknown = new Error("Task recovery service stopped")): Promise<void> {
		const controller = this.controller;
		this.controller = undefined;
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		controller?.abort(reason);
		try { await this.active; } catch { /* surfaced through onError */ }
	}

	private schedule(delay: number, controller: AbortController): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.tick(controller);
		}, delay);
		this.timer.unref?.();
	}

	private async tick(controller: AbortController): Promise<void> {
		try {
			const result = await this.runOnce({ ...this.runnerOptions, signal: controller.signal });
			this.onCycle?.(result);
		} catch (error) { this.onError?.(error); }
		finally {
			if (this.controller === controller && !controller.signal.aborted) this.schedule(this.intervalMs, controller);
		}
	}
}

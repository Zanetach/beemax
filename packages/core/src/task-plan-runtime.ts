import type { TaskLedger } from "./task-ledger.ts";

const EXECUTION_CLAIM_MS = 61 * 60_000;
const EXECUTION_CLAIM_HEARTBEAT_MS = 30_000;

/** Profile-wide registry for the live AbortController of each Task Plan. */
export class TaskPlanRuntime {
	private readonly active = new Map<string, AbortController>();
	private readonly background = new Map<string, Promise<void>>();
	private readonly onBackgroundError: (event: { ownerKey: string; planId: string; error: unknown }) => void;
	constructor(onBackgroundError: (event: { ownerKey: string; planId: string; error: unknown }) => void = () => undefined) { this.onBackgroundError = onBackgroundError; }

	/** Start supervised durable work and return immediately; completion is observed through the ledger/notices. */
	start(ownerKey: string, planId: string, execute: (signal: AbortSignal) => Promise<unknown>, onSettled?: (error?: unknown) => void): boolean {
		const key = taskPlanKey(ownerKey, planId);
		if (this.active.has(key)) return false;
		const controller = new AbortController();
		this.active.set(key, controller);
		const work = Promise.resolve().then(() => execute(controller.signal))
			.then(() => onSettled?.(), (error) => { this.onBackgroundError({ ownerKey, planId, error }); return onSettled?.(error); })
			.catch((error) => { this.onBackgroundError({ ownerKey, planId, error }); })
			.finally(() => { if (this.active.get(key) === controller) this.active.delete(key); this.background.delete(key); });
		this.background.set(key, work);
		return true;
	}

	/** Start work under the durable cross-process execution claim used by recovery. */
	startClaimed(ledger: TaskLedger, ownerKey: string, planId: string, execute: (signal: AbortSignal) => Promise<unknown>, onSettled?: (error?: unknown) => void): boolean {
		const holderId = crypto.randomUUID();
		const claimed = ledger.claimTaskPlanExecution?.(ownerKey, planId, holderId, Date.now() + EXECUTION_CLAIM_MS) ?? true;
		if (!claimed) return false;
		const started = this.start(ownerKey, planId, async (signal) => {
			const leaseLost = new AbortController();
			const executionSignal = AbortSignal.any([signal, leaseLost.signal]);
			const heartbeat = ledger.renewTaskPlanExecution ? setInterval(() => {
				try { if (!ledger.renewTaskPlanExecution?.(ownerKey, planId, holderId, Date.now() + EXECUTION_CLAIM_MS)) leaseLost.abort(new Error(`Task Plan Execution Claim lost: ${planId}`)); }
				catch (error) { leaseLost.abort(error); }
			}, EXECUTION_CLAIM_HEARTBEAT_MS) : undefined;
			heartbeat?.unref();
			try { await execute(executionSignal); }
			catch (error) {
				ledger.failTaskPlan?.([ownerKey], planId, holderId, error instanceof Error ? error.message : String(error));
				throw error;
			}
			finally { if (heartbeat) clearInterval(heartbeat); ledger.releaseTaskPlanExecution?.(ownerKey, planId, holderId); }
		}, onSettled);
		if (!started) ledger.releaseTaskPlanExecution?.(ownerKey, planId, holderId);
		return started;
	}

	async run<T>(ownerKey: string, planId: string, parentSignal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const key = taskPlanKey(ownerKey, planId);
		if (this.active.has(key)) throw new Error(`Task Plan is already running: ${planId}`);
		const controller = new AbortController();
		const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
		this.active.set(key, controller);
		try { return await execute(signal); }
		finally { this.active.delete(key); }
	}

	cancel(ownerKeys: string[], planId: string): number {
		let cancelled = 0;
		for (const ownerKey of ownerKeys) {
			const controller = this.active.get(taskPlanKey(ownerKey, planId));
			if (!controller || controller.signal.aborted) continue;
			controller.abort(new Error(`Task Plan cancelled: ${planId}`));
			cancelled++;
		}
		return cancelled;
	}

	activePlanIds(ownerKeys: string[]): string[] {
		const ids: string[] = [];
		for (const ownerKey of ownerKeys) for (const key of this.active.keys()) {
			const prefix = `${ownerKey}\0`;
			if (key.startsWith(prefix)) ids.push(key.slice(prefix.length));
		}
		return [...new Set(ids)];
	}

	snapshot(): { active: number } { return { active: this.active.size }; }

	async shutdown(reason: unknown = new Error("Task Plan Runtime shutting down")): Promise<void> {
		for (const controller of this.active.values()) if (!controller.signal.aborted) controller.abort(reason);
		await Promise.allSettled([...this.background.values()]);
	}
}

function taskPlanKey(ownerKey: string, planId: string): string {
	if (!ownerKey.trim() || !planId.trim()) throw new Error("Task Plan owner and id are required");
	return `${ownerKey}\0${planId}`;
}

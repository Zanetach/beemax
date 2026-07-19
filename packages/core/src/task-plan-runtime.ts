import type { TaskLedger } from "./task-ledger.ts";

const EXECUTION_CLAIM_MS = 61 * 60_000;
const EXECUTION_CLAIM_HEARTBEAT_MS = 30_000;

/** Profile-wide registry for the live AbortController of each Task Plan. */
export class TaskPlanRuntime {
	private readonly active = new Map<string, AbortController>();
	private readonly background = new Map<string, Promise<void>>();
	private readonly inFlight = new Set<Promise<unknown>>();
	private shuttingDown = false;
	private readonly onBackgroundError: (event: { ownerKey: string; planId: string; error: unknown }) => void;
	constructor(onBackgroundError: (event: { ownerKey: string; planId: string; error: unknown }) => void = () => undefined) { this.onBackgroundError = onBackgroundError; }

	/** Start supervised durable work and return immediately; completion is observed through the ledger/notices. */
	start(ownerKey: string, planId: string, execute: (signal: AbortSignal) => Promise<unknown>, onSettled?: (error?: unknown) => void): boolean {
		if (this.shuttingDown) return false;
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
		if (this.shuttingDown) return false;
		const holderId = crypto.randomUUID();
		const claimed = ledger.claimTaskPlanExecution?.(ownerKey, planId, holderId, Date.now() + EXECUTION_CLAIM_MS) ?? true;
		if (!claimed) return false;
		const started = this.start(ownerKey, planId, async (signal) => {
			try { return await this.executeClaimed(ledger, ownerKey, planId, holderId, signal, execute, "terminalize"); }
			finally { ledger.releaseTaskPlanExecution?.(ownerKey, planId, holderId); }
		}, onSettled);
		if (!started) ledger.releaseTaskPlanExecution?.(ownerKey, planId, holderId);
		return started;
	}

	/** Run foreground work with the same durable claim and heartbeat contract as background plans. */
	async runClaimed<T>(ledger: TaskLedger, ownerKey: string, planId: string, parentSignal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		if (this.shuttingDown) throw new Error("Task Plan Runtime is shutting down");
		const holderId = crypto.randomUUID();
		const claimed = ledger.claimTaskPlanExecution?.(ownerKey, planId, holderId, Date.now() + EXECUTION_CLAIM_MS) ?? true;
		if (!claimed) return undefined;
		try { return await this.run(ownerKey, planId, parentSignal, (signal) => this.executeClaimed(ledger, ownerKey, planId, holderId, signal, execute, "propagate")); }
		finally { ledger.releaseTaskPlanExecution?.(ownerKey, planId, holderId); }
	}

	/** Run Direct Objective Verification under its own durable cross-process responsibility claim. */
	async runClaimedTaskVerification<T>(ledger: TaskLedger, ownerKey: string, taskId: string, parentSignal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		if (this.shuttingDown) throw new Error("Task Plan Runtime is shutting down");
		const holderId = crypto.randomUUID();
		const claimed = ledger.claimTaskVerification?.(ownerKey, taskId, holderId, Date.now() + EXECUTION_CLAIM_MS) ?? true;
		if (!claimed) return undefined;
		try {
			return await this.runResponsibility(taskVerificationKey(ownerKey, taskId), `Task Verification is already running: ${taskId}`, parentSignal, async (signal) => {
				const leaseLost = new AbortController();
				const executionSignal = AbortSignal.any([signal, leaseLost.signal]);
				const heartbeat = ledger.renewTaskVerification ? setInterval(() => {
					try { if (!ledger.renewTaskVerification?.(ownerKey, taskId, holderId, Date.now() + EXECUTION_CLAIM_MS)) leaseLost.abort(new Error(`Task Verification Claim lost: ${taskId}`)); }
					catch (error) { leaseLost.abort(error); }
				}, EXECUTION_CLAIM_HEARTBEAT_MS) : undefined;
				heartbeat?.unref();
				try { return await execute(executionSignal); }
				finally { if (heartbeat) clearInterval(heartbeat); }
			});
		} finally { ledger.releaseTaskVerification?.(ownerKey, taskId, holderId); }
	}

	run<T>(ownerKey: string, planId: string, parentSignal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return this.runResponsibility(taskPlanKey(ownerKey, planId), `Task Plan is already running: ${planId}`, parentSignal, execute);
	}

	private runResponsibility<T>(key: string, duplicateError: string, parentSignal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.shuttingDown) return Promise.reject(new Error("Task Plan Runtime is shutting down"));
		if (this.active.has(key)) return Promise.reject(new Error(duplicateError));
		const controller = new AbortController();
		const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
		this.active.set(key, controller);
		const work = (async () => {
			try { return await execute(signal); }
			finally { if (this.active.get(key) === controller) this.active.delete(key); }
		})();
		this.inFlight.add(work);
		void work.then(() => { this.inFlight.delete(work); }, () => { this.inFlight.delete(work); });
		return work;
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
			const prefix = `${ownerKey}\0plan\0`;
			if (key.startsWith(prefix)) ids.push(key.slice(prefix.length));
		}
		return [...new Set(ids)];
	}

	snapshot(): { active: number } { return { active: this.active.size }; }

	async shutdown(reason: unknown = new Error("Task Plan Runtime shutting down"), graceMs = 30_000): Promise<void> {
		this.shuttingDown = true;
		for (const controller of this.active.values()) if (!controller.signal.aborted) controller.abort(reason);
		await settleWithin([...this.background.values(), ...this.inFlight], graceMs);
	}

	private async executeClaimed<T>(ledger: TaskLedger, ownerKey: string, planId: string, holderId: string, signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>, failureMode: "terminalize" | "propagate"): Promise<T> {
		const leaseLost = new AbortController();
		const executionSignal = AbortSignal.any([signal, leaseLost.signal]);
		const heartbeat = ledger.renewTaskPlanExecution ? setInterval(() => {
			try { if (!ledger.renewTaskPlanExecution?.(ownerKey, planId, holderId, Date.now() + EXECUTION_CLAIM_MS)) leaseLost.abort(new Error(`Task Plan Execution Claim lost: ${planId}`)); }
			catch (error) { leaseLost.abort(error); }
		}, EXECUTION_CLAIM_HEARTBEAT_MS) : undefined;
		heartbeat?.unref();
		try { return await execute(executionSignal); }
		catch (error) {
			if (failureMode === "terminalize") ledger.failTaskPlan?.([ownerKey], planId, holderId, error instanceof Error ? error.message : String(error));
			throw error;
		} finally { if (heartbeat) clearInterval(heartbeat); }
	}
}

async function settleWithin(work: Promise<unknown>[], graceMs: number): Promise<void> {
	if (!work.length) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([Promise.allSettled(work), new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, graceMs)); })]);
	if (timer) clearTimeout(timer);
}

function taskPlanKey(ownerKey: string, planId: string): string {
	if (!ownerKey.trim() || !planId.trim()) throw new Error("Task Plan owner and id are required");
	return `${ownerKey}\0plan\0${planId}`;
}

function taskVerificationKey(ownerKey: string, taskId: string): string {
	if (!ownerKey.trim() || !taskId.trim()) throw new Error("Task Verification owner and id are required");
	return `${ownerKey}\0verification\0${taskId}`;
}

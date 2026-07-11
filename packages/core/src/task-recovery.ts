import { TaskGraph, type TaskGraphExecutor } from "./task-graph.ts";
import type { TaskLedger, TaskRecord } from "./task-ledger.ts";

export interface TaskRecoveryRunnerOptions { maxConcurrent?: number; signal?: AbortSignal; }
export interface TaskRecoveryRunnerResult { plans: number; succeeded: number; failed: number; cancelled: number; blocked: string[]; }

/** Resumes only durable DAG work that already passed the fail-closed recovery policy. */
export class TaskRecoveryRunner {
	private readonly ledger: TaskLedger;
	private readonly execute: TaskGraphExecutor;
	constructor(ledger: TaskLedger, execute: TaskGraphExecutor) { this.ledger = ledger; this.execute = execute; }

	async run(options: TaskRecoveryRunnerOptions = {}): Promise<TaskRecoveryRunnerResult> {
		const candidates = this.ledger.recoveryCandidates(100);
		const plans = new Map<string, { ownerKey: string; planId: string }>();
		for (const task of candidates) if (task.planId) plans.set(`${task.ownerKey}\0${task.planId}`, { ownerKey: task.ownerKey, planId: task.planId });
		const results = await Promise.all([...plans.values()].map(({ ownerKey, planId }) => new TaskGraph(this.ledger).run([ownerKey], planId, this.execute, {
			maxConcurrent: options.maxConcurrent, signal: options.signal, executor: "subagent", canExecute: recoverable,
		})));
		return results.reduce<TaskRecoveryRunnerResult>((summary, result) => ({
			plans: summary.plans + 1,
			succeeded: summary.succeeded + result.succeeded,
			failed: summary.failed + result.failed,
			cancelled: summary.cancelled + result.cancelled,
			blocked: [...summary.blocked, ...result.blocked],
		}), { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] } satisfies TaskRecoveryRunnerResult);
	}
}

function recoverable(task: TaskRecord): boolean {
	return task.status === "pending" && task.recoveryPolicy === "safe_retry" && Boolean(task.idempotencyKey && task.planId && task.executionScope);
}

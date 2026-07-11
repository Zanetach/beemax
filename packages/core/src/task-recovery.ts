import { TaskGraph, type TaskGraphExecutor } from "./task-graph.ts";
import type { TaskLedger, TaskRecord } from "./task-ledger.ts";
import { TaskPlanRuntime } from "./task-plan-runtime.ts";

export interface TaskRecoveryRunnerOptions { maxConcurrent?: number; signal?: AbortSignal; }
export interface TaskRecoveryRunnerResult { plans: number; succeeded: number; failed: number; cancelled: number; blocked: string[]; }
export interface TaskPlanRetryResult extends TaskRecoveryRunnerResult { prepared: number; }
export interface TaskPlanCancelResult { active: number; tasks: number; }

/** Resumes only durable DAG work that already passed the fail-closed recovery policy. */
export class TaskRecoveryRunner {
	private readonly ledger: TaskLedger;
	private readonly execute: TaskGraphExecutor;
	private readonly runtime: TaskPlanRuntime;
	constructor(ledger: TaskLedger, execute: TaskGraphExecutor, runtime = new TaskPlanRuntime()) { this.ledger = ledger; this.execute = execute; this.runtime = runtime; }

	async run(options: TaskRecoveryRunnerOptions = {}): Promise<TaskRecoveryRunnerResult> {
		const candidates = this.ledger.recoveryCandidates(100);
		return this.executePlans(candidates, options);
	}

	async retry(ownerKeys: string[], planId: string, options: TaskRecoveryRunnerOptions = {}): Promise<TaskPlanRetryResult> {
		const prepared = this.ledger.prepareTaskPlanRetry(ownerKeys, planId);
		if (!prepared) return { prepared: 0, plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] };
		const candidates = this.ledger.queryTasks({ ownerKeys, planIds: [planId], statuses: ["pending"], limit: 100 }).filter(recoverable);
		return { prepared, ...await this.executePlans(candidates, options) };
	}

	cancel(ownerKeys: string[], planId: string): TaskPlanCancelResult {
		const active = this.runtime.cancel(ownerKeys, planId);
		const tasks = this.ledger.cancelTaskPlan(ownerKeys, planId);
		return { active, tasks };
	}

	private async executePlans(candidates: TaskRecord[], options: TaskRecoveryRunnerOptions): Promise<TaskRecoveryRunnerResult> {
		const plans = new Map<string, { ownerKey: string; planId: string }>();
		for (const task of candidates) if (task.planId) plans.set(`${task.ownerKey}\0${task.planId}`, { ownerKey: task.ownerKey, planId: task.planId });
		const results = await Promise.all([...plans.values()].map(({ ownerKey, planId }) => this.runtime.run(ownerKey, planId, options.signal, (signal) => new TaskGraph(this.ledger).run([ownerKey], planId, this.execute, {
			maxConcurrent: options.maxConcurrent, signal, executor: "subagent", canExecute: recoverable,
		}))));
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

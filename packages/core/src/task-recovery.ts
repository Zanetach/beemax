import { TaskGraph, type TaskGraphExecutor, type TaskGraphResult, type TaskGraphVerifier } from "./task-graph.ts";
import type { TaskLedger, TaskRecord } from "./task-ledger.ts";
import { TaskPlanRuntime } from "./task-plan-runtime.ts";

export interface TaskRecoveryRunnerOptions { maxConcurrent?: number; maxCorrectiveAttempts?: number; signal?: AbortSignal; }
export interface TaskRecoveryRunnerResult { plans: number; succeeded: number; failed: number; cancelled: number; blocked: string[]; }
export interface TaskPlanRetryResult extends TaskRecoveryRunnerResult { prepared: number; }
export interface TaskPlanCancelResult { active: number; tasks: number; }
const PLAN_EXECUTION_LEASE_MS = 61 * 60_000;
const PLAN_EXECUTION_HEARTBEAT_MS = 30_000;

/** Resumes only durable DAG work that already passed the fail-closed recovery policy. */
export class TaskRecoveryRunner {
	private readonly ledger: TaskLedger;
	private readonly execute: TaskGraphExecutor;
	private readonly runtime: TaskPlanRuntime;
	private readonly verify?: TaskGraphVerifier;
	constructor(ledger: TaskLedger, execute: TaskGraphExecutor, runtime = new TaskPlanRuntime(), verify?: TaskGraphVerifier) { this.ledger = ledger; this.execute = execute; this.runtime = runtime; this.verify = verify; }

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
		const results = (await Promise.all([...plans.values()].map((plan) => this.executeClaimedPlan(plan.ownerKey, plan.planId, options)))).filter((result) => result !== undefined);
		return results.reduce<TaskRecoveryRunnerResult>((summary, result) => ({
			plans: summary.plans + 1,
			succeeded: summary.succeeded + result.succeeded,
			failed: summary.failed + result.failed,
			cancelled: summary.cancelled + result.cancelled,
			blocked: [...summary.blocked, ...result.blocked],
		}), { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] } satisfies TaskRecoveryRunnerResult);
	}

	private async executeClaimedPlan(ownerKey: string, planId: string, options: TaskRecoveryRunnerOptions): Promise<TaskGraphResult | undefined> {
		const holderId = crypto.randomUUID();
		const claimed = this.ledger.claimTaskPlanExecution?.(ownerKey, planId, holderId, Date.now() + PLAN_EXECUTION_LEASE_MS) ?? true;
		if (!claimed) return undefined;
		try {
			return await this.runtime.run(ownerKey, planId, options.signal, async (signal) => {
				const leaseLost = new AbortController();
				const executionSignal = AbortSignal.any([signal, leaseLost.signal]);
				const heartbeat = this.ledger.renewTaskPlanExecution ? setInterval(() => {
					try {
						if (!this.ledger.renewTaskPlanExecution?.(ownerKey, planId, holderId, Date.now() + PLAN_EXECUTION_LEASE_MS)) leaseLost.abort(new Error(`Task Plan Execution Claim lost: ${planId}`));
					} catch (error) { leaseLost.abort(error); }
				}, PLAN_EXECUTION_HEARTBEAT_MS) : undefined;
				heartbeat?.unref();
				try {
					return await new TaskGraph(this.ledger).run([ownerKey], planId, this.execute, {
						maxConcurrent: options.maxConcurrent, maxCorrectiveAttempts: options.maxCorrectiveAttempts ?? 1, signal: executionSignal, executor: "subagent", canExecute: recoverable, verify: this.verify,
					});
				} finally { if (heartbeat) clearInterval(heartbeat); }
			});
		} finally { this.ledger.releaseTaskPlanExecution?.(ownerKey, planId, holderId); }
	}
}

function recoverable(task: TaskRecord): boolean {
	return task.status === "pending" && task.recoveryPolicy === "safe_retry" && Boolean(task.idempotencyKey && task.planId && task.executionScope);
}

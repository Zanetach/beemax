import { TaskGraph, type TaskGraphExecutor, type TaskGraphResult, type TaskGraphVerifier } from "./task-graph.ts";
import type { TaskLedger, TaskRecord } from "./task-ledger.ts";
import { TaskPlanRuntime } from "./task-plan-runtime.ts";

export interface TaskRecoveryRunnerOptions { maxConcurrent?: number; maxCorrectiveAttempts?: number; signal?: AbortSignal; }
export interface TaskRecoveryRunnerResult { plans: number; succeeded: number; failed: number; cancelled: number; blocked: string[]; }
export interface TaskPlanRetryResult extends TaskRecoveryRunnerResult { prepared: number; verification: TaskVerificationRetryResult; }
export interface TaskPlanCancelResult { active: number; tasks: number; }
export interface TaskVerificationRetryResult { attempted: number; accepted: number; rejected: number; unavailable: number; }
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
		this.ledger.prepareTaskCorrections?.(boundedCorrectiveAttempts(options.maxCorrectiveAttempts));
		const attemptedPlanIds = new Set<string>();
		let summary: TaskRecoveryRunnerResult = { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] };
		while (!options.signal?.aborted) {
			const candidates = this.ledger.recoveryCandidates(100, [...attemptedPlanIds]).filter((task) => task.planId && !attemptedPlanIds.has(task.planId));
			if (!candidates.length) break;
			for (const task of candidates) if (task.planId) attemptedPlanIds.add(task.planId);
			const batch = await this.executePlans(candidates, options, true);
			summary = mergeRecoveryResults(summary, batch);
		}
		return summary;
	}

	async retry(ownerKeys: string[], planId: string, options: TaskRecoveryRunnerOptions = {}): Promise<TaskPlanRetryResult> {
		const verification = await this.reverify(ownerKeys, planId, options.signal);
		const prepared = this.ledger.prepareTaskPlanRetry(ownerKeys, planId, boundedCorrectiveAttempts(options.maxCorrectiveAttempts));
		if (!prepared) return { verification, prepared: 0, plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] };
		const candidates = this.ledger.queryTasks({ ownerKeys, planIds: [planId], statuses: ["pending"], limit: 100 }).filter(recoverable);
		return { verification, prepared, ...await this.executePlans(candidates, options) };
	}

	async reverify(ownerKeys: string[], planId: string, signal?: AbortSignal): Promise<TaskVerificationRetryResult> {
		const candidates = this.ledger.queryTasks({ ownerKeys, planIds: [planId], statuses: ["failed"], limit: 100 })
			.filter((task) => task.verificationStatus === "unavailable" && Boolean(task.acceptanceCriteria && task.candidateResult));
		if (!candidates.length) return emptyVerificationResult();
		const ownerKey = candidates[0]!.ownerKey;
		return await this.withPlanExecutionClaim(ownerKey, planId, signal, (claimSignal) => this.verifyCandidates(ownerKeys, candidates, claimSignal)) ?? emptyVerificationResult();
	}

	async reverifyDue(now = Date.now(), signal?: AbortSignal, maxConcurrent = 3): Promise<TaskVerificationRetryResult> {
		let summary = emptyVerificationResult();
		const attemptedPlanIds = new Set<string>();
		const concurrency = Math.max(1, Math.min(Math.trunc(maxConcurrent), 20));
		while (!signal?.aborted) {
			const candidates = (this.ledger.verificationCandidates?.(now, 100, [...attemptedPlanIds]) ?? [])
				.filter((task) => task.planId && !attemptedPlanIds.has(task.planId));
			if (!candidates.length) break;
			const plans = new Map<string, { ownerKey: string; planId: string; tasks: TaskRecord[] }>();
			for (const task of candidates) {
				if (!task.planId) continue;
				attemptedPlanIds.add(task.planId);
				const key = `${task.ownerKey}\0${task.planId}`;
				const plan = plans.get(key) ?? { ownerKey: task.ownerKey, planId: task.planId, tasks: [] };
				plan.tasks.push(task); plans.set(key, plan);
			}
			if (!plans.size) break;
			const pendingPlans = [...plans.values()];
			for (let offset = 0; offset < pendingPlans.length && !signal?.aborted; offset += concurrency) {
				const results = await Promise.all(pendingPlans.slice(offset, offset + concurrency).map(async (plan) => ({ plan, result: await this.withPlanExecutionClaim(plan.ownerKey, plan.planId, signal, (claimSignal) => this.verifyCandidates([plan.ownerKey], plan.tasks, claimSignal, now)) })));
				for (const { plan, result } of results) if (result) {
					summary = mergeVerificationResults(summary, result);
					if (result.accepted || result.rejected) this.enqueueCompletionNoticeIfSettled(plan.ownerKey, plan.planId);
				}
			}
		}
		return summary;
	}

	cancel(ownerKeys: string[], planId: string): TaskPlanCancelResult {
		const active = this.runtime.cancel(ownerKeys, planId);
		const tasks = this.ledger.cancelTaskPlan(ownerKeys, planId);
		return { active, tasks };
	}

	private async executePlans(candidates: TaskRecord[], options: TaskRecoveryRunnerOptions, enqueueCompletionNotice = false): Promise<TaskRecoveryRunnerResult> {
		const plans = new Map<string, { ownerKey: string; planId: string }>();
		for (const task of candidates) if (task.planId) plans.set(`${task.ownerKey}\0${task.planId}`, { ownerKey: task.ownerKey, planId: task.planId });
		const results = (await Promise.all([...plans.values()].map((plan) => this.executeClaimedPlan(plan.ownerKey, plan.planId, options, enqueueCompletionNotice)))).filter((result) => result !== undefined);
		return results.reduce<TaskRecoveryRunnerResult>((summary, result) => ({
			plans: summary.plans + 1,
			succeeded: summary.succeeded + result.succeeded,
			failed: summary.failed + result.failed,
			cancelled: summary.cancelled + result.cancelled,
			blocked: [...summary.blocked, ...result.blocked],
		}), { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] } satisfies TaskRecoveryRunnerResult);
	}

	private async verifyCandidates(ownerKeys: string[], candidates: TaskRecord[], signal: AbortSignal, attemptedAt?: number): Promise<TaskVerificationRetryResult> {
		const summary = emptyVerificationResult();
		for (const task of candidates) {
			if (signal.aborted) break;
			summary.attempted++;
			if (!this.verify || !this.ledger.resolveCandidateVerification) {
				summary.unavailable++; this.ledger.deferCandidateVerification?.(ownerKeys, task.id, attemptedAt); continue;
			}
			try {
				const verification = await this.verify(task, { output: task.candidateResult }, signal);
				if (signal.aborted) break;
				const resolution = verification.accepted
					? { accepted: true as const, evidence: verification.evidence?.slice(0, 5_000) }
					: { accepted: false as const, feedback: verification.feedback?.trim().slice(0, 5_000) || "Acceptance Criteria were not satisfied" };
				if (!this.ledger.resolveCandidateVerification(ownerKeys, task.id, resolution)) {
					summary.unavailable++; this.ledger.deferCandidateVerification?.(ownerKeys, task.id, attemptedAt); continue;
				}
				if (resolution.accepted) summary.accepted++; else summary.rejected++;
			} catch {
				summary.unavailable++;
				this.ledger.deferCandidateVerification?.(ownerKeys, task.id, attemptedAt);
			}
		}
		return summary;
	}

	private async executeClaimedPlan(ownerKey: string, planId: string, options: TaskRecoveryRunnerOptions, enqueueCompletionNotice: boolean): Promise<TaskGraphResult | undefined> {
		const result = await this.withPlanExecutionClaim(ownerKey, planId, options.signal, (signal) => new TaskGraph(this.ledger).run([ownerKey], planId, this.execute, {
			maxConcurrent: options.maxConcurrent, maxCorrectiveAttempts: options.maxCorrectiveAttempts ?? 1, signal, executor: "subagent", canExecute: recoverable, verify: this.verify,
		}));
		if (result && enqueueCompletionNotice) this.enqueueCompletionNoticeIfSettled(ownerKey, planId);
		return result;
	}

	private enqueueCompletionNoticeIfSettled(ownerKey: string, planId: string): void {
		const plan = this.ledger.queryTaskPlans({ ownerKeys: [ownerKey], id: planId, limit: 1 })[0];
		if (!plan || (plan.status !== "succeeded" && plan.status !== "failed" && plan.status !== "cancelled")) return;
		const unsettled = this.ledger.queryTasks({ ownerKeys: [ownerKey], planIds: [planId], statuses: ["failed"], limit: 100 }).some((task) => task.verificationStatus === "unavailable");
		if (!unsettled) this.ledger.enqueueTaskPlanCompletionNotice?.(ownerKey, planId);
	}

	private async withPlanExecutionClaim<T>(ownerKey: string, planId: string, parentSignal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		const holderId = crypto.randomUUID();
		const claimed = this.ledger.claimTaskPlanExecution?.(ownerKey, planId, holderId, Date.now() + PLAN_EXECUTION_LEASE_MS) ?? true;
		if (!claimed) return undefined;
		try {
			return await this.runtime.run(ownerKey, planId, parentSignal, async (signal) => {
				const leaseLost = new AbortController();
				const executionSignal = AbortSignal.any([signal, leaseLost.signal]);
				const heartbeat = this.ledger.renewTaskPlanExecution ? setInterval(() => {
					try {
						if (!this.ledger.renewTaskPlanExecution?.(ownerKey, planId, holderId, Date.now() + PLAN_EXECUTION_LEASE_MS)) leaseLost.abort(new Error(`Task Plan Execution Claim lost: ${planId}`));
					} catch (error) { leaseLost.abort(error); }
				}, PLAN_EXECUTION_HEARTBEAT_MS) : undefined;
				heartbeat?.unref();
				try { return await execute(executionSignal); }
				finally { if (heartbeat) clearInterval(heartbeat); }
			});
		} finally { this.ledger.releaseTaskPlanExecution?.(ownerKey, planId, holderId); }
	}
}

function recoverable(task: TaskRecord): boolean {
	return task.status === "pending" && task.recoveryPolicy === "safe_retry" && Boolean(task.idempotencyKey && task.planId && task.executionScope);
}

function boundedCorrectiveAttempts(value?: number): number { return Math.max(0, Math.min(Math.trunc(value ?? 1), 2)); }

function mergeRecoveryResults(left: TaskRecoveryRunnerResult, right: TaskRecoveryRunnerResult): TaskRecoveryRunnerResult {
	return {
		plans: left.plans + right.plans,
		succeeded: left.succeeded + right.succeeded,
		failed: left.failed + right.failed,
		cancelled: left.cancelled + right.cancelled,
		blocked: [...left.blocked, ...right.blocked],
	};
}

function emptyVerificationResult(): TaskVerificationRetryResult { return { attempted: 0, accepted: 0, rejected: 0, unavailable: 0 }; }

function mergeVerificationResults(left: TaskVerificationRetryResult, right: TaskVerificationRetryResult): TaskVerificationRetryResult {
	return { attempted: left.attempted + right.attempted, accepted: left.accepted + right.accepted, rejected: left.rejected + right.rejected, unavailable: left.unavailable + right.unavailable };
}

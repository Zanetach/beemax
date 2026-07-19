import { TaskGraph, type TaskGraphExecutor, type TaskGraphResult, type TaskGraphVerifier } from "./task-graph.ts";
import type { TaskLedger, TaskRecord, TaskRecoveryPlanRef } from "./task-ledger.ts";
import { TaskPlanRuntime } from "./task-plan-runtime.ts";
import type { ExecutionTraceSink } from "./execution-trace.ts";

export interface TaskRecoveryRunnerOptions { maxConcurrent?: number; maxCorrectiveAttempts?: number; signal?: AbortSignal; }
export interface TaskRecoveryRunnerResult { plans: number; succeeded: number; failed: number; cancelled: number; blocked: string[]; }
export interface TaskPlanRetryResult extends TaskRecoveryRunnerResult { prepared: number; verification: TaskVerificationRetryResult; }
export interface TaskPlanCancelResult { active: number; tasks: number; }
export interface TaskPlanPauseResult { paused: boolean; }
export interface TaskVerificationRetryResult { attempted: number; accepted: number; rejected: number; unavailable: number; }
export type DirectObjectiveVerificationResolution = { accepted: true; evidence?: string } | { accepted: false; feedback: string };
export type DirectObjectiveVerificationNotifier = (task: TaskRecord, resolution: DirectObjectiveVerificationResolution, signal: AbortSignal) => Promise<void>;

/** Resumes only durable DAG work that already passed the fail-closed recovery policy. */
export class TaskRecoveryRunner {
	private readonly ledger: TaskLedger;
	private readonly execute: TaskGraphExecutor;
	private readonly runtime: TaskPlanRuntime;
	private readonly verify?: TaskGraphVerifier;
	private readonly executionTrace?: ExecutionTraceSink;
	private readonly notifyDirectObjective?: DirectObjectiveVerificationNotifier;
	constructor(ledger: TaskLedger, execute: TaskGraphExecutor, runtime = new TaskPlanRuntime(), verify?: TaskGraphVerifier, executionTrace?: ExecutionTraceSink, notifyDirectObjective?: DirectObjectiveVerificationNotifier) { this.ledger = ledger; this.execute = execute; this.runtime = runtime; this.verify = verify; this.executionTrace = executionTrace; this.notifyDirectObjective = notifyDirectObjective; }

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
		const candidates = this.ledger.queryTasks({ ownerKeys, planIds: [planId], statuses: ["running", "failed"], limit: 100 })
			.filter((task) => task.verificationStatus === "unavailable" && Boolean(task.acceptanceCriteria && task.candidateResult));
		if (!candidates.length) return emptyVerificationResult();
		const ownerKey = candidates[0]!.ownerKey;
		return await this.runtime.runClaimed(this.ledger, ownerKey, planId, signal, (claimSignal) => this.verifyCandidates(ownerKeys, candidates, claimSignal)) ?? emptyVerificationResult();
	}

	async reverifyDue(now = Date.now(), signal?: AbortSignal, maxConcurrent = 3): Promise<TaskVerificationRetryResult> {
		let summary = emptyVerificationResult();
		const attemptedPlanIds = new Set<string>();
		const attemptedDirectTaskIds = new Set<string>();
		const concurrency = Math.max(1, Math.min(Math.trunc(maxConcurrent), 20));
		while (!signal?.aborted) {
			const candidates = (this.ledger.verificationCandidates?.(now, 100, [...attemptedPlanIds]) ?? [])
				.filter((task) => task.planId ? !attemptedPlanIds.has(task.planId) : !attemptedDirectTaskIds.has(task.id));
			if (!candidates.length) break;
			const direct = candidates.filter((task) => !task.planId);
			for (const task of direct) attemptedDirectTaskIds.add(task.id);
			for (let offset = 0; offset < direct.length && !signal?.aborted; offset += concurrency) {
				const results = await Promise.all(direct.slice(offset, offset + concurrency).map((task) => this.runtime.runClaimedTaskVerification(this.ledger, task.ownerKey, task.id, signal, (claimSignal) => this.verifyCandidates([task.ownerKey], [task], claimSignal, now))));
				for (const result of results) if (result) summary = mergeVerificationResults(summary, result);
			}
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
				const results = await Promise.all(pendingPlans.slice(offset, offset + concurrency).map(async (plan) => ({ plan, result: await this.runtime.runClaimed(this.ledger, plan.ownerKey, plan.planId, signal, (claimSignal) => this.verifyCandidates([plan.ownerKey], plan.tasks, claimSignal, now)) })));
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

	pause(ownerKeys: string[], planId: string): TaskPlanPauseResult { return { paused: this.ledger.pauseTaskPlan(ownerKeys, planId) }; }

	async resume(ownerKeys: string[], planId: string, options: TaskRecoveryRunnerOptions = {}): Promise<TaskRecoveryRunnerResult> {
		if (!this.ledger.resumeTaskPlan(ownerKeys, planId)) return { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] };
		const candidates = this.ledger.queryTasks({ ownerKeys, planIds: [planId], statuses: ["pending"], limit: 100 }).filter(recoverable);
		return this.executePlans(candidates, options);
	}

	enqueueSettledCompletionNotices(plans: readonly TaskRecoveryPlanRef[]): number {
		let enqueued = 0;
		for (const plan of plans) if (this.enqueueCompletionNoticeIfSettled(plan.ownerKey, plan.planId)) enqueued++;
		return enqueued;
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
					? { accepted: true as const, evidence: verification.evidence?.slice(0, 5_000), ...(verification.criterionVerifications ? { criterionVerifications: verification.criterionVerifications } : {}) }
					: { accepted: false as const, feedback: verification.feedback?.trim().slice(0, 5_000) || "Acceptance Criteria were not satisfied", ...(verification.criterionVerifications ? { criterionVerifications: verification.criterionVerifications } : {}) };
				if (!this.ledger.resolveCandidateVerification(ownerKeys, task.id, resolution, attemptedAt ?? Date.now())) {
					summary.unavailable++; this.ledger.deferCandidateVerification?.(ownerKeys, task.id, attemptedAt); continue;
				}
				if (!task.planId && task.kind === "objective" && resolution.accepted && this.notifyDirectObjective) await this.notifyDirectObjective(task, resolution, signal);
				if (resolution.accepted) summary.accepted++; else summary.rejected++;
			} catch {
				summary.unavailable++;
				this.ledger.deferCandidateVerification?.(ownerKeys, task.id, attemptedAt);
			}
		}
		return summary;
	}

	private async executeClaimedPlan(ownerKey: string, planId: string, options: TaskRecoveryRunnerOptions, enqueueCompletionNotice: boolean): Promise<TaskGraphResult | undefined> {
		const result = await this.runtime.runClaimed(this.ledger, ownerKey, planId, options.signal, (signal) => new TaskGraph(this.ledger, this.executionTrace).run([ownerKey], planId, this.execute, {
			maxConcurrent: options.maxConcurrent, maxCorrectiveAttempts: options.maxCorrectiveAttempts ?? 1, signal, executor: "subagent", executionMode: "recovery", canExecute: recoverable, verify: this.verify,
		}));
		if (result && enqueueCompletionNotice) this.enqueueCompletionNoticeIfSettled(ownerKey, planId);
		return result;
	}

	private enqueueCompletionNoticeIfSettled(ownerKey: string, planId: string): boolean {
		const plan = this.ledger.queryTaskPlans({ ownerKeys: [ownerKey], id: planId, limit: 1 })[0];
		if (!plan || (plan.status !== "succeeded" && plan.status !== "failed" && plan.status !== "cancelled")) return false;
		const unsettled = this.ledger.queryTasks({ ownerKeys: [ownerKey], planIds: [planId], limit: 100 })
			.some((task) => task.status === "pending" || task.status === "running" || task.verificationStatus === "unavailable");
		return unsettled ? false : (this.ledger.enqueueTaskPlanCompletionNotice?.(ownerKey, planId) ?? false);
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

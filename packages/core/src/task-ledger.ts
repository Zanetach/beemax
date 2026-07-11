import type { AgentScope } from "./agent-scope.ts";

export type TaskKind = "objective" | "delegated" | "automation";
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type TaskRecoveryPolicy = "never" | "safe_retry";
export type TaskVerificationStatus = "pending" | "accepted" | "rejected" | "unavailable";
export type TaskCandidateVerificationResolution = { accepted: true; evidence?: string } | { accepted: false; feedback: string };
export type TaskPlanStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskPlanRecord {
	id: string;
	ownerKey: string;
	title: string;
	status: TaskPlanStatus;
	taskCount: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	verified: number;
	correctiveAttempts: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
}
export type TaskPlanTransition = Pick<TaskPlanRecord, "status" | "taskCount" | "succeeded" | "failed" | "cancelled" | "verified" | "correctiveAttempts"> & Partial<Pick<TaskPlanRecord, "startedAt" | "finishedAt">>;
export interface TaskPlanQuery { ownerKeys: string[]; id?: string; statuses?: TaskPlanStatus[]; limit?: number; }

/** Durable responsibility, independent of the worker or channel executing it. */
export interface TaskRecord {
	id: string;
	ownerKey: string;
	kind: TaskKind;
	title: string;
	description?: string;
	acceptanceCriteria?: string;
	recoveryPolicy?: TaskRecoveryPolicy;
	idempotencyKey?: string;
	executionScope?: AgentScope;
	status: TaskStatus;
	parentId?: string;
	planId?: string;
	evidence?: string;
	verificationStatus?: TaskVerificationStatus;
	verificationAttempts?: number;
	verificationRetryAt?: number;
	correctiveAttempts?: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	result?: string;
	candidateResult?: string;
	error?: string;
}

export type TaskTransition = Pick<TaskRecord, "status"> & Partial<Pick<TaskRecord, "startedAt" | "finishedAt" | "result" | "candidateResult" | "error" | "evidence" | "verificationStatus" | "correctiveAttempts">>;

export type TaskRunStatus = "running" | "succeeded" | "failed" | "cancelled";
export interface TaskRunRecord {
	id: string;
	taskId: string;
	executor: "agent" | "subagent" | "automation";
	status: TaskRunStatus;
	startedAt: number;
	leaseExpiresAt?: number;
	finishedAt?: number;
	output?: string;
	error?: string;
}
export type TaskRunTransition = Pick<TaskRunRecord, "status"> & Partial<Pick<TaskRunRecord, "finishedAt" | "output" | "error">>;
export interface TaskRecoveryResult { retried: number; failed: number; }
export interface TaskQuery {
	ownerKeys: string[];
	id?: string;
	kinds?: TaskKind[];
	statuses?: TaskStatus[];
	planIds?: string[];
	limit?: number;
}
export interface TaskDependency { taskId: string; dependsOn: string; }

/** Persistence port used by task producers; storage remains replaceable. */
export interface TaskLedger {
	record(task: TaskRecord): void;
	transition(id: string, change: TaskTransition): boolean;
	recordRun(run: TaskRunRecord): void;
	transitionRun(id: string, change: TaskRunTransition): boolean;
	queryTasks(query: TaskQuery): TaskRecord[];
	taskRuns(taskId: string): TaskRunRecord[];
	recordPlan(tasks: TaskRecord[], dependencies: TaskDependency[], plan?: TaskPlanRecord): void;
	transitionPlan(id: string, change: TaskPlanTransition): boolean;
	claimTaskPlanExecution?(ownerKey: string, planId: string, holderId: string, leaseExpiresAt: number, now?: number): boolean;
	renewTaskPlanExecution?(ownerKey: string, planId: string, holderId: string, leaseExpiresAt: number, now?: number): boolean;
	releaseTaskPlanExecution?(ownerKey: string, planId: string, holderId: string): boolean;
	queryTaskPlans(query: TaskPlanQuery): TaskPlanRecord[];
	taskDependencies(taskIds: string[]): TaskDependency[];
	reconcileExpiredTaskRuns(now?: number): TaskRecoveryResult;
	recoveryCandidates(limit?: number, excludePlanIds?: string[]): TaskRecord[];
	verificationCandidates?(now?: number, limit?: number): TaskRecord[];
	deferCandidateVerification?(ownerKeys: string[], taskId: string, now?: number): boolean;
	resolveCandidateVerification?(ownerKeys: string[], taskId: string, resolution: TaskCandidateVerificationResolution, now?: number): boolean;
	renewTaskRunLease?(id: string, leaseExpiresAt: number): boolean;
	prepareTaskPlanRetry(ownerKeys: string[], planId: string): number;
	cancelTaskPlan(ownerKeys: string[], planId: string, now?: number): number;
}

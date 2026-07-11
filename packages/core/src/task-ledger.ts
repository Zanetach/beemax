export type TaskKind = "objective" | "delegated" | "automation";
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type TaskRecoveryPolicy = "never" | "safe_retry";

/** Durable responsibility, independent of the worker or channel executing it. */
export interface TaskRecord {
	id: string;
	ownerKey: string;
	kind: TaskKind;
	title: string;
	description?: string;
	recoveryPolicy?: TaskRecoveryPolicy;
	idempotencyKey?: string;
	executionScope?: AgentScope;
	status: TaskStatus;
	parentId?: string;
	planId?: string;
	evidence?: string;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	result?: string;
	error?: string;
}

export type TaskTransition = Pick<TaskRecord, "status"> & Partial<Pick<TaskRecord, "startedAt" | "finishedAt" | "result" | "error">>;

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
	transition(id: string, change: TaskTransition): void;
	recordRun(run: TaskRunRecord): void;
	transitionRun(id: string, change: TaskRunTransition): void;
	queryTasks(query: TaskQuery): TaskRecord[];
	taskRuns(taskId: string): TaskRunRecord[];
	recordPlan(tasks: TaskRecord[], dependencies: TaskDependency[]): void;
	taskDependencies(taskIds: string[]): TaskDependency[];
	reconcileExpiredTaskRuns(now?: number): TaskRecoveryResult;
	recoveryCandidates(limit?: number): TaskRecord[];
}
import type { AgentScope } from "./agent-scope.ts";

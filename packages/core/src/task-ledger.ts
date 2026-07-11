export type TaskKind = "objective" | "delegated" | "automation";
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/** Durable responsibility, independent of the worker or channel executing it. */
export interface TaskRecord {
	id: string;
	ownerKey: string;
	kind: TaskKind;
	title: string;
	status: TaskStatus;
	parentId?: string;
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
	finishedAt?: number;
	output?: string;
	error?: string;
}
export type TaskRunTransition = Pick<TaskRunRecord, "status"> & Partial<Pick<TaskRunRecord, "finishedAt" | "output" | "error">>;
export interface TaskQuery {
	ownerKeys: string[];
	id?: string;
	kinds?: TaskKind[];
	statuses?: TaskStatus[];
	limit?: number;
}

/** Persistence port used by task producers; storage remains replaceable. */
export interface TaskLedger {
	record(task: TaskRecord): void;
	transition(id: string, change: TaskTransition): void;
	recordRun(run: TaskRunRecord): void;
	transitionRun(id: string, change: TaskRunTransition): void;
	queryTasks(query: TaskQuery): TaskRecord[];
	taskRuns(taskId: string): TaskRunRecord[];
}

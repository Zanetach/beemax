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
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	result?: string;
	error?: string;
}

export type TaskTransition = Pick<TaskRecord, "status"> & Partial<Pick<TaskRecord, "startedAt" | "finishedAt" | "result" | "error">>;

/** Persistence port used by task producers; storage remains replaceable. */
export interface TaskLedger {
	record(task: TaskRecord): void;
	transition(id: string, change: TaskTransition): void;
}

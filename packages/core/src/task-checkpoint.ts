import { containsCredentialMaterial } from "./credential-material.ts";

export interface TaskCheckpoint {
	version: 1;
	taskRunId: string;
	source: "pi_turn" | "candidate_outcome";
	at: number;
	completed: string[];
	committedEffectIds: string[];
	evidenceRefs: string[];
	unresolvedIssues: string[];
	nextSafeStep: string;
}

export type TaskCheckpointInput = Omit<TaskCheckpoint, "version">;

/** Canonical bounded recovery snapshot shared by Pi lifecycle and Task recovery. */
export function createTaskCheckpoint(input: TaskCheckpointInput): TaskCheckpoint {
	if (input.source !== "pi_turn" && input.source !== "candidate_outcome") throw new Error("Task Checkpoint source is invalid");
	const checkpoint: TaskCheckpoint = {
		version: 1,
		taskRunId: requiredText(input.taskRunId, 256, "Task Run id"),
		source: input.source,
		at: finiteTime(input.at),
		completed: safeList(input.completed, 100, 512),
		committedEffectIds: safeList(input.committedEffectIds, 100, 256),
		evidenceRefs: safeList(input.evidenceRefs, 100, 1_000),
		unresolvedIssues: safeList(input.unresolvedIssues, 100, 1_000),
		nextSafeStep: requiredText(input.nextSafeStep, 2_000, "next safe step"),
	};
	if (containsCredentialMaterial(JSON.stringify(checkpoint))) throw new Error("Task Checkpoint contains sensitive credential material");
	return Object.freeze(checkpoint);
}

export function isTaskCheckpoint(value: unknown): value is TaskCheckpoint {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<TaskCheckpoint>;
	return item.version === 1 && typeof item.taskRunId === "string" && (item.source === "pi_turn" || item.source === "candidate_outcome")
		&& typeof item.at === "number" && [item.completed, item.committedEffectIds, item.evidenceRefs, item.unresolvedIssues].every((list) => Array.isArray(list) && list.every((entry) => typeof entry === "string"))
		&& typeof item.nextSafeStep === "string" && !containsCredentialMaterial(JSON.stringify(item));
}

export function renderTaskCheckpoint(checkpoint: TaskCheckpoint | string): string {
	return typeof checkpoint === "string" ? checkpoint : JSON.stringify(checkpoint);
}

export function parseTaskCheckpoint(value: string): TaskCheckpoint | string {
	try { const parsed = JSON.parse(value) as unknown; return isTaskCheckpoint(parsed) ? createTaskCheckpoint(parsed) : value; }
	catch { return value; }
}

export function mergeTaskCheckpoints(previous: TaskCheckpoint | string | undefined, next: TaskCheckpoint): TaskCheckpoint {
	if (!previous || typeof previous === "string" || previous.taskRunId !== next.taskRunId) return next;
	return createTaskCheckpoint({
		...next,
		completed: [...previous.completed, ...next.completed],
		committedEffectIds: [...previous.committedEffectIds, ...next.committedEffectIds],
		evidenceRefs: [...previous.evidenceRefs, ...next.evidenceRefs],
		unresolvedIssues: [...previous.unresolvedIssues, ...next.unresolvedIssues],
	});
}

function safeList(values: readonly string[], limit: number, maxLength: number): string[] {
	return [...new Set(values.map((value) => requiredText(value, maxLength, "entry")))].slice(0, limit);
}
function requiredText(value: string, maxLength: number, field: string): string {
	const text = value.trim();
	if (!text || text.length > maxLength || containsCredentialMaterial(text)) throw new Error(`Task Checkpoint ${field} is invalid or contains sensitive credential material`);
	return text;
}
function finiteTime(value: number): number { if (!Number.isFinite(value) || value < 0) throw new Error("Task Checkpoint time is invalid"); return value; }

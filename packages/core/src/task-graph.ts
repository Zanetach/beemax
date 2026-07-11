import type { TaskDependency, TaskLedger, TaskRecord } from "./task-ledger.ts";

const DEFAULT_EXECUTION_LEASE_MS = 61 * 60_000;

export interface TaskPlanInput {
	id: string;
	ownerKey: string;
	tasks: Array<{ id: string; title: string; description?: string; kind?: TaskRecord["kind"]; parentId?: string; recoveryPolicy?: TaskRecord["recoveryPolicy"]; idempotencyKey?: string }>;
	dependencies?: TaskDependency[];
}
export type TaskGraphExecutor = (task: TaskRecord, signal?: AbortSignal) => Promise<{ output?: string }>;
export interface TaskGraphRunOptions { maxConcurrent?: number; signal?: AbortSignal; executor?: "agent" | "subagent"; leaseMs?: number; }
export interface TaskGraphResult { succeeded: number; failed: number; cancelled: number; blocked: string[]; }
interface ActiveTaskResult { execution: Promise<ActiveTaskResult>; outcome: "succeeded" | "failed" | "cancelled"; }

/** Persistent DAG invariants and bounded ready-task execution. */
export class TaskGraph {
	private readonly ledger: TaskLedger;
	constructor(ledger: TaskLedger) { this.ledger = ledger; }

	createPlan(input: TaskPlanInput, now = Date.now()): TaskRecord[] {
		if (!input.id.trim()) throw new Error("Task Plan id is required");
		if (!input.ownerKey.trim()) throw new Error("Task Plan owner is required");
		if (input.tasks.length === 0 || input.tasks.length > 100) throw new Error("Task Plan must contain between 1 and 100 Tasks");
		const ids = new Set<string>();
		for (const task of input.tasks) {
			if (!task.id.trim() || !task.title.trim()) throw new Error("Task Plan tasks require an id and title");
			if (ids.has(task.id)) throw new Error(`Duplicate Task id: ${task.id}`);
			ids.add(task.id);
		}
		const dependencies = input.dependencies ?? [];
		const edgeKeys = new Set<string>();
		for (const edge of dependencies) {
			if (!ids.has(edge.taskId) || !ids.has(edge.dependsOn)) throw new Error(`Task dependency references a Task outside the Plan: ${edge.taskId} -> ${edge.dependsOn}`);
			if (edge.taskId === edge.dependsOn) throw new Error(`Task dependency cycle: ${edge.taskId}`);
			const key = `${edge.taskId}\0${edge.dependsOn}`;
			if (edgeKeys.has(key)) throw new Error(`Duplicate Task dependency: ${edge.taskId} -> ${edge.dependsOn}`);
			edgeKeys.add(key);
		}
		assertAcyclic(ids, dependencies);
		const tasks = input.tasks.map((task): TaskRecord => ({
			id: task.id, ownerKey: input.ownerKey, kind: task.kind ?? "delegated", title: task.title,
			status: "pending", planId: input.id, createdAt: now,
			...(task.description ? { description: task.description } : {}), ...(task.parentId ? { parentId: task.parentId } : {}),
			...(task.recoveryPolicy ? { recoveryPolicy: task.recoveryPolicy } : {}), ...(task.idempotencyKey ? { idempotencyKey: task.idempotencyKey } : {}),
		}));
		this.ledger.recordPlan(tasks, dependencies);
		return tasks;
	}

	async run(ownerKeys: string[], planId: string, execute: TaskGraphExecutor, options: TaskGraphRunOptions = {}): Promise<TaskGraphResult> {
		const concurrency = Math.max(1, Math.min(Math.trunc(options.maxConcurrent ?? 3), 20));
		let succeeded = 0;
		let failed = 0;
		let cancelled = 0;
		const active = new Set<Promise<ActiveTaskResult>>();
		while (true) {
			const tasks = this.ledger.queryTasks({ ownerKeys, planIds: [planId], limit: 100 });
			let pending = tasks.filter((task) => task.status === "pending");
			if (options.signal?.aborted && pending.length) {
				const finishedAt = Date.now();
				for (const task of pending) this.ledger.transition(task.id, { status: "cancelled", finishedAt, error: "Task Plan cancelled" });
				cancelled += pending.length;
				pending = [];
			}
			const byId = new Map(tasks.map((task) => [task.id, task]));
			const edges = this.ledger.taskDependencies(pending.map((task) => task.id));
			const dependencies = new Map<string, string[]>();
			for (const edge of edges) dependencies.set(edge.taskId, [...(dependencies.get(edge.taskId) ?? []), edge.dependsOn]);
			const ready = pending.filter((task) => (dependencies.get(task.id) ?? []).every((id) => byId.get(id)?.status === "succeeded"));
			for (const task of ready.slice(0, Math.max(0, concurrency - active.size))) {
				let execution!: Promise<ActiveTaskResult>;
				execution = this.executeTask(task, execute, options).then((outcome) => ({ execution, outcome }));
				active.add(execution);
			}
			if (active.size > 0) {
				const completed = await Promise.race(active);
				active.delete(completed.execution);
				if (completed.outcome === "succeeded") succeeded++;
				else if (completed.outcome === "cancelled") cancelled++;
				else failed++;
				continue;
			}
			if (pending.length > 0) return { succeeded, failed, cancelled, blocked: pending.map((task) => task.id) };
			const staleRunning = tasks.filter((task) => task.status === "running").map((task) => task.id);
			return { succeeded, failed, cancelled, blocked: staleRunning };
		}
	}

	private async executeTask(task: TaskRecord, execute: TaskGraphExecutor, options: TaskGraphRunOptions): Promise<"succeeded" | "failed" | "cancelled"> {
		const startedAt = Date.now();
		const runId = crypto.randomUUID();
		this.ledger.transition(task.id, { status: "running", startedAt });
		const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_EXECUTION_LEASE_MS);
		this.ledger.recordRun({ id: runId, taskId: task.id, executor: options.executor ?? "agent", status: "running", startedAt, leaseExpiresAt: startedAt + leaseMs });
		try {
			if (options.signal?.aborted) throw options.signal.reason ?? new Error("Task Plan cancelled");
			const result = await execute({ ...task, status: "running", startedAt }, options.signal);
			const finishedAt = Date.now();
			const output = result.output?.slice(0, 50_000);
			this.ledger.transition(task.id, { status: "succeeded", finishedAt, result: output });
			this.ledger.transitionRun(runId, { status: "succeeded", finishedAt, output });
			return "succeeded";
		} catch (error) {
			const finishedAt = Date.now();
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 5_000);
			const status = options.signal?.aborted ? "cancelled" : "failed";
			this.ledger.transition(task.id, { status, finishedAt, error: message });
			this.ledger.transitionRun(runId, { status, finishedAt, error: message });
			return status;
		}
	}
}

function assertAcyclic(ids: Set<string>, edges: TaskDependency[]): void {
	const indegree = new Map([...ids].map((id) => [id, 0]));
	const dependents = new Map<string, string[]>();
	for (const edge of edges) {
		indegree.set(edge.taskId, (indegree.get(edge.taskId) ?? 0) + 1);
		dependents.set(edge.dependsOn, [...(dependents.get(edge.dependsOn) ?? []), edge.taskId]);
	}
	const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
	let visited = 0;
	while (queue.length) {
		const id = queue.shift()!; visited++;
		for (const dependent of dependents.get(id) ?? []) {
			const degree = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, degree);
			if (degree === 0) queue.push(dependent);
		}
	}
	if (visited !== ids.size) throw new Error("Task dependency cycle detected");
}

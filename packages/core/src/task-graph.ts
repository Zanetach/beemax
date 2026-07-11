import type { TaskDependency, TaskLedger, TaskPlanRecord, TaskRecord } from "./task-ledger.ts";

const DEFAULT_EXECUTION_LEASE_MS = 61 * 60_000;

export interface TaskPlanInput {
	id: string;
	ownerKey: string;
	title?: string;
	tasks: Array<{ id: string; title: string; description?: string; acceptanceCriteria?: string; kind?: TaskRecord["kind"]; parentId?: string; recoveryPolicy?: TaskRecord["recoveryPolicy"]; idempotencyKey?: string; executionScope?: TaskRecord["executionScope"] }>;
	dependencies?: TaskDependency[];
}
export interface TaskGraphExecutionResult { output?: string; }
export interface TaskGraphVerificationResult { accepted: boolean; feedback?: string; evidence?: string; }
export interface TaskGraphDependencyResult { id: string; title: string; result?: string; evidence?: string; }
export interface TaskGraphExecutionContext { attempt: number; verificationFeedback?: string; previousResult?: string; dependencies: TaskGraphDependencyResult[]; }
export type TaskGraphExecutor = (task: TaskRecord, signal?: AbortSignal, context?: TaskGraphExecutionContext) => Promise<TaskGraphExecutionResult>;
export type TaskGraphVerifier = (task: TaskRecord, result: TaskGraphExecutionResult, signal?: AbortSignal) => Promise<TaskGraphVerificationResult>;
export interface TaskGraphRunOptions { maxConcurrent?: number; signal?: AbortSignal; executor?: "agent" | "subagent"; leaseMs?: number; leaseHeartbeatMs?: number; canExecute?: (task: TaskRecord) => boolean; verify?: TaskGraphVerifier; maxCorrectiveAttempts?: number; }
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
			...(task.acceptanceCriteria ? { acceptanceCriteria: task.acceptanceCriteria } : {}),
			...(task.acceptanceCriteria ? { verificationStatus: "pending" as const, correctiveAttempts: 0 } : {}),
			...(task.recoveryPolicy ? { recoveryPolicy: task.recoveryPolicy } : {}), ...(task.idempotencyKey ? { idempotencyKey: task.idempotencyKey } : {}),
			...(task.executionScope ? { executionScope: { ...task.executionScope } } : {}),
		}));
		const plan: TaskPlanRecord = { id: input.id, ownerKey: input.ownerKey, title: input.title?.trim() || "Task Plan", status: "pending", taskCount: tasks.length, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: now };
		this.ledger.recordPlan(tasks, dependencies, plan);
		return tasks;
	}

	async run(ownerKeys: string[], planId: string, execute: TaskGraphExecutor, options: TaskGraphRunOptions = {}): Promise<TaskGraphResult> {
		const initialTasks = this.ledger.queryTasks({ ownerKeys, planIds: [planId], limit: 100 });
		if (initialTasks.length) this.updatePlanOutcome(planId, initialTasks, "running");
		const concurrency = Math.max(1, Math.min(Math.trunc(options.maxConcurrent ?? 3), 20));
		let succeeded = 0;
		let failed = 0;
		let cancelled = 0;
		const active = new Set<Promise<ActiveTaskResult>>();
		while (true) {
			const tasks = this.ledger.queryTasks({ ownerKeys, planIds: [planId], limit: 100 });
			let pending = tasks.filter((task) => task.status === "pending" && (options.canExecute?.(task) ?? true));
			if (options.signal?.aborted && pending.length) {
				const finishedAt = Date.now();
				for (const task of pending) if (this.ledger.transition(task.id, { status: "cancelled", finishedAt, error: "Task Plan cancelled" })) cancelled++;
				pending = [];
			}
			const byId = new Map(tasks.map((task) => [task.id, task]));
			const edges = this.ledger.taskDependencies(pending.map((task) => task.id));
			const dependencies = new Map<string, string[]>();
			for (const edge of edges) dependencies.set(edge.taskId, [...(dependencies.get(edge.taskId) ?? []), edge.dependsOn]);
			const dependencyFailures = pending.map((task) => ({
				task,
				failed: (dependencies.get(task.id) ?? []).map((id) => byId.get(id)).filter((dependency): dependency is TaskRecord => dependency?.status === "failed" || dependency?.status === "cancelled"),
			})).filter((entry) => entry.failed.length > 0);
			if (dependencyFailures.length) {
				const finishedAt = Date.now();
				for (const { task, failed: failedDependencies } of dependencyFailures) {
					const reason = failedDependencies.map((dependency) => `${dependency.id} is ${dependency.status}`).join(", ");
					if (this.ledger.transition(task.id, { status: "failed", finishedAt, error: `Dependency Failure: ${reason}` })) failed++;
				}
				continue;
			}
			const ready = pending.filter((task) => (dependencies.get(task.id) ?? []).every((id) => byId.get(id)?.status === "succeeded"));
			for (const task of ready.slice(0, Math.max(0, concurrency - active.size))) {
				const dependencyResults = (dependencies.get(task.id) ?? []).map((id) => byId.get(id)!).map(({ id, title, result, evidence }) => ({ id, title, result, evidence }));
				let execution!: Promise<ActiveTaskResult>;
				execution = this.executeTask(task, dependencyResults, execute, options).then((outcome) => ({ execution, outcome }));
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
			if (!staleRunning.length) this.updatePlanOutcome(planId, tasks);
			return { succeeded, failed, cancelled, blocked: staleRunning };
		}
	}

	private updatePlanOutcome(planId: string, tasks: TaskRecord[], forcedStatus?: TaskPlanRecord["status"]): void {
		const succeeded = tasks.filter((task) => task.status === "succeeded").length;
		const failed = tasks.filter((task) => task.status === "failed").length;
		const cancelled = tasks.filter((task) => task.status === "cancelled").length;
		const status = forcedStatus ?? (failed ? "failed" : cancelled ? "cancelled" : "succeeded");
		const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
		this.ledger.transitionPlan(planId, {
			status, taskCount: tasks.length, succeeded, failed, cancelled,
			verified: tasks.filter((task) => task.verificationStatus === "accepted").length,
			correctiveAttempts: tasks.reduce((sum, task) => sum + (task.correctiveAttempts ?? 0), 0),
			...(status === "running" ? { startedAt: Date.now() } : {}), ...(terminal ? { finishedAt: Date.now() } : {}),
		});
	}

	private async executeTask(task: TaskRecord, dependencies: TaskGraphDependencyResult[], execute: TaskGraphExecutor, options: TaskGraphRunOptions): Promise<"succeeded" | "failed" | "cancelled"> {
		const taskStartedAt = Date.now();
		if (!this.ledger.transition(task.id, { status: "running", startedAt: taskStartedAt, ...(task.acceptanceCriteria ? { verificationStatus: "pending" as const, correctiveAttempts: 0 } : {}) })) return this.persistedOutcome(task, "failed");
		const maxCorrectiveAttempts = Math.max(0, Math.min(Math.trunc(options.maxCorrectiveAttempts ?? 0), 2));
		let verificationFeedback: string | undefined;
		let previousResult: string | undefined;
		for (let attempt = 1; attempt <= maxCorrectiveAttempts + 1; attempt++) {
			const startedAt = Date.now();
			if (attempt > 1 && !this.ledger.transition(task.id, { status: "running", startedAt, verificationStatus: "pending", correctiveAttempts: attempt - 1 })) return this.persistedOutcome(task, "failed");
			const runId = crypto.randomUUID();
			const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_EXECUTION_LEASE_MS);
			this.ledger.recordRun({ id: runId, taskId: task.id, executor: options.executor ?? "agent", status: "running", startedAt, leaseExpiresAt: startedAt + leaseMs });
			const leaseController = new AbortController();
			const executionSignal = options.signal ? AbortSignal.any([options.signal, leaseController.signal]) : leaseController.signal;
			const heartbeatMs = Math.max(1, options.leaseHeartbeatMs ?? Math.min(60_000, Math.max(1_000, Math.trunc(leaseMs / 3))));
			const heartbeat = this.ledger.renewTaskRunLease ? setInterval(() => {
				try {
					if (!this.ledger.renewTaskRunLease?.(runId, Date.now() + leaseMs)) leaseController.abort(new Error("Task Run Execution Lease could not be renewed"));
				} catch (error) { leaseController.abort(error); }
			}, heartbeatMs) : undefined;
			leaseController.signal.addEventListener("abort", () => { if (heartbeat) clearInterval(heartbeat); }, { once: true });
			try {
				if (executionSignal.aborted) throw executionSignal.reason ?? new Error("Task Plan cancelled");
				const result = await execute({ ...task, status: "running", startedAt: taskStartedAt }, executionSignal, { attempt, verificationFeedback, previousResult, dependencies });
				if (executionSignal.aborted) throw executionSignal.reason ?? new Error("Task execution interrupted");
				let verificationEvidence: string | undefined;
				if (task.acceptanceCriteria) {
					if (!options.verify) throw new Error("Task verification unavailable for defined Acceptance Criteria");
					const verification = await options.verify({ ...task, status: "running", startedAt: taskStartedAt }, result, executionSignal);
					if (executionSignal.aborted) throw executionSignal.reason ?? new Error("Task verification interrupted");
					if (!verification.accepted) {
						verificationFeedback = verification.feedback?.trim() || "Acceptance Criteria were not satisfied";
						previousResult = result.output?.slice(0, 50_000);
						const finishedAt = Date.now();
						if (!this.ledger.transitionRun(runId, { status: "failed", finishedAt, error: `Task verification rejected: ${verificationFeedback}` })) return this.persistedOutcome(task, "failed");
						if (attempt <= maxCorrectiveAttempts) {
							if (!this.ledger.transition(task.id, { status: "pending", error: `Task verification rejected: ${verificationFeedback}`, verificationStatus: "rejected", correctiveAttempts: attempt - 1 })) return this.persistedOutcome(task, "failed");
							continue;
						}
						return this.ledger.transition(task.id, { status: "failed", finishedAt, error: `Task verification rejected: ${verificationFeedback}`, verificationStatus: "rejected", correctiveAttempts: attempt - 1 }) ? "failed" : this.persistedOutcome(task, "failed");
					}
					verificationEvidence = verification.evidence?.slice(0, 5_000);
				}
				const finishedAt = Date.now();
				const output = result.output?.slice(0, 50_000);
				if (!this.ledger.transition(task.id, { status: "succeeded", finishedAt, result: output, evidence: verificationEvidence, ...(task.acceptanceCriteria ? { verificationStatus: "accepted" as const, correctiveAttempts: attempt - 1 } : {}) })) {
					const outcome = this.persistedOutcome(task, "failed");
					this.ledger.transitionRun(runId, { status: outcome, finishedAt, error: outcome === "succeeded" ? undefined : `Task already reached Terminal Outcome: ${outcome}` });
					return outcome;
				}
				this.ledger.transitionRun(runId, { status: "succeeded", finishedAt, output });
				return "succeeded";
			} catch (error) {
				const finishedAt = Date.now();
				const message = (error instanceof Error ? error.message : String(error)).slice(0, 5_000);
				const status = options.signal?.aborted ? "cancelled" : "failed";
				const transitioned = this.ledger.transition(task.id, { status, finishedAt, error: message });
				this.ledger.transitionRun(runId, { status, finishedAt, error: message });
				return transitioned ? status : this.persistedOutcome(task, status);
			} finally { if (heartbeat) clearInterval(heartbeat); }
		}
		return "failed";
	}

	private persistedOutcome(task: TaskRecord, fallback: "succeeded" | "failed" | "cancelled"): "succeeded" | "failed" | "cancelled" {
		const status = this.ledger.queryTasks({ ownerKeys: [task.ownerKey], id: task.id, limit: 1 })[0]?.status;
		return status === "succeeded" || status === "failed" || status === "cancelled" ? status : fallback;
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

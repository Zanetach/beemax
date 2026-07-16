import type { TaskArtifact, TaskCriterionVerification, TaskDependency, TaskLedger, TaskPlanRecord, TaskRecord } from "./task-ledger.ts";
import { containsCredentialMaterial, redactCredentialMaterial } from "./credential-material.ts";
import { createExecutionEnvelope, type ExecutionEnvelope } from "./execution-envelope.ts";
import type { ExecutionTraceInput, ExecutionTraceSink } from "./execution-trace.ts";
import { createTaskCheckpoint, mergeTaskCheckpoints, renderTaskCheckpoint, type TaskCheckpoint } from "./task-checkpoint.ts";
import { sanitizeTaskCriterionVerifications, unavailableTaskCriterionVerifications } from "./task-criteria.ts";

const DEFAULT_EXECUTION_LEASE_MS = 61 * 60_000;

export interface TaskPlanInput {
	id: string;
	ownerKey: string;
	title?: string;
	tasks: Array<{ id: string; title: string; description?: string; acceptanceCriteria?: string; kind?: TaskRecord["kind"]; parentId?: string; recoveryPolicy?: TaskRecord["recoveryPolicy"]; idempotencyKey?: string; executionScope?: TaskRecord["executionScope"]; situation?: TaskRecord["situation"]; accessScopeRef?: TaskRecord["accessScopeRef"]; routes?: string[] }>;
	dependencies?: TaskDependency[];
}
export interface TaskGraphExecutionResult { output?: string; evidence?: string; artifacts?: TaskArtifact[]; unresolvedIssues?: string[]; }
export interface TaskGraphVerificationResult { accepted: boolean; feedback?: string; evidence?: string; criterionVerifications?: TaskCriterionVerification[]; }
export interface TaskGraphVerificationContext { taskRunId: string; successfulToolNames?: readonly string[]; }
export interface TaskGraphDependencyResult { id: string; title: string; result?: string; evidence?: string; artifacts?: TaskArtifact[]; unresolvedIssues?: string[]; }
export interface TaskGraphExecutionContext { executionEnvelope: Readonly<ExecutionEnvelope>; taskRunId: string; attempt: number; executionMode: "normal" | "recovery"; maxCorrectiveAttempts: number; verificationFeedback?: string; previousResult?: string; dependencies: TaskGraphDependencyResult[]; checkpoint?: TaskCheckpoint | string; route?: string; saveCheckpoint(value: TaskCheckpoint | string): boolean; }
export type TaskGraphExecutor = (task: TaskRecord, signal?: AbortSignal, context?: TaskGraphExecutionContext) => Promise<TaskGraphExecutionResult>;
export type TaskGraphVerifier = (task: TaskRecord, result: TaskGraphExecutionResult, signal?: AbortSignal, context?: TaskGraphVerificationContext) => Promise<TaskGraphVerificationResult>;
export interface TaskGraphRunOptions { maxConcurrent?: number; signal?: AbortSignal; executor?: "agent" | "subagent"; leaseMs?: number; leaseHeartbeatMs?: number; canExecute?: (task: TaskRecord) => boolean; verify?: TaskGraphVerifier; maxCorrectiveAttempts?: number; executionMode?: "normal" | "recovery"; }
export interface TaskGraphResult { succeeded: number; failed: number; cancelled: number; blocked: string[]; }
interface ActiveTaskResult { execution: Promise<ActiveTaskResult>; outcome: "succeeded" | "failed" | "cancelled" | "routed" | "awaiting_verification"; }

/** Persistent DAG invariants and bounded ready-task execution. */
export class TaskGraph {
	private readonly ledger: TaskLedger;
	private readonly executionTrace?: ExecutionTraceSink;
	constructor(ledger: TaskLedger, executionTrace?: ExecutionTraceSink) { this.ledger = ledger; this.executionTrace = executionTrace; }

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
		const parentIds = [...new Set(input.tasks.map((task) => task.parentId).filter((id): id is string => Boolean(id)))];
		const parentContexts = new Map(parentIds.map((id) => {
			const parent = this.ledger.queryTasks({ ownerKeys: [input.ownerKey], id, limit: 1 })[0];
			return [id, parent ? { situation: parent.situation, accessScopeRef: parent.accessScopeRef } : undefined] as const;
		}));
		const tasks = input.tasks.map((task): TaskRecord => {
			const inherited = task.parentId ? parentContexts.get(task.parentId) : undefined;
			return {
			id: task.id, ownerKey: input.ownerKey, kind: task.kind ?? "delegated", title: task.title,
			status: "pending", planId: input.id, createdAt: now,
			...(task.description ? { description: task.description } : {}), ...(task.parentId ? { parentId: task.parentId } : {}),
			...(task.acceptanceCriteria ? { acceptanceCriteria: task.acceptanceCriteria } : {}),
			...(task.acceptanceCriteria ? { verificationStatus: "pending" as const, correctiveAttempts: 0 } : {}),
			...(task.recoveryPolicy ? { recoveryPolicy: task.recoveryPolicy } : {}), ...(task.idempotencyKey ? { idempotencyKey: task.idempotencyKey } : {}),
			...(task.executionScope ? { executionScope: { ...task.executionScope } } : {}),
			...((task.situation ?? inherited?.situation) ? { situation: structuredClone(task.situation ?? inherited!.situation!) } : {}),
			...((task.accessScopeRef ?? inherited?.accessScopeRef) ? { accessScopeRef: structuredClone(task.accessScopeRef ?? inherited!.accessScopeRef!) } : {}),
			...(task.routes?.length ? { routes: task.routes.map((route) => route.trim()).filter(Boolean).slice(0, 5), routeIndex: 0 } : {}),
			};
		});
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
			const plan = this.ledger.queryTaskPlans({ ownerKeys, id: planId, limit: 1 })[0];
			const paused = Boolean(plan?.pausedAt);
			if (paused && active.size === 0) return { succeeded, failed, cancelled, blocked: tasks.filter((task) => task.status === "pending").map((task) => task.id) };
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
			for (const task of ready.slice(0, paused ? 0 : Math.max(0, concurrency - active.size))) {
				const dependencyResults = (dependencies.get(task.id) ?? []).map((id) => byId.get(id)!).map(({ id, title, result, evidence, artifacts, unresolvedIssues }) => ({
					id, title, result, evidence, ...(artifacts ? { artifacts } : {}), ...(unresolvedIssues ? { unresolvedIssues } : {}),
				}));
				let execution!: Promise<ActiveTaskResult>;
				execution = this.executeTask(task, dependencyResults, execute, options).then((outcome) => ({ execution, outcome }));
				active.add(execution);
			}
			if (active.size > 0) {
				const completed = await Promise.race(active);
				active.delete(completed.execution);
				if (completed.outcome === "succeeded") succeeded++;
				else if (completed.outcome === "cancelled") cancelled++;
				else if (completed.outcome === "failed") failed++;
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

	private async executeTask(task: TaskRecord, dependencies: TaskGraphDependencyResult[], execute: TaskGraphExecutor, options: TaskGraphRunOptions): Promise<"succeeded" | "failed" | "cancelled" | "routed" | "awaiting_verification"> {
		const taskStartedAt = Date.now();
		let verificationFeedback = task.verificationStatus === "rejected" ? task.verificationFeedback : undefined;
		let previousResult = task.verificationStatus === "rejected" ? task.candidateResult : undefined;
		const maxCorrectiveAttempts = Math.max(0, Math.min(Math.trunc(options.maxCorrectiveAttempts ?? 0), 2));
		const priorCorrectiveAttempts = task.correctiveAttempts ?? 0;
		const resumingCorrection = task.verificationStatus === "rejected" && verificationFeedback !== undefined && previousResult !== undefined;
		const firstAttempt = resumingCorrection ? priorCorrectiveAttempts + 2 : 1;
		if (firstAttempt > maxCorrectiveAttempts + 1) {
			const finishedAt = Date.now();
			return this.ledger.transition(task.id, { status: "failed", finishedAt, error: "Corrective Attempt budget exhausted", verificationStatus: "rejected", verificationFeedback, correctiveAttempts: priorCorrectiveAttempts }) ? "failed" : this.persistedOutcome(task, "failed");
		}
		if (!this.ledger.transition(task.id, { status: "running", startedAt: taskStartedAt, ...(task.acceptanceCriteria ? { verificationStatus: "pending" as const, correctiveAttempts: priorCorrectiveAttempts } : {}) })) return this.persistedOutcome(task, "failed");
		for (let attempt = firstAttempt; attempt <= maxCorrectiveAttempts + 1; attempt++) {
			const startedAt = Date.now();
			if (attempt > firstAttempt && !this.ledger.transition(task.id, { status: "running", startedAt, verificationStatus: "pending", correctiveAttempts: attempt - 1 })) return this.persistedOutcome(task, "failed");
			const runId = crypto.randomUUID();
			const executionMode = options.executionMode ?? "normal";
			const objectiveId = this.objectiveRootId(task);
			const executionEnvelope = createExecutionEnvelope({
				executionId: `execution:${runId}`, trigger: { kind: executionMode === "recovery" ? "recovery" : "task_transition", id: task.id },
				...(objectiveId ? { objectiveId } : {}), taskId: task.id, taskRunId: runId,
				...(task.accessScopeRef ? { accessScopeRef: task.accessScopeRef } : {}), budget: { maxCorrectiveAttempts },
				mode: attempt > 1 ? "correction" : executionMode,
			});
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
			let verificationUnavailable = false;
			let candidateOutput: string | undefined;
			let criterionVerifications: TaskCriterionVerification[] | undefined;
			try {
				if (executionSignal.aborted) throw executionSignal.reason ?? new Error("Task Plan cancelled");
				const current = this.ledger.queryTasks({ ownerKeys: [task.ownerKey], id: task.id, limit: 1 })[0] ?? task;
				const result = await execute({ ...current, status: "running", startedAt: taskStartedAt }, executionSignal, {
					executionEnvelope, taskRunId: runId, attempt, executionMode, maxCorrectiveAttempts, verificationFeedback, previousResult, dependencies, checkpoint: current.checkpoint,
					route: current.routes?.[current.routeIndex ?? 0],
					saveCheckpoint: (value) => {
						if (containsCredentialMaterial(renderTaskCheckpoint(value))) return false;
						const checkpoint = typeof value === "string" ? value.slice(0, 50_000) : value;
						const saved = this.ledger.checkpointTask(task.ownerKey, task.id, checkpoint);
						if (saved) this.recordTrace({ type: "checkpoint.saved", executionEnvelope, at: Date.now(), sizeChars: renderTaskCheckpoint(checkpoint).length });
						return saved;
					},
				});
					if (executionSignal.aborted) throw executionSignal.reason ?? new Error("Task execution interrupted");
					candidateOutput = result.output?.slice(0, 50_000);
					const executionEvidence = result.evidence ? redactCredentialMaterial(result.evidence).slice(0, 5_000) : undefined;
					const artifacts = sanitizeTaskArtifacts(result.artifacts);
					const unresolvedIssues = sanitizeUnresolvedIssues(result.unresolvedIssues);
					const latest = this.ledger.queryTasks({ ownerKeys: [task.ownerKey], id: task.id, limit: 1 })[0];
					const candidateCheckpoint = createTaskCheckpoint({ taskRunId: runId, source: "candidate_outcome", at: Date.now(), completed: ["candidate-outcome"], committedEffectIds: [], evidenceRefs: [...(executionEvidence ? ["candidate:evidence"] : []), ...(artifacts ?? []).map((artifact) => `artifact:${artifact.type}:${artifact.uri}`)], unresolvedIssues: unresolvedIssues ?? [], nextSafeStep: task.acceptanceCriteria ? "Verify the Candidate Outcome against the Task Acceptance Criteria." : "Settle the Task from the Candidate Outcome without repeating completed work." });
					const mergedCheckpoint = mergeTaskCheckpoints(latest?.checkpoint, candidateCheckpoint);
					if (this.ledger.checkpointTask(task.ownerKey, task.id, mergedCheckpoint)) this.recordTrace({ type: "checkpoint.saved", executionEnvelope, at: candidateCheckpoint.at, sizeChars: renderTaskCheckpoint(mergedCheckpoint).length });
				let verificationEvidence: string | undefined;
				if (task.acceptanceCriteria) {
					if (!this.ledger.transition(task.id, { status: "running", candidateResult: candidateOutput, verificationStatus: "pending", correctiveAttempts: attempt - 1 })) return this.persistedOutcome(task, "failed");
					this.recordTrace({ type: "verification.started", executionEnvelope, at: Date.now() });
					if (!options.verify) { verificationUnavailable = true; this.recordTrace({ type: "verification.settled", executionEnvelope, at: Date.now(), status: "unavailable" }); throw new Error("Task verification unavailable for defined Acceptance Criteria"); }
					let verification: TaskGraphVerificationResult;
					const verificationTask = this.ledger.queryTasks({ ownerKeys: [task.ownerKey], id: task.id, limit: 1 })[0] ?? task;
					try { verification = await options.verify({ ...verificationTask, status: "running", startedAt: taskStartedAt }, result, executionSignal, { taskRunId: runId }); }
					catch (error) { verificationUnavailable = !executionSignal.aborted; this.recordTrace({ type: "verification.settled", executionEnvelope, at: Date.now(), status: "unavailable" }); throw error; }
					if (executionSignal.aborted) throw executionSignal.reason ?? new Error("Task verification interrupted");
					if (!verification.accepted) {
						this.recordTrace({ type: "verification.settled", executionEnvelope, at: Date.now(), status: "rejected" });
						verificationFeedback = redactCredentialMaterial(verification.feedback?.trim() || "Acceptance Criteria were not satisfied");
						previousResult = result.output?.slice(0, 50_000);
						const finishedAt = Date.now();
						if (!this.ledger.transitionRun(runId, { status: "failed", finishedAt, error: `Task verification rejected: ${verificationFeedback}` })) return this.persistedOutcome(task, "failed");
						criterionVerifications = sanitizeTaskCriterionVerifications(verification.criterionVerifications);
						if (attempt <= maxCorrectiveAttempts) {
							if (!this.ledger.transition(task.id, { status: "pending", candidateResult: previousResult, error: `Task verification rejected: ${verificationFeedback}`, verificationStatus: "rejected", verificationFeedback, criterionVerifications, correctiveAttempts: attempt - 1 })) return this.persistedOutcome(task, "failed");
							continue;
						}
						if (this.ledger.advanceTaskRoute(task.ownerKey, task.id, `Verification rejected: ${verificationFeedback}`, finishedAt)) return "routed";
						return this.ledger.transition(task.id, { status: "failed", finishedAt, candidateResult: previousResult, error: `Task verification rejected: ${verificationFeedback}`, verificationStatus: "rejected", verificationFeedback, criterionVerifications, correctiveAttempts: attempt - 1 }) ? "failed" : this.persistedOutcome(task, "failed");
					}
					this.recordTrace({ type: "verification.settled", executionEnvelope, at: Date.now(), status: "accepted" });
					verificationEvidence = verification.evidence?.slice(0, 5_000);
					criterionVerifications = sanitizeTaskCriterionVerifications(verification.criterionVerifications);
				}
				const finishedAt = Date.now();
				const output = candidateOutput;
				const evidence = mergeTaskEvidence(executionEvidence, verificationEvidence);
				if (!this.ledger.settleTaskRunAndTask) throw new Error("Atomic Task Run and Task success settlement is unavailable");
				if (!this.ledger.settleTaskRunAndTask({
					ownerKey: task.ownerKey, taskId: task.id, taskRunId: runId,
					task: { status: "succeeded", finishedAt, result: output, evidence, artifacts, unresolvedIssues, ...(task.acceptanceCriteria ? { verificationStatus: "accepted" as const, verificationFeedback: undefined, criterionVerifications, correctiveAttempts: attempt - 1 } : {}) },
					run: { status: "succeeded", finishedAt, output },
				})) throw new Error("Atomic Task Run and Task success settlement was rejected");
				return "succeeded";
			} catch (error) {
				const finishedAt = Date.now();
				const message = redactCredentialMaterial((error instanceof Error ? error.message : String(error)).slice(0, 5_000));
				if (!verificationUnavailable && !executionSignal.aborted && this.ledger.advanceTaskRoute(task.ownerKey, task.id, message, finishedAt)) {
					this.ledger.transitionRun(runId, { status: "failed", finishedAt, error: message });
					return "routed";
				}
				const status = options.signal?.aborted ? "cancelled" : "failed";
				const unavailable = verificationUnavailable && status === "failed";
				const transitioned = this.ledger.transition(task.id, unavailable
					? { status: "running", error: message, correctiveAttempts: attempt - 1, verificationStatus: "unavailable", criterionVerifications: unavailableTaskCriterionVerifications(task.acceptanceCriteria, message), candidateResult: candidateOutput }
					: { status, finishedAt, error: message, ...(task.acceptanceCriteria ? { correctiveAttempts: attempt - 1 } : {}) });
				if (transitioned && unavailable) this.ledger.deferCandidateVerification?.([task.ownerKey], task.id, finishedAt);
				this.ledger.transitionRun(runId, unavailable ? { status: "succeeded", finishedAt, output: candidateOutput } : { status, finishedAt, error: message });
				return unavailable && transitioned ? "awaiting_verification" : transitioned ? status : this.persistedOutcome(task, status);
			} finally { if (heartbeat) clearInterval(heartbeat); }
		}
		return "failed";
	}

	private recordTrace(event: ExecutionTraceInput): void {
		try { this.executionTrace?.record(event); } catch { /* Trace is diagnostic and cannot change Task authority. */ }
	}

	private objectiveRootId(task: TaskRecord): string | undefined {
		let current: TaskRecord | undefined = task;
		const visited = new Set<string>();
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			if (current.kind === "objective") return current.id;
			if (!current.parentId) return undefined;
			current = this.ledger.queryTasks({ ownerKeys: [task.ownerKey], id: current.parentId, limit: 1 })[0];
		}
		return undefined;
	}

	private persistedOutcome(task: TaskRecord, fallback: "succeeded" | "failed" | "cancelled"): "succeeded" | "failed" | "cancelled" {
		const status = this.ledger.queryTasks({ ownerKeys: [task.ownerKey], id: task.id, limit: 1 })[0]?.status;
		return status === "succeeded" || status === "failed" || status === "cancelled" ? status : fallback;
	}
}

function sanitizeTaskArtifacts(value: TaskArtifact[] | undefined): TaskArtifact[] | undefined {
	if (!value) return undefined;
	const artifacts = value.slice(0, 20).flatMap((artifact) => {
		if (!artifact || !["file", "url", "reference"].includes(artifact.type) || !artifact.uri?.trim()) return [];
		const normalized = { type: artifact.type, uri: artifact.uri.trim().slice(0, 2_000), ...(artifact.label?.trim() ? { label: artifact.label.trim().slice(0, 500) } : {}) };
		return containsCredentialMaterial(JSON.stringify(normalized)) ? [] : [normalized];
	});
	return artifacts.length ? artifacts : undefined;
}

function sanitizeUnresolvedIssues(value: string[] | undefined): string[] | undefined {
	if (!value) return undefined;
	const issues = value.slice(0, 20).map((issue) => redactCredentialMaterial(issue.trim()).slice(0, 2_000)).filter(Boolean);
	return issues.length ? issues : undefined;
}

function mergeTaskEvidence(execution: string | undefined, verification: string | undefined): string | undefined {
	if (!execution) return verification;
	if (!verification) return execution;
	return `[Execution evidence]\n${execution}\n[Verification evidence]\n${verification}`.slice(0, 5_000);
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

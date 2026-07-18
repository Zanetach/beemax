import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, withToolPolicy, type ToolPolicy } from "./tool-runtime.ts";
import { responsibilityOwnerKey, responsibilityOwnerKeys } from "./agent-scope.ts";
import type { TaskLedger, TaskStatus } from "./task-ledger.ts";
import type { TaskRunStatus } from "./task-ledger.ts";
import { TaskGraph, type TaskGraphVerifier } from "./task-graph.ts";

export type SubagentTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SubagentTaskSnapshot {
	id: string;
	name: string;
	goal: string;
	capability: "analysis" | "research";
	status: SubagentTaskStatus;
	createdAt: number;
	timeoutMs: number;
	startedAt?: number;
	taskRunId?: string;
	finishedAt?: number;
	result?: string;
	error?: string;
}

export interface SubagentTask extends SubagentTaskSnapshot {
	ownerKey: string;
	source: BeeMaxRuntimeSource;
	context?: string;
	parentId?: string;
	acceptanceCriteria?: string;
}

export type SubagentExecutor = (task: SubagentTask, signal: AbortSignal) => Promise<string>;
export type SubagentAdmission = <T>(ownerKey: string, work: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T>;

interface ManagedTask extends SubagentTask {
	controller?: AbortController;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	runId?: string;
	stopReason?: "cancelled" | "timeout";
	waiters: Set<() => void>;
	completionOrder?: number;
}

export interface SubagentManagerOptions {
	maxConcurrent?: number;
	maxChildrenPerOwner?: number;
	defaultTimeoutMs?: number;
	execute: SubagentExecutor;
	admit?: SubagentAdmission;
	taskLedger?: TaskLedger;
	maxRetainedTerminalTasks?: number;
	shutdownGraceMs?: number;
	/** Explicit authority to replay this executor after interruption; valid only for enforced read-only/idempotent Sub-Agents. */
	safeRetry?: boolean;
	/** Routes durable single delegation through the same Verification lifecycle as DAG Tasks. */
	verify?: TaskGraphVerifier;
	maxCorrectiveAttempts?: number;
}

const TERMINAL = new Set<SubagentTaskStatus>(["completed", "failed", "cancelled"]);
const EXECUTION_LEASE_GRACE_MS = 60_000;

export class SubagentManager {
	private readonly tasks = new Map<string, ManagedTask>();
	private readonly queue: string[] = [];
	private readonly activeRuns = new Set<Promise<void>>();
	private readonly maxConcurrent: number;
	private readonly maxChildrenPerOwner: number;
	private readonly defaultTimeoutMs: number;
	private readonly execute: SubagentExecutor;
	private readonly admit?: SubagentAdmission;
	private readonly taskLedger?: TaskLedger;
	private readonly maxRetainedTerminalTasks: number;
	private readonly shutdownGraceMs: number;
	private readonly safeRetry: boolean;
	private readonly verify?: TaskGraphVerifier;
	private readonly maxCorrectiveAttempts: number;
	private running = 0;
	private completionSequence = 0;
	private disposed = false;

	constructor(options: SubagentManagerOptions) {
		this.maxConcurrent = positiveInt(options.maxConcurrent, 3);
		this.maxChildrenPerOwner = positiveInt(options.maxChildrenPerOwner, 5);
		this.defaultTimeoutMs = Math.max(0, options.defaultTimeoutMs ?? 15 * 60_000);
		this.execute = options.execute;
		this.admit = options.admit;
		this.taskLedger = options.taskLedger;
		this.maxRetainedTerminalTasks = Math.max(1, Math.min(Math.trunc(options.maxRetainedTerminalTasks ?? 1_000), 10_000));
		this.shutdownGraceMs = Math.max(0, Math.min(Math.trunc(options.shutdownGraceMs ?? 30_000), 5 * 60_000));
		this.safeRetry = options.safeRetry === true;
		this.verify = options.verify;
		this.maxCorrectiveAttempts = Math.max(0, Math.min(Math.trunc(options.maxCorrectiveAttempts ?? 1), 2));
	}

	spawn(source: BeeMaxRuntimeSource, input: {
		name?: string;
		goal: string;
		context?: string;
		capability?: "analysis" | "research";
		parentId?: string;
		acceptanceCriteria?: string;
	}): SubagentTaskSnapshot {
		if (this.disposed) throw new Error("Sub-Agent runtime is shutting down");
		const ownerKey = responsibilityOwnerKey(source);
		const active = [...this.tasks.values()].filter((task) => task.ownerKey === ownerKey && !TERMINAL.has(task.status));
		if (active.length >= this.maxChildrenPerOwner) {
			throw new Error(`This conversation already has ${this.maxChildrenPerOwner} active Sub-Agent tasks`);
		}
		this.prune(ownerKey);
		const id = crypto.randomUUID();
		const goal = input.goal.trim();
		if (!goal) throw new Error("Sub-Agent goal is required");
		const acceptanceCriteria = (input.acceptanceCriteria?.trim() || `The delegated result satisfies the requested goal: ${goal}`).slice(0, 5_000);
		const task: ManagedTask = {
			id,
			ownerKey,
			source: { ...source },
			name: input.name?.trim() || `task-${id.slice(0, 8)}`,
			goal,
			context: input.context?.trim() || undefined,
			parentId: input.parentId?.trim() || undefined,
			acceptanceCriteria,
			capability: input.capability ?? "analysis",
			status: "queued",
			createdAt: Date.now(),
			timeoutMs: this.defaultTimeoutMs,
			waiters: new Set(),
		};
		if (this.taskLedger) {
			const planId = `delegation:${id}`;
			const description = [task.goal, task.context].filter(Boolean).join("\n\n").slice(0, 50_000);
			if (typeof this.taskLedger.recordPlan === "function") {
				this.taskLedger.recordPlan([{
					id, ownerKey, kind: "delegated", title: task.name, description, acceptanceCriteria, verificationStatus: "pending", correctiveAttempts: 0, status: "pending", createdAt: task.createdAt,
					planId, recoveryPolicy: this.safeRetry ? "safe_retry" : "never", ...(this.safeRetry ? { idempotencyKey: planId } : {}), executionScope: { ...source }, ...(task.parentId ? { parentId: task.parentId } : {}),
				}], [], { id: planId, ownerKey, title: task.name, status: "pending", taskCount: 1, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: task.createdAt });
			} else this.taskLedger.record({ id, ownerKey, kind: "delegated", title: task.name, status: "pending", createdAt: task.createdAt, ...(task.parentId ? { parentId: task.parentId } : {}) });
		}
		this.tasks.set(id, task);
		this.queue.push(id);
		void this.pump();
		return snapshot(task);
	}

	list(source: BeeMaxRuntimeSource): SubagentTaskSnapshot[] {
		const ownerKey = responsibilityOwnerKey(source);
		return [...this.tasks.values()]
			.filter((task) => task.ownerKey === ownerKey)
			.sort((a, b) => b.createdAt - a.createdAt)
			.map(summarySnapshot);
	}

	get(source: BeeMaxRuntimeSource, id: string): SubagentTaskSnapshot {
		const task = this.tasks.get(id);
		if (task?.ownerKey === responsibilityOwnerKey(source)) return snapshot(task);
		const durable = this.durableSnapshot(source, id);
		if (durable) return durable;
		throw new Error(`Sub-Agent task not found: ${id}`);
	}

	async wait(source: BeeMaxRuntimeSource, id: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<SubagentTaskSnapshot> {
		const task = this.tasks.get(id);
		if (!task || task.ownerKey !== responsibilityOwnerKey(source)) {
			const durable = this.durableSnapshot(source, id);
			if (durable) return durable;
			throw new Error(`Sub-Agent task not found: ${id}`);
		}
		if (TERMINAL.has(task.status)) return snapshot(task);
		if (signal?.aborted) return snapshot(task);
		await new Promise<void>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				if (timer) clearTimeout(timer);
				task.waiters.delete(done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			task.waiters.add(done);
			signal?.addEventListener("abort", done, { once: true });
			timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, 120_000)));
		});
		return snapshot(task);
	}

	cancel(source: BeeMaxRuntimeSource, id: string): SubagentTaskSnapshot {
		const task = this.ownedTask(source, id);
		if (TERMINAL.has(task.status)) return snapshot(task);
		task.stopReason = "cancelled";
		if (task.status === "queued") {
			this.removeFromQueue(id);
			task.controller?.abort(new Error("Cancelled by parent Agent"));
			this.finish(task, "cancelled", undefined, "Cancelled by parent Agent");
		} else {
			task.controller?.abort();
		}
		return snapshot(task);
	}

	cancelOwner(source: BeeMaxRuntimeSource): number {
		let cancelled = 0;
		for (const task of this.tasks.values()) {
			if (task.ownerKey === responsibilityOwnerKey(source) && !TERMINAL.has(task.status)) {
				this.cancel(source, task.id);
				cancelled++;
			}
		}
		return cancelled;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const task of this.tasks.values()) {
			if (!TERMINAL.has(task.status)) {
				task.stopReason = "cancelled";
				task.controller?.abort();
				if (task.status === "queued") this.finish(task, "cancelled", undefined, "Agent runtime is shutting down");
			}
		}
		this.queue.length = 0;
		if (this.activeRuns.size) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([Promise.allSettled([...this.activeRuns]), new Promise<void>((resolve) => { timer = setTimeout(resolve, this.shutdownGraceMs); })]);
			if (timer) clearTimeout(timer);
		}
		for (const task of this.tasks.values()) {
			if (TERMINAL.has(task.status)) continue;
			if (task.timeoutTimer) { clearTimeout(task.timeoutTimer); task.timeoutTimer = undefined; }
			this.finish(task, "cancelled", undefined, "Agent runtime shut down before the executor acknowledged cancellation");
		}
	}

	private async pump(): Promise<void> {
		if (this.admit) {
			while (!this.disposed) {
				const id = this.queue.shift();
				if (!id) return;
				const task = this.tasks.get(id);
				if (!task || task.status !== "queued") continue;
				this.submitForAdmission(task);
			}
		}
		while (!this.disposed && this.running < this.maxConcurrent) {
			const id = this.queue.shift();
			if (!id) return;
			const task = this.tasks.get(id);
			if (!task || task.status !== "queued") continue;
			this.running++;
			const active = this.run(task).catch((error) => {
				console.error(`[beemax] Sub-Agent Task lifecycle failed: ${error instanceof Error ? error.message : String(error)}`);
			}).finally(() => {
				this.running--;
				this.activeRuns.delete(active);
				void this.pump();
			});
			this.activeRuns.add(active);
			void active;
		}
	}

	private submitForAdmission(task: ManagedTask): void {
		const controller = new AbortController();
		task.controller = controller;
		const active = this.admit!(task.ownerKey, async () => {
			if (TERMINAL.has(task.status)) return;
			this.running++;
			try { await this.run(task, controller); }
			finally { this.running--; }
		}, controller.signal).catch((error) => {
			if (TERMINAL.has(task.status)) return;
			const message = error instanceof Error ? error.message : String(error);
			this.finish(task, task.stopReason === "cancelled" ? "cancelled" : "failed", undefined, message);
		}).finally(() => {
			task.controller = undefined;
			this.activeRuns.delete(active);
		});
		this.activeRuns.add(active);
		void active;
	}

	private async run(task: ManagedTask, suppliedController?: AbortController): Promise<void> {
		if (this.taskLedger && this.verify && typeof this.taskLedger.recordPlan === "function") return this.runVerifiedTask(task, suppliedController);
		task.status = "running";
		task.startedAt = Date.now();
		this.taskLedger?.transition(task.id, { status: "running", startedAt: task.startedAt });
		task.runId = crypto.randomUUID();
		task.taskRunId = task.runId;
		this.taskLedger?.recordRun({ id: task.runId, taskId: task.id, executor: "subagent", status: "running", startedAt: task.startedAt, ...(this.defaultTimeoutMs > 0 ? { leaseExpiresAt: task.startedAt + this.defaultTimeoutMs + EXECUTION_LEASE_GRACE_MS } : {}) });
		task.controller = suppliedController ?? new AbortController();
		const timer = this.defaultTimeoutMs > 0 ? setTimeout(() => {
			task.stopReason = "timeout";
			task.controller?.abort();
		}, this.defaultTimeoutMs) : undefined;
		task.timeoutTimer = timer;
		try {
			const result = await this.execute(task, task.controller.signal);
			if (task.stopReason === "cancelled") this.finish(task, "cancelled", undefined, "Cancelled by parent Agent");
			else if (task.stopReason === "timeout") this.finish(task, "failed", undefined, "Sub-Agent task timed out");
			else this.finish(task, "completed", result);
		} catch (error) {
			if (task.stopReason === "cancelled") this.finish(task, "cancelled", undefined, "Cancelled by parent Agent");
			else if (task.stopReason === "timeout") this.finish(task, "failed", undefined, "Sub-Agent task timed out");
			else this.finish(task, "failed", undefined, error instanceof Error ? error.message : String(error));
		} finally {
			if (timer) clearTimeout(timer);
			if (task.timeoutTimer === timer) task.timeoutTimer = undefined;
			if (!suppliedController) task.controller = undefined;
		}
	}

	private async runVerifiedTask(task: ManagedTask, suppliedController?: AbortController): Promise<void> {
		task.status = "running";
		task.startedAt = Date.now();
		task.controller = suppliedController ?? new AbortController();
		const timer = this.defaultTimeoutMs > 0 ? setTimeout(() => { task.stopReason = "timeout"; task.controller?.abort(); }, this.defaultTimeoutMs) : undefined;
		task.timeoutTimer = timer;
		try {
			const result = await new TaskGraph(this.taskLedger!).run([task.ownerKey], `delegation:${task.id}`, async (_record, signal, context) => {
				task.runId = context!.taskRunId;
				task.taskRunId = context!.taskRunId;
				return { output: await this.execute(task, signal ?? task.controller!.signal) };
			}, { maxConcurrent: 1, maxCorrectiveAttempts: this.maxCorrectiveAttempts, signal: task.controller.signal, executor: "subagent", verify: this.verify });
			const durable = this.taskLedger!.queryTasks({ ownerKeys: [task.ownerKey], id: task.id, limit: 1 })[0];
			if (durable?.status === "succeeded") this.finish(task, "completed", durable.result, undefined, false);
			else if (durable?.status === "cancelled" || task.stopReason === "cancelled") this.finish(task, "cancelled", undefined, durable?.error ?? "Cancelled by parent Agent", false);
			else if (durable?.status === "failed" || task.stopReason === "timeout") this.finish(task, "failed", undefined, durable?.error ?? "Sub-Agent task failed", false);
			else if (result.blocked.length) for (const waiter of [...task.waiters]) waiter();
		} catch (error) {
			const durable = this.taskLedger!.queryTasks({ ownerKeys: [task.ownerKey], id: task.id, limit: 1 })[0];
			if (durable?.status === "cancelled" || task.stopReason === "cancelled") this.finish(task, "cancelled", undefined, durable?.error ?? "Cancelled by parent Agent", false);
			else this.finish(task, "failed", undefined, error instanceof Error ? error.message : String(error), false);
		} finally {
			if (timer) clearTimeout(timer);
			if (task.timeoutTimer === timer) task.timeoutTimer = undefined;
			if (!suppliedController) task.controller = undefined;
		}
	}

	private finish(task: ManagedTask, status: SubagentTaskStatus, result?: string, error?: string, persist = true): void {
		if (TERMINAL.has(task.status)) return;
		task.status = status;
		task.finishedAt = Date.now();
		task.completionOrder = ++this.completionSequence;
		task.result = result?.slice(0, 50_000);
		task.error = error;
		const transition = {
			status: taskLedgerStatus(status),
			finishedAt: task.finishedAt,
			...(task.result === undefined ? {} : { result: task.result }),
			...(task.error === undefined ? {} : { error: task.error }),
		};
		try { if (persist) this.taskLedger?.transition(task.id, transition); }
		finally {
			try {
				if (persist && task.runId) this.taskLedger?.transitionRun(task.runId, {
					status: taskRunStatus(status),
					finishedAt: task.finishedAt,
					...(task.result === undefined ? {} : { output: task.result }),
					...(task.error === undefined ? {} : { error: task.error }),
				});
			} finally { for (const waiter of [...task.waiters]) waiter(); this.pruneTerminalTasks(); }
		}
	}

	private pruneTerminalTasks(): void {
		const terminal = [...this.tasks.values()].filter((task) => TERMINAL.has(task.status)).sort((a, b) => (b.completionOrder ?? 0) - (a.completionOrder ?? 0));
		for (const task of terminal.slice(this.maxRetainedTerminalTasks)) this.tasks.delete(task.id);
	}

	private ownedTask(source: BeeMaxRuntimeSource, id: string): ManagedTask {
		const task = this.tasks.get(id);
		if (!task || task.ownerKey !== responsibilityOwnerKey(source)) throw new Error(`Sub-Agent task not found: ${id}`);
		return task;
	}

	private durableSnapshot(source: BeeMaxRuntimeSource, id: string): SubagentTaskSnapshot | undefined {
		const task = this.taskLedger?.queryTasks({ ownerKeys: responsibilityOwnerKeys(source), id, kinds: ["delegated"], limit: 1 })[0];
		if (!task || (task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled")) return undefined;
		return {
			id: task.id, name: task.title, goal: task.description ?? task.title, capability: "analysis",
			status: task.status === "succeeded" ? "completed" : task.status, createdAt: task.createdAt,
			timeoutMs: this.defaultTimeoutMs, startedAt: task.startedAt, finishedAt: task.finishedAt, result: task.result, error: task.error,
		};
	}

	private removeFromQueue(id: string): void {
		const index = this.queue.indexOf(id);
		if (index >= 0) this.queue.splice(index, 1);
	}

	private prune(ownerKey: string): void {
		const completed = [...this.tasks.values()]
			.filter((task) => task.ownerKey === ownerKey && TERMINAL.has(task.status))
			.sort((a, b) => b.createdAt - a.createdAt);
		for (const task of completed.slice(50)) this.tasks.delete(task.id);
	}
}

export function createSubagentTools(manager: SubagentManager, source: BeeMaxRuntimeSource, options: { objectiveTaskId?: () => string | undefined } = {}): ToolDefinition[] {
	const tools = [
		defineTool({
			name: "task_spawn",
			label: "Spawn Sub-Agent",
			description: "Start one isolated, read-only Sub-Agent task. Returns immediately with a task ID.",
			parameters: Type.Object({
				goal: Type.String({ minLength: 1, maxLength: 10_000 }),
				context: Type.Optional(Type.String({ maxLength: 20_000 })),
				acceptanceCriteria: Type.Optional(Type.String({ minLength: 1, maxLength: 5_000 })),
				name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
				capability: Type.Optional(StringEnum(["analysis", "research"] as const)),
			}),
			execute: async (_id, params) => toolResult(manager.spawn(source, { ...params, parentId: options.objectiveTaskId?.() })),
		}),
		defineTool({
			name: "task_status",
			label: "Sub-Agent Status",
			description: "Inspect one Sub-Agent task or list recent tasks for this conversation.",
			parameters: Type.Object({ id: Type.Optional(Type.String()) }),
			execute: async (_id, params) => toolResult(params.id ? manager.get(source, params.id) : manager.list(source)),
		}),
		defineTool({
			name: "task_wait",
			label: "Wait for Sub-Agent",
			description: "Wait for a Sub-Agent completion event for up to 120 seconds.",
			parameters: Type.Object({ id: Type.String(), timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 120_000 })) }),
			execute: async (_id, params, signal) => toolResult(await manager.wait(source, params.id, params.timeoutMs, signal)),
		}),
		defineTool({
			name: "task_cancel",
			label: "Cancel Sub-Agent",
			description: "Cancel one queued or running Sub-Agent task owned by this conversation.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, params) => toolResult(manager.cancel(source, params.id)),
		}),
	];
	const localControl: ToolPolicy = { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "low", approval: "never", reversible: true, impact: "Changes only the current conversation's bounded Sub-Agent tasks" };
	const policies: Record<string, ToolPolicy> = {
		task_spawn: { ...localControl, risk: "medium", impact: "Starts one bounded read-only Sub-Agent task" },
		task_status: { ...READ_ONLY_TOOL_POLICY },
		task_wait: { ...READ_ONLY_TOOL_POLICY, timeoutMs: 130_000, maxAttempts: 1, impact: "Waits for an existing Sub-Agent without changing its state" },
		task_cancel: { ...localControl, reversible: false, impact: "Cancels one bounded Sub-Agent task in the current conversation" },
	};
	return tools.map((tool) => withToolPolicy(tool, policies[tool.name]!));
}

function snapshot(task: ManagedTask): SubagentTaskSnapshot {
	return {
		id: task.id,
		name: task.name,
		goal: task.goal,
		capability: task.capability,
		status: task.status,
		createdAt: task.createdAt,
		timeoutMs: task.timeoutMs,
		startedAt: task.startedAt,
		taskRunId: task.taskRunId,
		finishedAt: task.finishedAt,
		result: task.result,
		error: task.error,
	};
}

function summarySnapshot(task: ManagedTask): SubagentTaskSnapshot {
	return {
		...snapshot(task),
		goal: task.goal.length > 300 ? `${task.goal.slice(0, 300)}…` : task.goal,
		result: undefined,
	};
}

function toolResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

function positiveInt(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function taskLedgerStatus(status: SubagentTaskStatus): TaskStatus {
	if (status === "completed") return "succeeded";
	if (status === "queued") return "pending";
	return status;
}

function taskRunStatus(status: SubagentTaskStatus): TaskRunStatus {
	if (status === "completed") return "succeeded";
	if (status === "failed") return "failed";
	return "cancelled";
}

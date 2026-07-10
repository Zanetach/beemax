import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { SessionSource } from "./types.ts";
import { sessionKeyForSource } from "./session-router.ts";

export type SubagentTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SubagentTaskSnapshot {
	id: string;
	name: string;
	goal: string;
	capability: "analysis" | "research";
	status: SubagentTaskStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	result?: string;
	error?: string;
}

export interface SubagentTask extends SubagentTaskSnapshot {
	ownerKey: string;
	source: SessionSource;
	context?: string;
}

export type SubagentExecutor = (task: SubagentTask, signal: AbortSignal) => Promise<string>;

interface ManagedTask extends SubagentTask {
	controller?: AbortController;
	stopReason?: "cancelled" | "timeout";
	waiters: Set<() => void>;
}

export interface SubagentManagerOptions {
	maxConcurrent?: number;
	maxChildrenPerOwner?: number;
	defaultTimeoutMs?: number;
	execute: SubagentExecutor;
}

const TERMINAL = new Set<SubagentTaskStatus>(["completed", "failed", "cancelled"]);

export class SubagentManager {
	private readonly tasks = new Map<string, ManagedTask>();
	private readonly queue: string[] = [];
	private readonly maxConcurrent: number;
	private readonly maxChildrenPerOwner: number;
	private readonly defaultTimeoutMs: number;
	private readonly execute: SubagentExecutor;
	private running = 0;
	private disposed = false;

	constructor(options: SubagentManagerOptions) {
		this.maxConcurrent = positiveInt(options.maxConcurrent, 3);
		this.maxChildrenPerOwner = positiveInt(options.maxChildrenPerOwner, 5);
		this.defaultTimeoutMs = Math.max(0, options.defaultTimeoutMs ?? 15 * 60_000);
		this.execute = options.execute;
	}

	spawn(source: SessionSource, input: {
		name?: string;
		goal: string;
		context?: string;
		capability?: "analysis" | "research";
	}): SubagentTaskSnapshot {
		if (this.disposed) throw new Error("Sub-Agent manager is shutting down");
		const ownerKey = sessionKeyForSource(source);
		const active = [...this.tasks.values()].filter((task) => task.ownerKey === ownerKey && !TERMINAL.has(task.status));
		if (active.length >= this.maxChildrenPerOwner) {
			throw new Error(`This conversation already has ${this.maxChildrenPerOwner} active Sub-Agent tasks`);
		}
		this.prune(ownerKey);
		const id = crypto.randomUUID();
		const task: ManagedTask = {
			id,
			ownerKey,
			source: { ...source },
			name: input.name?.trim() || `task-${id.slice(0, 8)}`,
			goal: input.goal.trim(),
			context: input.context?.trim() || undefined,
			capability: input.capability ?? "analysis",
			status: "queued",
			createdAt: Date.now(),
			waiters: new Set(),
		};
		if (!task.goal) throw new Error("Sub-Agent goal is required");
		this.tasks.set(id, task);
		this.queue.push(id);
		void this.pump();
		return snapshot(task);
	}

	list(source: SessionSource): SubagentTaskSnapshot[] {
		const ownerKey = sessionKeyForSource(source);
		return [...this.tasks.values()]
			.filter((task) => task.ownerKey === ownerKey)
			.sort((a, b) => b.createdAt - a.createdAt)
			.map(summarySnapshot);
	}

	get(source: SessionSource, id: string): SubagentTaskSnapshot {
		return snapshot(this.ownedTask(source, id));
	}

	async wait(source: SessionSource, id: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<SubagentTaskSnapshot> {
		const task = this.ownedTask(source, id);
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

	cancel(source: SessionSource, id: string): SubagentTaskSnapshot {
		const task = this.ownedTask(source, id);
		if (TERMINAL.has(task.status)) return snapshot(task);
		task.stopReason = "cancelled";
		if (task.status === "queued") {
			this.removeFromQueue(id);
			this.finish(task, "cancelled", undefined, "Cancelled by parent Agent");
		} else {
			task.controller?.abort();
		}
		return snapshot(task);
	}

	cancelOwner(source: SessionSource): number {
		let cancelled = 0;
		for (const task of this.tasks.values()) {
			if (task.ownerKey === sessionKeyForSource(source) && !TERMINAL.has(task.status)) {
				this.cancel(source, task.id);
				cancelled++;
			}
		}
		return cancelled;
	}

	dispose(): void {
		this.disposed = true;
		for (const task of this.tasks.values()) {
			if (!TERMINAL.has(task.status)) {
				task.stopReason = "cancelled";
				task.controller?.abort();
				if (task.status === "queued") this.finish(task, "cancelled", undefined, "Gateway is shutting down");
			}
		}
		this.queue.length = 0;
	}

	private async pump(): Promise<void> {
		while (!this.disposed && this.running < this.maxConcurrent) {
			const id = this.queue.shift();
			if (!id) return;
			const task = this.tasks.get(id);
			if (!task || task.status !== "queued") continue;
			this.running++;
			void this.run(task).finally(() => {
				this.running--;
				void this.pump();
			});
		}
	}

	private async run(task: ManagedTask): Promise<void> {
		task.status = "running";
		task.startedAt = Date.now();
		task.controller = new AbortController();
		const timer = this.defaultTimeoutMs > 0 ? setTimeout(() => {
			task.stopReason = "timeout";
			task.controller?.abort();
		}, this.defaultTimeoutMs) : undefined;
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
			task.controller = undefined;
		}
	}

	private finish(task: ManagedTask, status: SubagentTaskStatus, result?: string, error?: string): void {
		task.status = status;
		task.finishedAt = Date.now();
		task.result = result?.slice(0, 50_000);
		task.error = error;
		for (const waiter of [...task.waiters]) waiter();
	}

	private ownedTask(source: SessionSource, id: string): ManagedTask {
		const task = this.tasks.get(id);
		if (!task || task.ownerKey !== sessionKeyForSource(source)) throw new Error(`Sub-Agent task not found: ${id}`);
		return task;
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

export function createSubagentTools(manager: SubagentManager, source: SessionSource): ToolDefinition[] {
	return [
		defineTool({
			name: "task_spawn",
			label: "Spawn Sub-Agent",
			description: "Start one isolated, read-only Sub-Agent task. Returns immediately with a task ID.",
			parameters: Type.Object({
				goal: Type.String({ minLength: 1, maxLength: 10_000 }),
				context: Type.Optional(Type.String({ maxLength: 20_000 })),
				name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
				capability: Type.Optional(StringEnum(["analysis", "research"] as const)),
			}),
			execute: async (_id, params) => toolResult(manager.spawn(source, params)),
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
}

function snapshot(task: ManagedTask): SubagentTaskSnapshot {
	return {
		id: task.id,
		name: task.name,
		goal: task.goal,
		capability: task.capability,
		status: task.status,
		createdAt: task.createdAt,
		startedAt: task.startedAt,
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

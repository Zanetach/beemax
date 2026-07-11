import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { conversationKey } from "./agent-scope.ts";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { TaskGraph, type TaskGraphExecutor, type TaskGraphVerifier } from "./task-graph.ts";
import type { TaskLedger } from "./task-ledger.ts";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, withToolPolicy, type ToolPolicy } from "./tool-runtime.ts";
import { TaskPlanRuntime } from "./task-plan-runtime.ts";

export interface TaskOrchestrationOptions { maxConcurrent?: number; maxTasks?: number; maxCorrectiveAttempts?: number; planRuntime?: TaskPlanRuntime; verify?: TaskGraphVerifier; }

/** Model-facing structured planning seam; Core owns validation and execution. */
export function createTaskOrchestrationTools(
	ledger: TaskLedger,
	source: BeeMaxRuntimeSource,
	execute: TaskGraphExecutor,
	options: TaskOrchestrationOptions = {},
): ToolDefinition[] {
	const graph = new TaskGraph(ledger);
	const ownerKey = conversationKey(source);
	const maxTasks = Math.max(2, Math.min(Math.trunc(options.maxTasks ?? 12), 20));
	const maxConcurrent = Math.max(1, Math.min(Math.trunc(options.maxConcurrent ?? 3), 10));
	const maxCorrectiveAttempts = Math.max(0, Math.min(Math.trunc(options.maxCorrectiveAttempts ?? 1), 2));
	const planRuntime = options.planRuntime ?? new TaskPlanRuntime();
	const executeTool = defineTool({
		name: "task_plan_execute",
		label: "Plan and Execute Tasks",
		description: "Create a validated Task DAG and execute independent nodes in parallel with isolated read-only Sub-Agents. Every result must pass independent verification against observable Acceptance Criteria. Use only for 2 or more substantial independent work items.",
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				key: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" }),
				title: Type.String({ minLength: 1, maxLength: 120 }),
				goal: Type.String({ minLength: 1, maxLength: 10_000 }),
				acceptanceCriteria: Type.String({ minLength: 1, maxLength: 5_000 }),
			}), { minItems: 2, maxItems: maxTasks }),
			dependencies: Type.Optional(Type.Array(Type.Object({
				task: Type.String({ minLength: 1, maxLength: 32 }),
				dependsOn: Type.String({ minLength: 1, maxLength: 32 }),
			}), { maxItems: maxTasks * maxTasks })),
		}),
		execute: async (_callId, params, signal) => {
			const planId = crypto.randomUUID();
			const ids = new Map(params.tasks.map((task) => [task.key, `${planId}:${task.key}`]));
			const dependencies = (params.dependencies ?? []).map((edge) => {
				const taskId = ids.get(edge.task);
				const dependsOn = ids.get(edge.dependsOn);
				if (!taskId || !dependsOn) throw new Error(`Task dependency references an unknown key: ${edge.task} -> ${edge.dependsOn}`);
				return { taskId, dependsOn };
			});
			graph.createPlan({
				id: planId, ownerKey,
				tasks: params.tasks.map((task) => ({ id: ids.get(task.key)!, title: task.title, description: task.goal, acceptanceCriteria: task.acceptanceCriteria, kind: "delegated" as const, recoveryPolicy: "safe_retry" as const, idempotencyKey: `${planId}:${task.key}`, executionScope: { ...source } })),
				dependencies,
			});
			const summary = await planRuntime.run(ownerKey, planId, signal, (planSignal) => graph.run([ownerKey], planId, execute, { maxConcurrent, maxCorrectiveAttempts, signal: planSignal, executor: "subagent", verify: options.verify }));
			return result({ planId, ...summary, tasks: ledger.queryTasks({ ownerKeys: [ownerKey], planIds: [planId], limit: maxTasks }) });
		},
	});
	const statusTool = defineTool({
		name: "task_plan_status", label: "Task Plan Status", description: "Inspect one Task Plan owned by this conversation.",
		parameters: Type.Object({ planId: Type.String({ minLength: 1, maxLength: 128 }) }),
		execute: async (_callId, params) => {
			const tasks = ledger.queryTasks({ ownerKeys: [ownerKey], planIds: [params.planId], limit: maxTasks });
			if (!tasks.length) throw new Error(`Task Plan not found: ${params.planId}`);
			return result({ planId: params.planId, tasks, dependencies: ledger.taskDependencies(tasks.map((task) => task.id)) });
		},
	});
	const executePolicy: ToolPolicy = {
		...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "medium", approval: "never", reversible: false,
		timeoutMs: 60 * 60_000, maxAttempts: 1,
		impact: "Creates a bounded durable Task Plan and runs isolated read-only Sub-Agents",
	};
	return [
		withToolPolicy(executeTool, executePolicy),
		withToolPolicy(statusTool, { ...READ_ONLY_TOOL_POLICY, impact: "Reads one durable Task Plan without changing it" }),
	];
}

function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value }; }

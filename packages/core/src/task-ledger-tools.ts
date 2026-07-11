import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { conversationKey, conversationOwnerKey } from "./agent-scope.ts";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import type { TaskLedger, TaskQuery } from "./task-ledger.ts";
import { READ_ONLY_TOOL_POLICY, withToolPolicy } from "./tool-runtime.ts";

/** Read-only durable Task discovery shared by every Agent surface. */
export function createTaskLedgerTools(ledger: TaskLedger, source: BeeMaxRuntimeSource): ToolDefinition[] {
	const ownerKeys = [...new Set([conversationKey(source), conversationOwnerKey(source), "profile"])];
	const query = (input: Omit<TaskQuery, "ownerKeys"> = {}) => ledger.queryTasks({ ...input, ownerKeys });
	const owned = (id: string) => {
		const task = query({ id, limit: 1 })[0];
		if (!task) throw new Error(`Task not found: ${id}`);
		return task;
	};
	const tools = [
		defineTool({
			name: "task_plan_list", label: "List Task Plans", description: "List durable Task Plan Outcomes visible to this conversation.",
			parameters: Type.Object({
				status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")])),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
			}),
			execute: async (_id, params) => result(ledger.queryTaskPlans({ ownerKeys, statuses: params.status ? [params.status] : undefined, limit: params.limit })),
		}),
		defineTool({
			name: "task_plan_get", label: "Get Task Plan", description: "Inspect one durable Task Plan Outcome visible to this conversation.",
			parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) }),
			execute: async (_id, params) => {
				const plan = ledger.queryTaskPlans({ ownerKeys, id: params.id, limit: 1 })[0];
				if (!plan) throw new Error(`Task Plan not found: ${params.id}`);
				return result(plan);
			},
		}),
		defineTool({
			name: "task_list", label: "List Tasks", description: "List durable objective, delegated, and automation Tasks visible to this conversation.",
			parameters: Type.Object({
				kind: Type.Optional(Type.Union([Type.Literal("objective"), Type.Literal("delegated"), Type.Literal("automation")])),
				status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")])),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
			}),
			execute: async (_id, params) => result(query({ kinds: params.kind ? [params.kind] : undefined, statuses: params.status ? [params.status] : undefined, limit: params.limit })),
		}),
		defineTool({
			name: "task_get", label: "Get Task", description: "Inspect one durable Task visible to this conversation.",
			parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) }),
			execute: async (_id, params) => result(owned(params.id)),
		}),
		defineTool({
			name: "task_runs", label: "List Task Runs", description: "List execution attempts for one durable Task visible to this conversation.",
			parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) }),
			execute: async (_id, params) => { owned(params.id); return result(ledger.taskRuns(params.id)); },
		}),
	];
	return tools.map((tool) => withToolPolicy(tool, { ...READ_ONLY_TOOL_POLICY, impact: "Reads durable Task lifecycle without changing execution state" }));
}

function result(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

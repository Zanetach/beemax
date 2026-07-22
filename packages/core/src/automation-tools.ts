/** Core-owned Agent tools over the Automation persistence capability. */
import type { AutomationOwner, AutomationStore } from "@thruvera/automation";
import { conversationIdentity } from "./agent-scope.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThruveraRuntimeSource } from "./runtime.ts";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, withToolPolicy, type ToolPolicy } from "./tool-runtime.ts";

export function createAutomationTools(store: AutomationStore, source: ThruveraRuntimeSource, wakeScheduler: () => void): ToolDefinition[] {
	const owner = (): AutomationOwner => {
		const { platform, channelInstanceId, chatId, userId } = conversationIdentity(source);
		return { platform, ...(channelInstanceId ? { channelInstanceId } : {}), chatId, chatType: source.chatType, userId };
	};
	const tools = [
		defineTool({ name: "reminder_create", label: "Create Reminder", description: "Create a persistent one-shot reminder delivered to the current chat. Use an ISO timestamp with timezone or relative duration like 20m.", parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), when: Type.String({ description: "ISO 8601 timestamp with timezone, or duration like 20m/2h/1d" }), text: Type.String({ minLength: 1, maxLength: 20_000 }) }), execute: async (_id, params) => {
			const job = store.create({ ...owner(), name: params.name, kind: "reminder", scheduleKind: "at", schedule: params.when, text: params.text }); wakeScheduler(); return result(`Reminder created for ${new Date(job.nextRunAt).toISOString()}`, job);
		} }),
		defineTool({ name: "schedule_create", label: "Create Schedule", description: "Create a persistent recurring reminder or isolated read-only Agent Schedule. Supports fixed intervals and cron expressions.", parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), kind: StringEnum(["reminder", "agent"] as const), scheduleKind: StringEnum(["every", "cron"] as const), schedule: Type.String({ description: "Duration like 30m/2h/1d, or a 5/6-field cron expression" }), text: Type.String({ minLength: 1, maxLength: 20_000, description: "Reminder text or Agent prompt" }), timezone: Type.Optional(Type.String({ description: "IANA timezone for cron, e.g. Asia/Shanghai" })), maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), misfirePolicy: Type.Optional(StringEnum(["skip", "run_once"] as const)), misfireGraceMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 604_800_000 })) }), execute: async (_id, params) => {
			const job = store.create({ ...owner(), ...params }); wakeScheduler(); return result(`Scheduled task created; next run ${new Date(job.nextRunAt).toISOString()}`, job);
		} }),
		defineTool({ name: "schedule_get", label: "Get Schedule", description: "Inspect one owned Schedule and its current runtime policy.", parameters: Type.Object({ id: Type.String() }), execute: async (_id, params) => {
			const job = store.get(params.id, owner()); return result(job ? formatJob(job) : "Schedule not found", job ?? { id: params.id });
		} }),
		defineTool({ name: "schedule_list", label: "List Scheduled Tasks", description: "List reminders and scheduled agent tasks owned by this user/chat.", parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), execute: async (_id, params) => {
			const jobs = store.list(owner(), params.limit ?? 50); return result(jobs.length ? jobs.map(formatJob).join("\n") : "No scheduled tasks.", jobs);
		} }),
		defineTool({ name: "schedule_pause", label: "Pause Scheduled Task", description: "Pause a scheduled task.", parameters: Type.Object({ id: Type.String() }), execute: async (_id, params) => result(store.setEnabled(params.id, false, owner()) ? `Paused ${params.id}` : "Task not found", { id: params.id }) }),
		defineTool({ name: "schedule_resume", label: "Resume Scheduled Task", description: "Resume a scheduled task and compute its next occurrence.", parameters: Type.Object({ id: Type.String() }), execute: async (_id, params) => { const enabled = store.setEnabled(params.id, true, owner()); if (enabled) wakeScheduler(); return result(enabled ? `Resumed ${params.id}` : "Task not found", { id: params.id }); } }),
		defineTool({ name: "schedule_update", label: "Update Schedule", description: "Update an owned Schedule and recompute its next occurrence when timing changes.", parameters: Type.Object({ id: Type.String(), name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), kind: Type.Optional(StringEnum(["reminder", "agent"] as const)), scheduleKind: Type.Optional(StringEnum(["at", "every", "cron"] as const)), schedule: Type.Optional(Type.String()), text: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })), timezone: Type.Optional(Type.String()), maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), misfirePolicy: Type.Optional(StringEnum(["skip", "run_once"] as const)), misfireGraceMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 604_800_000 })) }), execute: async (_id, params) => {
			const { id, ...patch } = params; const job = store.update(id, patch, owner()); wakeScheduler(); return result(`Updated ${id}; next run ${new Date(job.nextRunAt).toISOString()}`, job);
		} }),
		defineTool({ name: "schedule_run_now", label: "Run Schedule Now", description: "Create an immediate due occurrence for an owned Schedule without bypassing normal execution governance.", parameters: Type.Object({ id: Type.String() }), execute: async (_id, params) => {
			const changed = store.runNow(params.id, owner()); if (changed) wakeScheduler(); return result(changed ? `Scheduled ${params.id} to run now` : "Schedule not found, paused, already queued manually, or currently running", { id: params.id });
		} }),
		defineTool({ name: "schedule_status", label: "Schedule Status", description: "Inspect Profile scheduler health, due work, active claims, retries, and delivery backlog.", parameters: Type.Object({}), execute: async () => result("Scheduler status", store.status()) }),
		defineTool({ name: "schedule_delete", label: "Delete Scheduled Task", description: "Permanently delete a reminder or scheduled task.", parameters: Type.Object({ id: Type.String() }), execute: async (_id, params) => result(store.remove(params.id, owner()) ? `Deleted ${params.id}` : "Task not found", { id: params.id }) }),
		defineTool({ name: "schedule_runs", label: "Scheduled Task Runs", description: "Show recent execution history for a scheduled task.", parameters: Type.Object({ id: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), execute: async (_id, params) => {
			const runs = store.runs(params.id, owner(), params.limit ?? 20); return result(runs.length ? runs.map((run) => `- ${new Date(run.startedAt).toISOString()} ${run.status}${run.error ? `: ${run.error}` : ""}`).join("\n") : "No run history.", runs);
		} }),
	];
	const changeSchedule: ToolPolicy = { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "medium", reversible: true, impact: "Changes a Profile-scoped reminder or scheduled task" };
	const policies: Record<string, ToolPolicy> = {
		reminder_create: changeSchedule,
		schedule_create: changeSchedule,
		schedule_get: { ...READ_ONLY_TOOL_POLICY },
		schedule_list: { ...READ_ONLY_TOOL_POLICY },
		schedule_pause: changeSchedule,
		schedule_resume: changeSchedule,
		schedule_update: changeSchedule,
		schedule_run_now: changeSchedule,
		schedule_status: { ...READ_ONLY_TOOL_POLICY },
		schedule_delete: { ...changeSchedule, risk: "high", reversible: false, impact: "Permanently deletes a Profile-scoped scheduled task" },
		schedule_runs: { ...READ_ONLY_TOOL_POLICY },
	};
	return tools.map((tool) => withToolPolicy(tool, policies[tool.name]!));
}
function formatJob(job: { id:string; name:string; enabled:boolean; kind:string; scheduleKind:string; schedule:string; nextRunAt:number }): string { return `- [${job.id}] ${job.enabled ? "enabled" : "paused"} ${job.name} (${job.kind}, ${job.scheduleKind}:${job.schedule}) next=${new Date(job.nextRunAt).toISOString()}`; }
function result(text: string, details: unknown) { return { content: [{ type: "text" as const, text }], details }; }

/** Explicit long-term-memory tools for a personal assistant. */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionSource } from "./types.ts";

export interface MemoryToolRecord {
	id: string;
	content: string;
	createdAt: number;
	role: "user" | "assistant" | "memory";
}

export interface MemoryToolStore {
	remember(record: {
		platform: string;
		chatId: string;
		userId?: string;
		role: "memory";
		content: string;
	}): string;
	recall(query: string, options: {
		limit: number;
		platform: string;
		chatId: string;
		userId?: string;
	}): MemoryToolRecord[];
	list(options: { limit: number; platform: string; chatId: string; userId?: string }): MemoryToolRecord[];
	forget(id: string, options: { platform: string; chatId: string; userId?: string }): boolean;
	listCandidates(options: { limit: number; platform: string; chatId: string; userId?: string }): MemoryToolRecord[];
	promoteCandidate(id: string, options: { platform: string; chatId: string; userId?: string }): boolean;
	rejectCandidate(id: string, options: { platform: string; chatId: string; userId?: string }): boolean;
	stats(options: { platform: string; chatId: string; userId?: string }): { curated: number; pending: number; promoted: number; rejected: number };
}

export function createMemoryTools(store: MemoryToolStore, source: SessionSource): ToolDefinition[] {
	const scope = () => ({
		platform: source.platform,
		chatId: source.chatId,
		userId: source.userIdAlt ?? source.userId,
	});

	return [
		defineTool({
			name: "memory_status",
			label: "Memory Status",
			description: "Show curated-memory and candidate-memory counts for this user scope.",
			parameters: Type.Object({}),
			execute: async () => {
				const stats = store.stats(scope());
				return text(`Curated: ${stats.curated}; pending: ${stats.pending}; promoted: ${stats.promoted}; rejected: ${stats.rejected}`, stats);
			},
		}),
		defineTool({
			name: "memory_candidates",
			label: "List Memory Candidates",
			description: "List uncurated conversation facts awaiting promotion or rejection. Read-only.",
			parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
			execute: async (_id, params) => {
				const records = store.listCandidates({ ...scope(), limit: params.limit ?? 20 });
				return text(format(records), { records });
			},
		}),
		defineTool({
			name: "memory_promote",
			label: "Promote Memory Candidate",
			description: "Promote one reviewed candidate into durable long-term memory. Requires approval.",
			parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
			execute: async (_id, params) => {
				const promoted = store.promoteCandidate(params.id, scope());
				return text(promoted ? `Promoted memory candidate ${params.id}` : `Memory candidate ${params.id} was not found`, { id: params.id, promoted });
			},
		}),
		defineTool({
			name: "memory_reject",
			label: "Reject Memory Candidate",
			description: "Reject one candidate so it is not promoted to durable memory. Requires approval.",
			parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
			execute: async (_id, params) => {
				const rejected = store.rejectCandidate(params.id, scope());
				return text(rejected ? `Rejected memory candidate ${params.id}` : `Memory candidate ${params.id} was not found`, { id: params.id, rejected });
			},
		}),
		defineTool({
			name: "memory_remember",
			label: "Remember",
			description: "Save a durable user fact, preference, decision, relationship, or recurring workflow. Do not save secrets or transient details.",
			parameters: Type.Object({ content: Type.String({ minLength: 1, maxLength: 2000 }) }),
			execute: async (_id, params) => {
				const id = store.remember({ ...scope(), role: "memory", content: params.content.trim() });
				return text(`Remembered as ${id}`, { id, content: params.content.trim() });
			},
		}),
		defineTool({
			name: "memory_recall",
			label: "Recall Memory",
			description: "Search durable memories and prior exchanges for relevant personal context.",
			parameters: Type.Object({
				query: Type.String({ minLength: 1, maxLength: 1000 }),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
			}),
			execute: async (_id, params) => {
				const records = store.recall(params.query, { ...scope(), limit: params.limit ?? 8 });
				return text(format(records), { records });
			},
		}),
		defineTool({
			name: "memory_list",
			label: "List Memories",
			description: "List the user's most recent explicitly curated durable memories.",
			parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
			execute: async (_id, params) => {
				const records = store.list({ ...scope(), limit: params.limit ?? 20 });
				return text(format(records), { records });
			},
		}),
		defineTool({
			name: "memory_forget",
			label: "Forget Memory",
			description: "Permanently delete one explicitly curated memory by ID. Requires approval.",
			parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
			execute: async (_id, params) => {
				const deleted = store.forget(params.id, scope());
				return text(deleted ? `Forgot memory ${params.id}` : `Memory ${params.id} was not found in this user scope`, {
					id: params.id,
					deleted,
				});
			},
		}),
	];
}

function format(records: MemoryToolRecord[]): string {
	if (records.length === 0) return "No matching memories.";
	return records.map((record) => `- [${record.id}] ${record.content}`).join("\n");
}

function text(value: string, details: unknown) {
	return { content: [{ type: "text" as const, text: value }], details };
}

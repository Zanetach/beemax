/** Agent-facing memory capability. Persistent policy remains in BeeMax Core. */
import { defineTool, type BeeMaxRuntimeSource, type ToolDefinition } from "@beemax/core";
import { Type } from "typebox";
import type { ClaimInput, MemoryClaim, MemoryEvidence } from "./store.ts";

export interface MemoryToolRecord {
	id: string;
	content: string;
	createdAt: number;
	role: "user" | "assistant" | "memory";
}

export interface MemoryToolStore {
	remember(record: { platform: string; chatId: string; userId?: string; role: "memory"; content: string }): string;
	recall(query: string, options: { limit: number; platform: string; chatId: string; userId?: string }): MemoryToolRecord[];
	list(options: { limit: number; platform: string; chatId: string; userId?: string }): MemoryToolRecord[];
	forget(id: string, options: { platform: string; chatId: string; userId?: string }): boolean;
	listCandidates(options: { limit: number; platform: string; chatId: string; userId?: string }): MemoryToolRecord[];
	promoteCandidate(id: string, options: { platform: string; chatId: string; userId?: string }): boolean;
	rejectCandidate(id: string, options: { platform: string; chatId: string; userId?: string }): boolean;
	stats(options: { platform: string; chatId: string; userId?: string }): { curated: number; pending: number; promoted: number; rejected: number };
	latestEvent?(options: { platform: string; chatId: string; userId?: string }, kind?: "user"): { id: string; content: string } | undefined;
	upsertClaim?(input: ClaimInput): MemoryClaim;
	correctClaim?(id: string, replacement: Pick<ClaimInput, "statement" | "confidence" | "stability" | "expiresAt" | "evidence">, options: { platform: string; chatId: string; userId?: string }): MemoryClaim | undefined;
	explainClaim?(id: string, options: { platform: string; chatId: string; userId?: string }): { claim: MemoryClaim; evidence: MemoryEvidence[] } | undefined;
	forgetClaim?(id: string, options: { platform: string; chatId: string; userId?: string }): boolean;
}

export function createMemoryTools(store: MemoryToolStore, source: BeeMaxRuntimeSource): ToolDefinition[] {
	const scope = () => ({ platform: source.platform, chatId: source.chatId, userId: source.userIdAlt ?? source.userId });
	return [
		defineTool({ name: "memory_status", label: "Memory Status", description: "Show curated-memory and candidate-memory counts for this user scope.", parameters: Type.Object({}), execute: async () => {
			const stats = store.stats(scope()); return result(`Curated: ${stats.curated}; pending: ${stats.pending}; promoted: ${stats.promoted}; rejected: ${stats.rejected}`, stats);
		} }),
		defineTool({ name: "memory_candidates", label: "List Memory Candidates", description: "List uncurated conversation facts awaiting promotion or rejection. Read-only.", parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }), execute: async (_id, params) => {
			const records = store.listCandidates({ ...scope(), limit: params.limit ?? 20 }); return result(format(records), { records });
		} }),
		defineTool({ name: "memory_promote", label: "Promote Memory Candidate", description: "Promote one reviewed candidate into durable long-term memory. Requires approval.", parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }), execute: async (_id, params) => {
			const promoted = store.promoteCandidate(params.id, scope()); return result(promoted ? `Promoted memory candidate ${params.id}` : `Memory candidate ${params.id} was not found`, { id: params.id, promoted });
		} }),
		defineTool({ name: "memory_reject", label: "Reject Memory Candidate", description: "Reject one candidate so it is not promoted to durable memory. Requires approval.", parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }), execute: async (_id, params) => {
			const rejected = store.rejectCandidate(params.id, scope()); return result(rejected ? `Rejected memory candidate ${params.id}` : `Memory candidate ${params.id} was not found`, { id: params.id, rejected });
		} }),
		defineTool({ name: "memory_remember", label: "Remember", description: "Save a durable user fact, preference, decision, relationship, or recurring workflow. Do not save secrets or transient details.", parameters: Type.Object({ content: Type.String({ minLength: 1, maxLength: 2000 }) }), execute: async (_id, params) => {
			const content = params.content.trim(); const id = store.remember({ ...scope(), role: "memory", content }); return result(`Remembered as ${id}`, { id, content });
		} }),
		defineTool({ name: "memory_understand", label: "Record Understanding", description: "Automatically record a stable, source-backed understanding. Never use for secrets, credentials, financial or health details.", parameters: Type.Object({
			kind: Type.Union([Type.Literal("preference"), Type.Literal("fact"), Type.Literal("decision"), Type.Literal("goal"), Type.Literal("project"), Type.Literal("relationship"), Type.Literal("workflow")]),
			statement: Type.String({ minLength: 1, maxLength: 2000 }),
			confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			stability: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
		}), execute: async (_id, params) => {
			if (!store.upsertClaim || !store.latestEvent) return result("This memory store does not support source-backed understanding yet.", { supported: false });
			if (containsSensitiveMemory(params.statement)) return result("Refused to store sensitive personal data as automatic long-term memory.", { stored: false, reason: "sensitive" });
			const event = store.latestEvent(scope(), "user");
			if (!event) return result("No current user event is available as evidence.", { stored: false, reason: "missing source event" });
			const claim = store.upsertClaim({ ...scope(), kind: params.kind, statement: params.statement, confidence: params.confidence, stability: params.stability, evidence: { kind: "conversation", eventId: event.id, excerpt: event.content } });
			return result(`Recorded understanding ${claim.id}`, { claim });
		} }),
		defineTool({ name: "memory_explain", label: "Explain Memory", description: "Show why a structured memory exists, including its source evidence. Read-only.", parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }), execute: async (_id, params) => {
			const explanation = store.explainClaim?.(params.id, scope());
			return result(explanation ? `${explanation.claim.statement}\n${explanation.evidence.map(formatEvidence).join("\n")}` : `Memory understanding ${params.id} was not found`, { explanation });
		} }),
		defineTool({ name: "memory_correct", label: "Correct Memory", description: "Supersede an incorrect structured memory with a corrected version while preserving provenance. Requires approval.", parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }), statement: Type.String({ minLength: 1, maxLength: 2000 }), confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), stability: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])) }), execute: async (_id, params) => {
			const event = store.latestEvent?.(scope(), "user");
			const claim = event ? store.correctClaim?.(params.id, { statement: params.statement, confidence: params.confidence, stability: params.stability, evidence: { kind: "correction", eventId: event.id, excerpt: event.content } }, scope()) : undefined;
			return result(claim ? `Corrected memory ${params.id} as ${claim.id}` : `Memory understanding ${params.id} was not found`, { claim });
		} }),
		defineTool({ name: "memory_recall", label: "Recall Memory", description: "Search durable memories and prior exchanges for relevant personal context.", parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }), execute: async (_id, params) => {
			const records = store.recall(params.query, { ...scope(), limit: params.limit ?? 8 }); return result(format(records), { records });
		} }),
		defineTool({ name: "memory_list", label: "List Memories", description: "List the user's most recent explicitly curated durable memories.", parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }), execute: async (_id, params) => {
			const records = store.list({ ...scope(), limit: params.limit ?? 20 }); return result(format(records), { records });
		} }),
		defineTool({ name: "memory_forget", label: "Forget Memory", description: "Permanently delete one explicitly curated memory by ID. Requires approval.", parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }), execute: async (_id, params) => {
			const deleted = store.forget(params.id, scope()) || store.forgetClaim?.(params.id, scope()) || false; return result(deleted ? `Forgot memory ${params.id}` : `Memory ${params.id} was not found in this user scope`, { id: params.id, deleted });
		} }),
	];
}

function format(records: MemoryToolRecord[]): string { return records.length ? records.map((record) => `- [${record.id}] ${record.content}`).join("\n") : "No matching memories."; }
function formatEvidence(item: MemoryEvidence): string { return `- [${item.eventId ?? "manual"}] ${new Date(item.event?.occurredAt ?? item.createdAt).toISOString()}: ${item.event?.content ?? item.excerpt}`; }
function containsSensitiveMemory(value: string): boolean { return /\b(password|passcode|token|secret|api[_-]?key|private key)\b|身份证|护照|银行卡|病历|诊断/i.test(value); }
function result(text: string, details: unknown) { return { content: [{ type: "text" as const, text }], details }; }

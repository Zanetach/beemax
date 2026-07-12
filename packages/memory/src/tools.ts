/** Agent-facing memory capability. Persistent policy remains in BeeMax Core. */
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, defineTool, memoryScopeForSource, withToolPolicy, type BeeMaxRuntimeSource, type MemoryScope, type ToolDefinition, type ToolPolicy } from "@beemax/core";
import { Type } from "typebox";
import { MEMORY_CLAIM_KINDS, type ClaimInput, type MemoryClaim, type MemoryEvidence } from "./store.ts";

export interface MemoryToolRecord {
	id: string;
	content: string;
	createdAt: number;
	role: "user" | "assistant" | "memory";
}

export interface MemoryToolStore {
	remember(record: MemoryScope & { role: "memory"; content: string }): string;
	recall(query: string, options: MemoryScope & { limit: number }): MemoryToolRecord[];
	list(options: MemoryScope & { limit: number }): MemoryToolRecord[];
	forget(id: string, options: MemoryScope): boolean;
	listCandidates(options: MemoryScope & { limit: number }): MemoryToolRecord[];
	promoteCandidate(id: string, options: MemoryScope): boolean;
	rejectCandidate(id: string, options: MemoryScope): boolean;
	stats(options: MemoryScope): { curated: number; pending: number; promoted: number; rejected: number };
	latestEvent?(options: MemoryScope, kind?: "user"): { id: string; content: string } | undefined;
	upsertClaim?(input: ClaimInput): MemoryClaim;
	correctClaim?(id: string, replacement: Pick<ClaimInput, "statement" | "confidence" | "stability" | "expiresAt" | "evidence">, options: MemoryScope): MemoryClaim | undefined;
	explainClaim?(id: string, options: MemoryScope): { claim: MemoryClaim; evidence: MemoryEvidence[] } | undefined;
	forgetClaim?(id: string, options: MemoryScope): boolean;
}

export function createMemoryTools(store: MemoryToolStore, source: BeeMaxRuntimeSource, trustedScope: Pick<MemoryScope, "profileId" | "projectId" | "organizationId"> = {}): ToolDefinition[] {
	const scope = () => memoryScopeForSource(source, trustedScope);
	const tools = [
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
			const content = params.content.trim();
			if (containsSensitiveMemory(content)) return result("Refused to store sensitive personal or credential data in long-term memory.", { stored: false, reason: "sensitive" });
			const id = store.remember({ ...scope(), role: "memory", content }); return result(`Remembered as ${id}`, { id, content });
		} }),
		defineTool({ name: "memory_understand", label: "Record Understanding", description: "Automatically record a high-confidence, stable, source-backed understanding. Never use for secrets, credentials, financial or health details.", parameters: Type.Object({
			kind: Type.Union(MEMORY_CLAIM_KINDS.map((kind) => Type.Literal(kind))),
			statement: Type.String({ minLength: 1, maxLength: 2000 }),
			confidence: Type.Number({ minimum: 0.85, maximum: 1 }),
			stability: Type.Union([Type.Literal("medium"), Type.Literal("high")]),
		}), execute: async (_id, params) => {
			if (!store.upsertClaim || !store.latestEvent) return result("This memory store does not support source-backed understanding yet.", { supported: false });
			const event = store.latestEvent(scope(), "user");
			if (!event) return result("No current user event is available as evidence.", { stored: false, reason: "missing source event" });
			if (!canAutomaticallyUnderstand(params.statement, params.confidence, params.stability, event.content)) return result("Refused to store this as automatic long-term memory because it is insufficiently stable or sensitive.", { stored: false, reason: "policy" });
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
	const localMemoryWrite: ToolPolicy = { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "medium", reversible: true, impact: "Changes Profile-scoped memory and preserves provenance" };
	const policies: Record<string, ToolPolicy> = {
		memory_status: { ...READ_ONLY_TOOL_POLICY }, memory_candidates: { ...READ_ONLY_TOOL_POLICY }, memory_explain: { ...READ_ONLY_TOOL_POLICY }, memory_recall: { ...READ_ONLY_TOOL_POLICY }, memory_list: { ...READ_ONLY_TOOL_POLICY },
		memory_promote: localMemoryWrite, memory_reject: localMemoryWrite, memory_correct: localMemoryWrite,
		memory_remember: { ...localMemoryWrite, risk: "low", approval: "never", impact: "Stores an explicit non-sensitive user memory that can be forgotten" },
		memory_understand: { ...localMemoryWrite, risk: "low", approval: "never", impact: "Stores a stable non-sensitive understanding with source evidence" },
		memory_forget: { ...localMemoryWrite, risk: "high", reversible: false, impact: "Permanently deletes a scoped memory or understanding" },
	};
	return tools.map((tool) => withToolPolicy(tool, policies[tool.name]!));
}

function format(records: MemoryToolRecord[]): string { return records.length ? records.map((record) => `- [${record.id}] ${record.content}`).join("\n") : "No matching memories."; }
function formatEvidence(item: MemoryEvidence): string { return `- [${item.eventId ?? "manual"}] ${new Date(item.event?.occurredAt ?? item.createdAt).toISOString()}: ${item.event?.content ?? item.excerpt}`; }
export function canAutomaticallyUnderstand(statement: string, confidence: number, stability: "medium" | "high", sourceContent: string): boolean {
	return confidence >= 0.85 && (stability === "medium" || stability === "high") && !containsSensitiveMemory(statement) && !containsSensitiveMemory(sourceContent);
}
function containsSensitiveMemory(value: string): boolean { return /\b(password|passcode|token|secret|api[_-]?key|private key)\b|密码|密钥|令牌|身份证|护照|银行卡|手机号|电话号码|住址|地址|工资|薪资|病历|诊断|病史|处方|高血压|糖尿病|\b1\d{10}\b|\b\d{13,19}\b/i.test(value); }
function result(text: string, details: unknown) { return { content: [{ type: "text" as const, text }], details }; }

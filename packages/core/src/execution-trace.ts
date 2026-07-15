import { BoundedJsonlJournal } from "./bounded-jsonl-journal.ts";
import { containsCredentialMaterial } from "./credential-material.ts";
import type { ExecutionEnvelope, ExecutionMode, ExecutionTriggerKind } from "./execution-envelope.ts";

type ExecutionOutcome = "succeeded" | "failed" | "cancelled";
export type CapabilityOutcomeStatus = "accepted" | "rejected" | "unverified" | "failed" | "cancelled";
export interface CapabilityTraceCandidate { kind: "tool" | "mcp" | "skill"; name: string; version?: string; confidence: number; }
export interface CapabilityReceiptRef { id: string; kind: "tool" | "mcp" | "skill"; name: string; version: string; sourceTool: string; }
export interface SkillLifecycleReceiptRef { id: string; name: string; version: string; phase: "activated" | "routed" | "resource_read" | "read" | "completed"; sourceTool: "skill_activate" | "skill_route" | "skill_resource_read" | "skill_read" | "skill_complete"; }
export type ProviderResponseStatus = "reported" | "unavailable";
export interface AssistantToolCallRef { toolCallId: string; toolName: string; argumentsSha256: string; }
interface AssistantTurnTraceInput { assistantTurnId?: string; providerResponseStatus?: ProviderResponseStatus; providerResponseIdentitySha256?: string; }
interface TraceInputBase { executionEnvelope: Readonly<ExecutionEnvelope>; at?: number; }
export type ExecutionTraceInput =
	| (TraceInputBase & { type: "execution.started" })
	| (TraceInputBase & { type: "execution.settled"; status: ExecutionOutcome })
	| (TraceInputBase & { type: "capability.decision"; cognitionId: string; candidates: readonly CapabilityTraceCandidate[] })
	| (TraceInputBase & { type: "capability.downstream_execution_outcome"; cognitionId: string; status: CapabilityOutcomeStatus })
	| (TraceInputBase & { type: "tool_spec.published"; toolSpecPlanId: string; directTools: readonly string[] })
	| (TraceInputBase & AssistantTurnTraceInput & { type: "model.turn_settled"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number; assistantToolCalls?: readonly AssistantToolCallRef[] })
	| (TraceInputBase & AssistantTurnTraceInput & { type: "tool.started"; toolCallId: string; toolName: string; argumentsSha256?: string; toolSpecPlanId?: string })
	| (TraceInputBase & AssistantTurnTraceInput & { type: "tool.settled"; toolCallId: string; toolName: string; argumentsSha256?: string; status: "succeeded" | "failed"; durationMs?: number; toolSpecPlanId?: string; capabilityReceipt?: CapabilityReceiptRef; skillLifecycleReceipt?: SkillLifecycleReceiptRef })
	| (TraceInputBase & { type: "effect.started"; effectId: string; toolCallId: string; status: "executing" })
	| (TraceInputBase & { type: "effect.settled"; effectId: string; toolCallId: string; status: "committed" | "failed" | "unknown" })
	| (TraceInputBase & { type: "checkpoint.saved"; sizeChars: number })
	| (TraceInputBase & { type: "verification.started" })
	| (TraceInputBase & { type: "verification.settled"; status: "accepted" | "rejected" | "unavailable" })
	| (TraceInputBase & { type: "delivery.started" })
	| (TraceInputBase & { type: "delivery.settled"; status: "succeeded" | "failed" });

export interface ExecutionTraceEvent {
	sequence: number;
	type: ExecutionTraceInput["type"];
	executionId: string;
	objectiveId?: string;
	taskId?: string;
	taskRunId?: string;
	accessScopeId?: string;
	triggerKind: ExecutionTriggerKind;
	mode: ExecutionMode;
	at: number;
	status?: ExecutionOutcome | "executing" | "committed" | "unknown" | "accepted" | "rejected" | "unverified" | "unavailable";
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	toolCallId?: string;
	toolName?: string;
	durationMs?: number;
	effectId?: string;
	sizeChars?: number;
	cognitionId?: string;
	candidates?: CapabilityTraceCandidate[];
	toolSpecPlanId?: string;
	directTools?: string[];
	capabilityReceipt?: CapabilityReceiptRef;
	skillLifecycleReceipt?: SkillLifecycleReceiptRef;
	assistantTurnId?: string;
	providerResponseStatus?: ProviderResponseStatus;
	providerResponseIdentitySha256?: string;
	assistantToolCalls?: AssistantToolCallRef[];
	argumentsSha256?: string;
}

export interface ExecutionTraceQuery { executionId: string; accessScopeId?: string; }
export interface ExecutionTrace {
	executionId: string;
	objectiveId?: string;
	taskId?: string;
	taskRunId?: string;
	accessScopeId?: string;
	triggerKind: ExecutionTriggerKind;
	mode: ExecutionMode;
	status?: ExecutionOutcome;
	startedAt?: number;
	settledAt?: number;
	durationMs?: number;
	modelTurns: number;
	toolCalls: number;
	effects: number;
	unknownEffects: number;
	checkpoints: number;
	verifications: number;
	verificationStatus?: "accepted" | "rejected" | "unavailable";
	deliveries: number;
	deliveryStatus?: "succeeded" | "failed";
	capabilityDecisions: number;
	capabilityDownstreamOutcomeStatus?: CapabilityOutcomeStatus;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	events: ExecutionTraceEvent[];
}

export interface ExecutionTraceSink { record(event: ExecutionTraceInput): void; }

/** Content-free diagnostic projection; durable Task, Effect and Policy stores remain authoritative. */
export class FileExecutionTraceStore implements ExecutionTraceSink {
	private readonly journal: BoundedJsonlJournal<ExecutionTraceEvent>;
	private readonly sequences = new Map<string, number>();
	private readonly maxTrackedExecutions: number;

	constructor(path: string, limit = 50_000) {
		this.journal = new BoundedJsonlJournal<ExecutionTraceEvent>({ path, limit, minLimit: 100, maxLimit: 500_000, isRecord: isTraceEvent });
		this.maxTrackedExecutions = Math.max(100, Math.min(limit, 500_000));
		for (const event of this.journal.records()) this.trackSequence(event.executionId, Math.max(this.sequences.get(event.executionId) ?? 0, event.sequence));
	}

	get sequenceCacheSize(): number { return this.sequences.size; }

	record(input: ExecutionTraceInput): void {
		if (containsCredentialMaterial(JSON.stringify(input))) throw new Error("Execution Trace cannot contain credential material");
		const envelope = input.executionEnvelope;
		const sequence = (this.sequences.get(envelope.executionId) ?? this.lastRetainedSequence(envelope.executionId)) + 1;
		const event: ExecutionTraceEvent = {
			sequence, type: input.type, executionId: envelope.executionId,
			...(envelope.objectiveId ? { objectiveId: envelope.objectiveId } : {}), ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
			...(envelope.taskRunId ? { taskRunId: envelope.taskRunId } : {}), ...(envelope.accessScopeRef ? { accessScopeId: envelope.accessScopeRef.id } : {}),
			triggerKind: envelope.trigger.kind, mode: envelope.mode, at: safeNonNegative(input.at ?? Date.now(), "at"),
			...traceDetails(input),
		};
		this.journal.append(event);
		this.trackSequence(envelope.executionId, sequence);
	}

	trace(query: ExecutionTraceQuery): ExecutionTrace | undefined {
		const executionId = safeText(query.executionId, "executionId", 512);
		const events = this.journal.records().filter((event) => event.executionId === executionId).sort((left, right) => left.sequence - right.sequence);
		if (!events.length) return undefined;
		const accessScopeId = events.find((event) => event.accessScopeId)?.accessScopeId;
		if (accessScopeId !== query.accessScopeId) return undefined;
		const first = events[0]!;
		const startedAt = events.find((event) => event.type === "execution.started")?.at;
		const settled = [...events].reverse().find((event) => event.type === "execution.settled");
		const inputTokens = events.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0);
		const outputTokens = events.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0);
		const cacheReadTokens = events.reduce((sum, event) => sum + (event.cacheReadTokens ?? 0), 0);
		const cacheWriteTokens = events.reduce((sum, event) => sum + (event.cacheWriteTokens ?? 0), 0);
		const costUsd = events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
		const verification = [...events].reverse().find((event) => event.type === "verification.settled");
		const delivery = [...events].reverse().find((event) => event.type === "delivery.settled");
		const capabilityOutcome = [...events].reverse().find((event) => event.type === "capability.downstream_execution_outcome");
		return {
			executionId, ...(first.objectiveId ? { objectiveId: first.objectiveId } : {}), ...(first.taskId ? { taskId: first.taskId } : {}),
			...(first.taskRunId ? { taskRunId: first.taskRunId } : {}), ...(accessScopeId ? { accessScopeId } : {}), triggerKind: first.triggerKind, mode: first.mode,
			...(settled?.status === "succeeded" || settled?.status === "failed" || settled?.status === "cancelled" ? { status: settled.status } : {}),
			...(startedAt === undefined ? {} : { startedAt }), ...(settled ? { settledAt: settled.at } : {}),
			...(startedAt === undefined || !settled ? {} : { durationMs: Math.max(0, settled.at - startedAt) }),
			modelTurns: events.filter((event) => event.type === "model.turn_settled").length,
			toolCalls: events.filter((event) => event.type === "tool.started").length || events.filter((event) => event.type === "tool.settled").length,
			effects: events.filter((event) => event.type === "effect.started").length || events.filter((event) => event.type === "effect.settled").length,
			unknownEffects: events.filter((event) => event.type === "effect.settled" && event.status === "unknown").length,
			checkpoints: events.filter((event) => event.type === "checkpoint.saved").length,
			verifications: events.filter((event) => event.type === "verification.started").length,
			...(verification?.status === "accepted" || verification?.status === "rejected" || verification?.status === "unavailable" ? { verificationStatus: verification.status } : {}),
			deliveries: events.filter((event) => event.type === "delivery.started").length,
			...(delivery?.status === "succeeded" || delivery?.status === "failed" ? { deliveryStatus: delivery.status } : {}),
			capabilityDecisions: events.filter((event) => event.type === "capability.decision").length,
			...(isCapabilityOutcomeStatus(capabilityOutcome?.status) ? { capabilityDownstreamOutcomeStatus: capabilityOutcome.status } : {}),
			inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, events,
		};
	}

	private lastRetainedSequence(executionId: string): number {
		let sequence = 0;
		for (const event of this.journal.records()) if (event.executionId === executionId) sequence = Math.max(sequence, event.sequence);
		return sequence;
	}
	private trackSequence(executionId: string, sequence: number): void {
		this.sequences.delete(executionId);
		this.sequences.set(executionId, sequence);
		while (this.sequences.size > this.maxTrackedExecutions) this.sequences.delete(this.sequences.keys().next().value!);
	}
}

function traceDetails(input: ExecutionTraceInput): Partial<ExecutionTraceEvent> {
	if (input.type === "execution.started") return {};
	if (input.type === "execution.settled") return { status: input.status };
	if (input.type === "capability.decision") return {
		cognitionId: safeText(input.cognitionId, "cognitionId", 128),
		candidates: safeCapabilityCandidates(input.candidates),
	};
	if (input.type === "capability.downstream_execution_outcome") return { cognitionId: safeText(input.cognitionId, "cognitionId", 128), status: input.status };
	if (input.type === "tool_spec.published") return { toolSpecPlanId: safeText(input.toolSpecPlanId, "toolSpecPlanId", 256), directTools: safeDirectTools(input.directTools) };
	if (input.type === "model.turn_settled") return {
		inputTokens: safeNonNegative(input.inputTokens, "inputTokens"), outputTokens: safeNonNegative(input.outputTokens, "outputTokens"),
		...(input.cacheReadTokens === undefined ? {} : { cacheReadTokens: safeNonNegative(input.cacheReadTokens, "cacheReadTokens") }),
		...(input.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: safeNonNegative(input.cacheWriteTokens, "cacheWriteTokens") }),
		...(input.costUsd === undefined ? {} : { costUsd: safeNonNegative(input.costUsd, "costUsd") }),
		...assistantTurnDetails(input),
		...(input.assistantToolCalls === undefined ? {} : { assistantToolCalls: safeAssistantToolCalls(input.assistantToolCalls) }),
	};
	if (input.type === "effect.started" || input.type === "effect.settled") return {
		effectId: safeText(input.effectId, "effectId", 512), toolCallId: safeText(input.toolCallId, "toolCallId", 512), status: input.status,
	};
	if (input.type === "checkpoint.saved") return { sizeChars: safeNonNegative(input.sizeChars, "sizeChars") };
	if (input.type === "verification.started") return {};
	if (input.type === "verification.settled") return { status: input.status };
	if (input.type === "delivery.started") return {};
	if (input.type === "delivery.settled") return { status: input.status };
	return {
		toolCallId: safeText(input.toolCallId, "toolCallId", 512), toolName: safeText(input.toolName, "toolName", 512),
		...(input.argumentsSha256 === undefined ? {} : { argumentsSha256: safeSha256(input.argumentsSha256, "argumentsSha256") }),
		...(input.toolSpecPlanId === undefined ? {} : { toolSpecPlanId: safeText(input.toolSpecPlanId, "toolSpecPlanId", 256) }),
		...assistantTurnDetails(input),
		...(input.type === "tool.settled" ? { status: input.status, ...(input.durationMs === undefined ? {} : { durationMs: safeNonNegative(input.durationMs, "durationMs") }), ...(input.capabilityReceipt === undefined ? {} : { capabilityReceipt: normalizeCapabilityReceiptRef(input.capabilityReceipt) }), ...(input.skillLifecycleReceipt === undefined ? {} : { skillLifecycleReceipt: normalizeSkillLifecycleReceiptRef(input.skillLifecycleReceipt) }) } : {}),
	};
}

function assistantTurnDetails(input: AssistantTurnTraceInput): Pick<ExecutionTraceEvent, "assistantTurnId" | "providerResponseStatus" | "providerResponseIdentitySha256"> {
	if (input.assistantTurnId === undefined && input.providerResponseStatus === undefined && input.providerResponseIdentitySha256 === undefined) return {};
	const assistantTurnId = safeIdentifier(input.assistantTurnId, "assistantTurnId", 128);
	if (input.providerResponseStatus !== "reported" && input.providerResponseStatus !== "unavailable") throw new Error("Execution Trace Provider response status is invalid");
	if (input.providerResponseStatus === "reported") {
		const providerResponseIdentitySha256 = safeSha256(input.providerResponseIdentitySha256, "providerResponseIdentitySha256");
		return { assistantTurnId, providerResponseStatus: "reported", providerResponseIdentitySha256 };
	}
	if (input.providerResponseIdentitySha256 !== undefined) throw new Error("Execution Trace unavailable Provider response cannot carry an identity");
	return { assistantTurnId, providerResponseStatus: "unavailable" };
}

function safeAssistantToolCalls(values: readonly AssistantToolCallRef[]): AssistantToolCallRef[] {
	if (!Array.isArray(values) || values.length > 100) throw new Error("Execution Trace assistant Tool calls must be a bounded list");
	const seen = new Set<string>();
	return values.map((value) => {
		const toolCallId = safeIdentifier(value?.toolCallId, "assistantToolCall.toolCallId", 512);
		if (seen.has(toolCallId)) throw new Error("Execution Trace assistant Tool calls contain duplicate identities");
		seen.add(toolCallId);
		return { toolCallId, toolName: safeIdentifier(value?.toolName, "assistantToolCall.toolName", 128), argumentsSha256: safeSha256(value?.argumentsSha256, "assistantToolCall.argumentsSha256") };
	});
}

function safeSha256(value: unknown, field: string): string {
	const normalized = typeof value === "string" ? value.trim() : "";
	if (!/^sha256:[a-f0-9]{64}$/i.test(normalized)) throw new Error(`Execution Trace ${field} is invalid`);
	return normalized.toLowerCase();
}

function safeText(value: string, field: string, maxLength: number): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maxLength) throw new Error(`Execution Trace ${field} must be between 1 and ${maxLength} characters`);
	return normalized;
}
function safeNonNegative(value: number, field: string): number {
	if (!Number.isFinite(value) || value < 0) throw new Error(`Execution Trace ${field} must be a non-negative finite number`);
	return value;
}
export function normalizeCapabilityReceiptRef(value: unknown): CapabilityReceiptRef {
	if (!value || typeof value !== "object") throw new Error("Execution Trace Capability receipt is invalid");
	const receipt = value as Partial<CapabilityReceiptRef>;
	if (receipt.kind !== "tool" && receipt.kind !== "mcp" && receipt.kind !== "skill") throw new Error("Execution Trace Capability receipt kind is invalid");
	const id = safeIdentifier(receipt.id, "capabilityReceipt.id", 256);
	const name = safeIdentifier(receipt.name, "capabilityReceipt.name", 128);
	const version = safeIdentifier(receipt.version, "capabilityReceipt.version", 256);
	const sourceTool = safeIdentifier(receipt.sourceTool, "capabilityReceipt.sourceTool", 128);
	if (receipt.kind === "skill" && sourceTool !== "skill_complete") throw new Error("Execution Trace Skill receipt must originate from skill_complete");
	return { id, kind: receipt.kind, name, version, sourceTool };
}
export function normalizeSkillLifecycleReceiptRef(value: unknown): SkillLifecycleReceiptRef {
	if (!value || typeof value !== "object") throw new Error("Execution Trace Skill lifecycle receipt is invalid");
	const receipt = value as Partial<SkillLifecycleReceiptRef>;
	const sourceByPhase = { activated: "skill_activate", routed: "skill_route", resource_read: "skill_resource_read", read: "skill_read", completed: "skill_complete" } as const;
	if (!receipt.phase || !(receipt.phase in sourceByPhase)) throw new Error("Execution Trace Skill lifecycle phase is invalid");
	const id = safeIdentifier(receipt.id, "skillLifecycleReceipt.id", 256);
	const name = safeIdentifier(receipt.name, "skillLifecycleReceipt.name", 128);
	const version = safeIdentifier(receipt.version, "skillLifecycleReceipt.version", 256);
	const sourceTool = safeIdentifier(receipt.sourceTool, "skillLifecycleReceipt.sourceTool", 128);
	const expectedSource = sourceByPhase[receipt.phase];
	if (sourceTool !== expectedSource) throw new Error(`Execution Trace Skill lifecycle ${receipt.phase} receipt must originate from ${expectedSource}`);
	return { id, name, version, phase: receipt.phase, sourceTool: expectedSource };
}
function safeIdentifier(value: unknown, field: string, maxLength: number): string { const normalized = typeof value === "string" ? value.trim() : ""; if (!normalized || normalized.length > maxLength || !/^[a-z0-9][a-z0-9._:@-]*$/i.test(normalized)) throw new Error(`Execution Trace ${field} is invalid`); return normalized; }
function safeDirectTools(values: readonly string[]): string[] {
	if (!Array.isArray(values) || values.length > 100) throw new Error("Execution Trace direct Tools must be a bounded list");
	const tools = values.map((value) => safeIdentifier(value, "directTool", 128));
	if (new Set(tools).size !== tools.length) throw new Error("Execution Trace direct Tools contain duplicates");
	return tools;
}
function safeCapabilityCandidates(values: readonly CapabilityTraceCandidate[]): CapabilityTraceCandidate[] {
	if (!Array.isArray(values) || values.length > 20) throw new Error("Execution Trace Capability candidates must be a bounded list");
	const seen = new Set<string>();
	return values.map((candidate) => {
		if (!candidate || !["tool", "mcp", "skill"].includes(candidate.kind)) throw new Error("Execution Trace Capability kind is invalid");
		const name = safeText(candidate.name, "Capability name", 128);
		if (seen.has(`${candidate.kind}:${name}`)) throw new Error("Execution Trace Capability candidates contain duplicates");
		seen.add(`${candidate.kind}:${name}`);
		if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) throw new Error("Execution Trace Capability confidence is invalid");
		return { kind: candidate.kind, name, ...(candidate.version ? { version: safeIdentifier(candidate.version, "Capability version", 256) } : {}), confidence: candidate.confidence };
	});
}
function isCapabilityOutcomeStatus(value: unknown): value is CapabilityOutcomeStatus { return value === "accepted" || value === "rejected" || value === "unverified" || value === "failed" || value === "cancelled"; }
function isTraceEvent(value: unknown): value is ExecutionTraceEvent {
	if (!value || typeof value !== "object") return false;
	if (containsCredentialMaterial(JSON.stringify(value))) return false;
	const event = value as Partial<ExecutionTraceEvent>;
	return Number.isSafeInteger(event.sequence) && (event.sequence ?? 0) > 0 && typeof event.executionId === "string" && typeof event.type === "string" && typeof event.at === "number" && typeof event.triggerKind === "string" && typeof event.mode === "string";
}

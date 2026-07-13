import { BoundedJsonlJournal } from "./bounded-jsonl-journal.ts";
import { containsCredentialMaterial } from "./credential-material.ts";
import type { ExecutionEnvelope, ExecutionMode, ExecutionTriggerKind } from "./execution-envelope.ts";

type ExecutionOutcome = "succeeded" | "failed" | "cancelled";
interface TraceInputBase { executionEnvelope: Readonly<ExecutionEnvelope>; at?: number; }
export type ExecutionTraceInput =
	| (TraceInputBase & { type: "execution.started" })
	| (TraceInputBase & { type: "execution.settled"; status: ExecutionOutcome })
	| (TraceInputBase & { type: "model.turn_settled"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number })
	| (TraceInputBase & { type: "tool.started"; toolCallId: string; toolName: string })
	| (TraceInputBase & { type: "tool.settled"; toolCallId: string; toolName: string; status: "succeeded" | "failed"; durationMs?: number })
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
	status?: ExecutionOutcome | "executing" | "committed" | "unknown" | "accepted" | "rejected" | "unavailable";
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
	if (input.type === "model.turn_settled") return {
		inputTokens: safeNonNegative(input.inputTokens, "inputTokens"), outputTokens: safeNonNegative(input.outputTokens, "outputTokens"),
		...(input.cacheReadTokens === undefined ? {} : { cacheReadTokens: safeNonNegative(input.cacheReadTokens, "cacheReadTokens") }),
		...(input.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: safeNonNegative(input.cacheWriteTokens, "cacheWriteTokens") }),
		...(input.costUsd === undefined ? {} : { costUsd: safeNonNegative(input.costUsd, "costUsd") }),
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
		...(input.type === "tool.settled" ? { status: input.status, ...(input.durationMs === undefined ? {} : { durationMs: safeNonNegative(input.durationMs, "durationMs") }) } : {}),
	};
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
function isTraceEvent(value: unknown): value is ExecutionTraceEvent {
	if (!value || typeof value !== "object") return false;
	if (containsCredentialMaterial(JSON.stringify(value))) return false;
	const event = value as Partial<ExecutionTraceEvent>;
	return Number.isSafeInteger(event.sequence) && (event.sequence ?? 0) > 0 && typeof event.executionId === "string" && typeof event.type === "string" && typeof event.at === "number" && typeof event.triggerKind === "string" && typeof event.mode === "string";
}

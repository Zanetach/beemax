import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRunInput, AgentRunResult, AgentRuntimePort, AgentSessionUsage } from "./agent-runtime.ts";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { sessionIdForSource, sessionKeyForSource } from "./session-coordinator.ts";
import type { ToolApprovalBroker, ToolApprovalChoice } from "./tool-approval.ts";
import type { InteractionEventJournal } from "./interaction-event-journal.ts";
import type { ToolApprovalDetails } from "./tool-approval.ts";

export type InteractionSurface = "chat" | "gateway" | "web";
export type InteractionPhase = "idle" | "running" | "queued" | "awaiting_approval" | "completed" | "failed" | "cancelled";

/** Stable visibility and authorization boundary for an interaction session. */
export interface InteractionScope {
	profileId: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
}

export interface InteractionEventMeta {
	sessionId: string;
	scope: InteractionScope;
	turnId: string;
	at: number;
	sequence: number;
}

export type InteractionEvent = InteractionEventMeta & (
	| { type: "turn.started" }
	| { type: "answer.delta"; text: string }
	| { type: "reasoning.delta"; text: string }
	| { type: "tool.changed"; callId: string; name: string; state: "running" | "completed" | "failed"; summary?: string }
	| { type: "approval.requested"; toolName: string; details?: ToolApprovalDetails }
	| { type: "approval.resolved"; toolName: string; allowed: boolean }
	| { type: "turn.queued"; position: number; replaced: boolean; mode: "queue" | "steer_fallback" }
	| { type: "turn.finished"; result: AgentRunResult }
	| { type: "turn.failed"; error: string }
	| { type: "turn.cancelled" }
);

type InteractionEventPayload =
	| { type: "turn.started" }
	| { type: "answer.delta"; text: string }
	| { type: "reasoning.delta"; text: string }
	| { type: "tool.changed"; callId: string; name: string; state: "running" | "completed" | "failed"; summary?: string }
	| { type: "approval.requested"; toolName: string; details?: ToolApprovalDetails }
	| { type: "approval.resolved"; toolName: string; allowed: boolean }
	| { type: "turn.queued"; position: number; replaced: boolean; mode: "queue" | "steer_fallback" }
	| { type: "turn.finished"; result: AgentRunResult }
	| { type: "turn.failed"; error: string }
	| { type: "turn.cancelled" };

export type InteractionAction<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> =
	| { type: "message.send"; source: Source; text: string; input: Omit<AgentRunInput<Source>, "source" | "text">; actionId?: string }
	| { type: "turn.queue"; source: Source; text: string; actionId?: string }
	| { type: "turn.steer"; source: Source; text: string; actionId?: string }
	| { type: "approval.decide"; source: Source; choice: ToolApprovalChoice; actionId?: string }
	| { type: "session.open"; source: Source; actionId?: string }
	| { type: "session.reset"; source: Source; actionId?: string }
	| { type: "session.compact"; source: Source; instructions?: string; actionId?: string }
	| { type: "turn.cancel"; source: Source; actionId?: string };

export interface InteractionCancelResult {
	cancelled: boolean;
	approvalCancelled: boolean;
	subagentsCancelled: number;
	errors: string[];
	queuedCancelled: boolean;
}

export interface InteractionQueueResult { queued: boolean; position: number; replaced: boolean; mode: "queue" | "steer_fallback"; }
export interface InteractionApprovalResult { handled: boolean; }
export interface InteractionSessionResult { opened: boolean; }
export interface InteractionSessionResetResult { reset: boolean; }
export interface InteractionSessionCompactResult { compacted: boolean; }
export type InteractionActionResult = AgentRunResult | InteractionCancelResult | InteractionQueueResult | InteractionApprovalResult | InteractionSessionResult | InteractionSessionResetResult | InteractionSessionCompactResult;

export interface InteractionSnapshot {
	phase: InteractionPhase;
	turnId?: string;
	model?: string;
	usage?: AgentSessionUsage;
	queueDepth?: number;
	updatedAt: number;
}

export type InteractionEventSink = (event: InteractionEvent) => void | Promise<void>;
/** Content-free operational telemetry. Values must never contain prompts, answers, reasoning, or tool args. */
export type InteractionTelemetryEvent =
	| { type: "interaction.turn_started"; surface: string; model: string; session: string }
	| { type: "interaction.approval_requested"; surface: string; tool: string; risk?: "低" | "中" | "高" }
	| { type: "interaction.approval_resolved"; surface: string; decision: "allowed" | "denied"; latency: number }
	| { type: "interaction.input_queued"; surface: string; mode: "queue" | "steer_fallback"; waitMs: number }
	| { type: "interaction.presenter_reconnected"; surface: string; gapEvents: number }
	| { type: "interaction.session_resumed"; source: string; age: number };
export type InteractionTelemetrySink = (event: InteractionTelemetryEvent) => void;

export interface InteractionEventAdapterOptions<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	profileId?: string;
	approvalBroker?: ToolApprovalBroker;
	cancelSubagents?: (source: Source) => number | Promise<number>;
	eventHistoryLimit?: number;
	actionHistoryLimit?: number;
	eventJournal?: InteractionEventJournal;
	telemetry?: InteractionTelemetrySink;
}

/**
 * Core-owned action and event boundary. Channels render semantic events only;
 * runtime cancellation, approval cancellation and child-task cancellation stay
 * in one atomic Core operation.
 */
export class InteractionEventAdapter<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	private readonly states = new Map<string, InteractionSnapshot>();
	private readonly sinks = new Map<string, InteractionEventSink>();
	private readonly eventQueues = new Map<string, Promise<void>>();
	private readonly sinkFailures = new Map<string, unknown>();
	private readonly cancellationRequested = new Set<string>();
	private readonly cancellationPublished = new Set<string>();
	private readonly sequences = new Map<string, number>();
	private readonly eventHistory = new Map<string, InteractionEvent[]>();
	private readonly subscribers = new Map<string, Set<InteractionEventSink>>();
	private readonly queuedInputs = new Map<string, string>();
	private readonly actions = new Map<string, Map<string, Promise<InteractionActionResult>>>();
	private readonly approvalStartedAt = new Map<string, number>();
	private readonly turnModels = new Map<string, string>();
	private readonly runtime: AgentRuntimePort<Source>;
	private readonly approvalBroker?: ToolApprovalBroker;
	private readonly cancelSubagents?: (source: Source) => number | Promise<number>;
	private readonly profileId: string;
	private readonly unsubscribeApproval?: () => void;
	private readonly eventHistoryLimit: number;
	private readonly actionHistoryLimit: number;
	private readonly eventJournal?: InteractionEventJournal;
	private readonly telemetry?: InteractionTelemetrySink;

	constructor(runtime: AgentRuntimePort<Source>, options: InteractionEventAdapterOptions<Source> = {}) {
		this.runtime = runtime;
		this.approvalBroker = options.approvalBroker;
		this.cancelSubagents = options.cancelSubagents;
		this.profileId = options.profileId ?? "default";
		this.eventHistoryLimit = Math.max(20, Math.min(options.eventHistoryLimit ?? 500, 10_000));
		this.actionHistoryLimit = Math.max(20, Math.min(options.actionHistoryLimit ?? 200, 10_000));
		this.eventJournal = options.eventJournal;
		this.telemetry = options.telemetry;
		this.unsubscribeApproval = this.approvalBroker && typeof this.approvalBroker.subscribe === "function" ? this.approvalBroker.subscribe((event) => {
			void (event.type === "requested"
				? this.approvalRequested(event.source as Source, event.toolName, event.details)
				: this.approvalResolved(event.source as Source, event.toolName, event.allowed));
		}) : undefined;
	}

	async dispatch(action: InteractionAction<Source>, sink?: InteractionEventSink): Promise<InteractionActionResult> {
		const actionId = action.actionId?.trim();
		if (!actionId) return this.dispatchUncached(action, sink);
		const key = interactionKey(action.source);
		const known = this.actions.get(key)?.get(actionId);
		if (known) return known;
		const result = this.dispatchUncached(action, sink);
		const history = this.actions.get(key) ?? new Map<string, Promise<InteractionActionResult>>();
		history.set(actionId, result);
		while (history.size > this.actionHistoryLimit) history.delete(history.keys().next().value!);
		this.actions.set(key, history);
		return result;
	}

	private async dispatchUncached(action: InteractionAction<Source>, sink?: InteractionEventSink): Promise<InteractionActionResult> {
		if (action.type === "turn.cancel") return this.cancel(action.source, sink);
		if (action.type === "turn.queue") return this.queue(action.source, action.text, "queue", sink);
		if (action.type === "turn.steer") return this.queue(action.source, action.text, "steer_fallback", sink);
		if (action.type === "approval.decide") return { handled: await this.approvalBroker?.decide(action.source, action.choice) ?? false };
		if (action.type === "session.open") {
			const saved = await this.runtime.listSavedSessions(action.source);
			const threadId = action.source.threadId;
			const previous = saved.find((entry) => entry.threadId === threadId);
			const opened = await this.runtime.open(action.source);
			if (opened) this.telemetry?.({ type: "interaction.session_resumed", source: action.source.platform, age: previous ? Math.max(0, Date.now() - previous.lastUsedAt) : 0 });
			return { opened };
		}
		if (action.type === "session.reset") return { reset: this.runtime.reset(action.source) };
		if (action.type === "session.compact") return { compacted: await this.runtime.compact(action.source, action.instructions) };

		const key = interactionKey(action.source);
		if (sink) this.sinks.set(key, sink);
		const turnId = crypto.randomUUID();
		this.turnModels.set(interactionEventMeta(action.source, "", 0, this.profileId).sessionId, (await this.runtime.modelStatus(action.source))?.model ?? "unresolved");
		await this.publish(action.source, turnId, { type: "turn.started" }, sink);
		try {
			const result = await this.runtime.run({ ...action.input, source: action.source, text: action.text }, (event) => {
				const mapped = mapAgentSessionEvent(event);
				return mapped ? this.enqueue(action.source, turnId, mapped, sink) : undefined;
			});
			await this.flush(key);
			this.throwSinkFailure(key);
			await this.publish(action.source, turnId, { type: "turn.finished", result }, sink);
			return result;
		} catch (error) {
			if (this.cancellationRequested.has(key)) {
				if (!this.cancellationPublished.has(key)) {
					this.cancellationPublished.add(key);
					await this.publish(action.source, turnId, { type: "turn.cancelled" }, sink);
				}
				throw error;
			}
			await this.publish(action.source, turnId, { type: "turn.failed", error: error instanceof Error ? error.message : String(error) }, sink);
			throw error;
		} finally {
			await this.flush(key);
			this.sinks.delete(key);
			this.eventQueues.delete(key);
			this.sinkFailures.delete(key);
			this.cancellationRequested.delete(key);
			this.cancellationPublished.delete(key);
			this.turnModels.delete(interactionEventMeta(action.source, "", 0, this.profileId).sessionId);
		}
	}

	async approvalRequested(source: Source, toolName: string, details?: ToolApprovalDetails): Promise<void> {
		const turnId = this.states.get(interactionKey(source))?.turnId;
		if (turnId) await this.publish(source, turnId, { type: "approval.requested", toolName, details });
	}

	async approvalResolved(source: Source, toolName: string, allowed: boolean): Promise<void> {
		const turnId = this.states.get(interactionKey(source))?.turnId;
		if (turnId) await this.publish(source, turnId, { type: "approval.resolved", toolName, allowed });
	}

	/** Forward a presenter's approval reply through the Core interaction boundary. */
	async handleApprovalReply(source: Source, text: string): Promise<boolean> {
		return this.approvalBroker?.handleReply(source, text) ?? false;
	}

	async snapshot(source: Source): Promise<InteractionSnapshot> {
		const current = this.states.get(interactionKey(source));
		const [status, usage] = await Promise.all([this.runtime.modelStatus(source), this.runtime.usage(source)]);
		return { phase: current?.phase ?? "idle", turnId: current?.turnId, model: status?.model, usage, queueDepth: this.queuedInputs.has(interactionKey(source)) ? 1 : 0, updatedAt: current?.updatedAt ?? Date.now() };
	}

	/** Reconnection-safe semantic events, bounded per interaction session. */
	events(source: Source, afterSequence = 0): InteractionEvent[] {
		const key = interactionKey(source);
		const sessionId = interactionEventMeta(source, "", 0, this.profileId).sessionId;
		const merged = new Map<number, InteractionEvent>();
		for (const event of this.eventJournal?.events(sessionId, afterSequence) ?? []) merged.set(event.sequence, event);
		for (const event of this.eventHistory.get(key) ?? []) if (event.sequence > afterSequence) merged.set(event.sequence, event);
		const events = [...merged.values()].sort((a, b) => a.sequence - b.sequence);
		if (afterSequence > 0) this.telemetry?.({ type: "interaction.presenter_reconnected", surface: source.platform, gapEvents: events.length });
		return events;
	}

	/** Subscribe a presenter without granting it runtime or policy control. */
	subscribe(source: Source, sink: InteractionEventSink): () => void {
		const key = interactionKey(source);
		const listeners = this.subscribers.get(key) ?? new Set<InteractionEventSink>();
		listeners.add(sink);
		this.subscribers.set(key, listeners);
		return () => {
			listeners.delete(sink);
			if (!listeners.size) this.subscribers.delete(key);
		};
	}

	dispose(): void { this.unsubscribeApproval?.(); }

	/** Consume the one-entry queue after a turn reaches a terminal state. */
	takeQueuedInput(source: Source): string | undefined {
		const key = interactionKey(source);
		const text = this.queuedInputs.get(key);
		this.queuedInputs.delete(key);
		return text;
	}

	private async cancel(source: Source, sink?: InteractionEventSink): Promise<InteractionCancelResult> {
		const key = interactionKey(source);
		const state = this.states.get(key);
		if (state?.turnId) this.cancellationRequested.add(key);
		const cancelApproval = this.approvalBroker && typeof this.approvalBroker.cancel === "function"
			? this.approvalBroker.cancel(source)
			: false;
		const results = await Promise.allSettled([
			this.runtime.cancel(source),
			cancelApproval,
			Promise.resolve(this.cancelSubagents?.(source) ?? 0),
		]);
		const errors = results.flatMap((result) => result.status === "rejected" ? [errorMessage(result.reason)] : []);
		const cancelled = results[0].status === "fulfilled" ? results[0].value : false;
		const approvalCancelled = results[1].status === "fulfilled" ? results[1].value : false;
		const subagentsCancelled = results[2].status === "fulfilled" ? results[2].value : 0;
		if (cancelled && state?.turnId && !this.cancellationPublished.has(key)) {
			this.cancellationPublished.add(key);
			await this.publish(source, state.turnId, { type: "turn.cancelled" }, sink);
		}
		const queuedCancelled = this.queuedInputs.delete(key);
		if (!cancelled) this.cancellationRequested.delete(key);
		return { cancelled, approvalCancelled, subagentsCancelled, errors, queuedCancelled };
	}

	private async queue(source: Source, text: string, mode: InteractionQueueResult["mode"], sink?: InteractionEventSink): Promise<InteractionQueueResult> {
		const key = interactionKey(source);
		const turnId = this.states.get(key)?.turnId;
		const phase = this.states.get(key)?.phase;
		if (!turnId || (phase !== "running" && phase !== "queued")) return { queued: false, position: 0, replaced: false, mode };
		const replaced = this.queuedInputs.has(key);
		this.queuedInputs.set(key, text);
		await this.publish(source, turnId, { type: "turn.queued", position: 1, replaced, mode }, sink);
		return { queued: true, position: 1, replaced, mode };
	}

	private apply(source: Source, event: InteractionEvent): void {
		const key = interactionKey(source);
		const previous = this.states.get(key) ?? { phase: "idle" as const, updatedAt: Date.now() };
		this.states.set(key, reduceInteractionEvent(previous, event));
		const history = [...(this.eventHistory.get(key) ?? []), event];
		this.eventHistory.set(key, history.slice(-this.eventHistoryLimit));
		this.eventJournal?.append(event);
		this.recordTelemetry(event);
	}

	private async publish(source: Source, turnId: string, payload: InteractionEventPayload, sink?: InteractionEventSink): Promise<void> {
		await this.enqueue(source, turnId, payload, sink);
	}

	private enqueue(source: Source, turnId: string, payload: InteractionEventPayload, sink?: InteractionEventSink): Promise<void> {
		const key = interactionKey(source);
		const sessionId = interactionEventMeta(source, "", 0, this.profileId).sessionId;
		const persistedSequence = this.eventJournal?.events(sessionId).at(-1)?.sequence ?? 0;
		const event = { ...payload, ...interactionEventMeta(source, turnId, Math.max(this.sequences.get(key) ?? 0, persistedSequence) + 1, this.profileId) } as InteractionEvent;
		this.sequences.set(key, event.sequence);
		const previous = this.eventQueues.get(key) ?? Promise.resolve();
		const next = previous.then(async () => {
			this.apply(source, event);
			await (sink ?? this.sinks.get(key))?.(event);
			for (const listener of this.subscribers.get(key) ?? []) await listener(event);
		}).catch((error: unknown) => {
			if (!this.sinkFailures.has(key)) this.sinkFailures.set(key, error);
		});
		this.eventQueues.set(key, next);
		return next;
	}

	private async flush(key: string): Promise<void> { await this.eventQueues.get(key); }
	private throwSinkFailure(key: string): void { const error = this.sinkFailures.get(key); if (error !== undefined) throw error; }

	private recordTelemetry(event: InteractionEvent): void {
		if (!this.telemetry) return;
		const key = event.sessionId;
		if (event.type === "turn.started") this.telemetry({ type: "interaction.turn_started", surface: event.scope.platform, model: this.turnModels.get(key) ?? "unresolved", session: event.sessionId });
		else if (event.type === "approval.requested") {
			this.approvalStartedAt.set(key, event.at);
			this.telemetry({ type: "interaction.approval_requested", surface: event.scope.platform, tool: event.toolName, risk: event.details?.risk });
		} else if (event.type === "approval.resolved") {
			const startedAt = this.approvalStartedAt.get(key) ?? event.at;
			this.approvalStartedAt.delete(key);
			this.telemetry({ type: "interaction.approval_resolved", surface: event.scope.platform, decision: event.allowed ? "allowed" : "denied", latency: Math.max(0, event.at - startedAt) });
		} else if (event.type === "turn.queued") this.telemetry({ type: "interaction.input_queued", surface: event.scope.platform, mode: event.mode, waitMs: 0 });
	}
}

export function interactionScopeForSource(source: BeeMaxRuntimeSource, profileId = "default"): InteractionScope {
	return { profileId, platform: source.platform, chatId: source.chatId, userId: source.userIdAlt ?? source.userId, threadId: source.threadId };
}

function interactionEventMeta(source: BeeMaxRuntimeSource, turnId: string, sequence: number, profileId: string): InteractionEventMeta {
	return { sessionId: `${profileId}:${sessionIdForSource(source)}`, scope: interactionScopeForSource(source, profileId), turnId, at: Date.now(), sequence };
}

export function reduceInteractionEvent(snapshot: InteractionSnapshot, event: InteractionEvent): InteractionSnapshot {
	if (event.type === "turn.started") return { ...snapshot, phase: "running", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "turn.finished") return { ...snapshot, phase: "completed", turnId: event.turnId, model: event.result.model, updatedAt: event.at };
	if (event.type === "turn.failed") return { ...snapshot, phase: "failed", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "turn.cancelled") return { ...snapshot, phase: "cancelled", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "approval.requested") return { ...snapshot, phase: "awaiting_approval", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "approval.resolved") return { ...snapshot, phase: "running", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "turn.queued") return { ...snapshot, phase: "queued", turnId: event.turnId, updatedAt: event.at };
	return { ...snapshot, updatedAt: event.at };
}

export function mapAgentSessionEvent(event: AgentSessionEvent): InteractionEventPayload | undefined {
	if (event.type === "tool_execution_start") return { type: "tool.changed", callId: event.toolCallId, name: event.toolName, state: "running" };
	if (event.type === "tool_execution_end") return { type: "tool.changed", callId: event.toolCallId, name: event.toolName, state: event.isError ? "failed" : "completed", summary: typeof event.result === "string" ? event.result.slice(0, 500) : undefined };
	if (event.type !== "message_update" || event.message.role !== "assistant") return undefined;
	if (event.assistantMessageEvent.type === "text_delta") return { type: "answer.delta", text: event.assistantMessageEvent.delta };
	if (event.assistantMessageEvent.type === "thinking_delta") return { type: "reasoning.delta", text: event.assistantMessageEvent.delta };
	return undefined;
}


function interactionKey(source: BeeMaxRuntimeSource): string { return sessionKeyForSource(source); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

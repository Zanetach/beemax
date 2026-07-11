import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRunInput, AgentRunResult, AgentRuntimePort, AgentSessionUsage } from "./agent-runtime.ts";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { sessionIdForSource, sessionKeyForSource } from "./session-coordinator.ts";
import type { ToolApprovalBroker, ToolApprovalChoice } from "./tool-approval.ts";
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
	| { type: "message.send"; source: Source; text: string; input: Omit<AgentRunInput<Source>, "source" | "text"> }
	| { type: "turn.queue"; source: Source; text: string }
	| { type: "turn.steer"; source: Source; text: string }
	| { type: "approval.decide"; source: Source; choice: ToolApprovalChoice }
	| { type: "turn.cancel"; source: Source };

export interface InteractionCancelResult {
	cancelled: boolean;
	approvalCancelled: boolean;
	subagentsCancelled: number;
	errors: string[];
	queuedCancelled: boolean;
}

export interface InteractionQueueResult { queued: boolean; position: number; replaced: boolean; mode: "queue" | "steer_fallback"; }
export interface InteractionApprovalResult { handled: boolean; }

export interface InteractionSnapshot {
	phase: InteractionPhase;
	turnId?: string;
	model?: string;
	usage?: AgentSessionUsage;
	queueDepth?: number;
	updatedAt: number;
}

export type InteractionEventSink = (event: InteractionEvent) => void | Promise<void>;

export interface InteractionEventAdapterOptions<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	profileId?: string;
	approvalBroker?: ToolApprovalBroker;
	cancelSubagents?: (source: Source) => number | Promise<number>;
	eventHistoryLimit?: number;
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
	private readonly runtime: AgentRuntimePort<Source>;
	private readonly approvalBroker?: ToolApprovalBroker;
	private readonly cancelSubagents?: (source: Source) => number | Promise<number>;
	private readonly profileId: string;
	private readonly unsubscribeApproval?: () => void;
	private readonly eventHistoryLimit: number;

	constructor(runtime: AgentRuntimePort<Source>, options: InteractionEventAdapterOptions<Source> = {}) {
		this.runtime = runtime;
		this.approvalBroker = options.approvalBroker;
		this.cancelSubagents = options.cancelSubagents;
		this.profileId = options.profileId ?? "default";
		this.eventHistoryLimit = Math.max(20, Math.min(options.eventHistoryLimit ?? 500, 10_000));
		this.unsubscribeApproval = this.approvalBroker && typeof this.approvalBroker.subscribe === "function" ? this.approvalBroker.subscribe((event) => {
			void (event.type === "requested"
				? this.approvalRequested(event.source as Source, event.toolName, event.details)
				: this.approvalResolved(event.source as Source, event.toolName, event.allowed));
		}) : undefined;
	}

	async dispatch(action: InteractionAction<Source>, sink?: InteractionEventSink): Promise<AgentRunResult | InteractionCancelResult | InteractionQueueResult | InteractionApprovalResult> {
		if (action.type === "turn.cancel") return this.cancel(action.source, sink);
		if (action.type === "turn.queue") return this.queue(action.source, action.text, "queue", sink);
		if (action.type === "turn.steer") return this.queue(action.source, action.text, "steer_fallback", sink);
		if (action.type === "approval.decide") return { handled: await this.approvalBroker?.decide(action.source, action.choice) ?? false };

		const key = interactionKey(action.source);
		if (sink) this.sinks.set(key, sink);
		const turnId = crypto.randomUUID();
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
		return (this.eventHistory.get(interactionKey(source)) ?? []).filter((event) => event.sequence > afterSequence);
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
	}

	private async publish(source: Source, turnId: string, payload: InteractionEventPayload, sink?: InteractionEventSink): Promise<void> {
		await this.enqueue(source, turnId, payload, sink);
	}

	private enqueue(source: Source, turnId: string, payload: InteractionEventPayload, sink?: InteractionEventSink): Promise<void> {
		const key = interactionKey(source);
		const event = { ...payload, ...interactionEventMeta(source, turnId, (this.sequences.get(key) ?? 0) + 1, this.profileId) } as InteractionEvent;
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

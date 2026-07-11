import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRunInput, AgentRunResult, AgentRuntimePort, AgentSessionUsage } from "./agent-runtime.ts";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { sessionKeyForSource } from "./session-coordinator.ts";

export type InteractionSurface = "chat" | "gateway" | "web";
export type InteractionPhase = "idle" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";

export type InteractionEvent =
	| { type: "turn.started"; turnId: string; at: number }
	| { type: "answer.delta"; turnId: string; text: string }
	| { type: "reasoning.delta"; turnId: string; text: string }
	| { type: "tool.changed"; turnId: string; callId: string; name: string; state: "running" | "completed" | "failed"; summary?: string }
	| { type: "approval.requested"; turnId: string; toolName: string; at: number }
	| { type: "approval.resolved"; turnId: string; toolName: string; allowed: boolean; at: number }
	| { type: "turn.finished"; turnId: string; result: AgentRunResult; at: number }
	| { type: "turn.failed"; turnId: string; error: string; at: number }
	| { type: "turn.cancelled"; turnId: string; at: number };

export type InteractionAction<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> =
	| { type: "message.send"; source: Source; text: string; input: Omit<AgentRunInput<Source>, "source" | "text"> }
	| { type: "turn.cancel"; source: Source };

export interface InteractionSnapshot {
	phase: InteractionPhase;
	turnId?: string;
	model?: string;
	usage?: AgentSessionUsage;
	updatedAt: number;
}

export type InteractionEventSink = (event: InteractionEvent) => void | Promise<void>;

/**
 * Narrow Core-owned adapter between an Agent runtime and presentation code.
 * Presenters consume semantic events instead of coupling to Pi's event vocabulary.
 */
export class InteractionEventAdapter<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	private readonly states = new Map<string, InteractionSnapshot>();
	private readonly sinks = new Map<string, InteractionEventSink>();
	private readonly eventQueues = new Map<string, Promise<void>>();
	private readonly sinkFailures = new Map<string, unknown>();
	private readonly cancellationRequested = new Set<string>();
	private readonly cancellationPublished = new Set<string>();
	private readonly runtime: AgentRuntimePort<Source>;

	constructor(runtime: AgentRuntimePort<Source>) { this.runtime = runtime; }

	async dispatch(action: InteractionAction<Source>, sink?: InteractionEventSink): Promise<AgentRunResult | boolean> {
		if (action.type === "turn.cancel") return this.cancel(action.source, sink);

		const key = interactionKey(action.source);
		if (sink) this.sinks.set(key, sink);
		const turnId = crypto.randomUUID();
		await this.publish(action.source, { type: "turn.started", turnId, at: Date.now() }, sink);
		try {
			const result = await this.runtime.run({ ...action.input, source: action.source, text: action.text }, (event) => {
				const mapped = mapAgentSessionEvent(turnId, event);
				return mapped ? this.enqueue(action.source, mapped, sink) : undefined;
			});
			await this.flush(key);
			this.throwSinkFailure(key);
			await this.publish(action.source, { type: "turn.finished", turnId, result, at: Date.now() }, sink);
			return result;
		} catch (error) {
			if (this.cancellationRequested.has(key)) {
				if (!this.cancellationPublished.has(key)) {
					this.cancellationPublished.add(key);
					await this.publish(action.source, { type: "turn.cancelled", turnId, at: Date.now() }, sink);
				}
				throw error;
			}
			await this.publish(action.source, { type: "turn.failed", turnId, error: error instanceof Error ? error.message : String(error), at: Date.now() }, sink);
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

	/** Called by an approval transport when a tool pauses the current turn. */
	async approvalRequested(source: Source, toolName: string): Promise<void> {
		const turnId = this.states.get(interactionKey(source))?.turnId;
		if (turnId) await this.publish(source, { type: "approval.requested", turnId, toolName, at: Date.now() });
	}

	/** Called after the approval transport resolves the user's decision. */
	async approvalResolved(source: Source, toolName: string, allowed: boolean): Promise<void> {
		const turnId = this.states.get(interactionKey(source))?.turnId;
		if (turnId) await this.publish(source, { type: "approval.resolved", turnId, toolName, allowed, at: Date.now() });
	}

	async snapshot(source: Source): Promise<InteractionSnapshot> {
		const current = this.states.get(interactionKey(source));
		const [status, usage] = await Promise.all([this.runtime.modelStatus(source), this.runtime.usage(source)]);
		return { phase: current?.phase ?? "idle", turnId: current?.turnId, model: status?.model, usage, updatedAt: current?.updatedAt ?? Date.now() };
	}

	private async cancel(source: Source, sink?: InteractionEventSink): Promise<boolean> {
		const key = interactionKey(source);
		const state = this.states.get(key);
		if (state?.turnId) this.cancellationRequested.add(key);
		const cancelled = await this.runtime.cancel(source);
		if (cancelled && state?.turnId && !this.cancellationPublished.has(key)) {
			this.cancellationPublished.add(key);
			await this.publish(source, { type: "turn.cancelled", turnId: state.turnId, at: Date.now() }, sink);
		}
		if (!cancelled) this.cancellationRequested.delete(key);
		return cancelled;
	}

	private apply(source: Source, event: InteractionEvent): void {
		const key = interactionKey(source);
		const previous = this.states.get(key) ?? { phase: "idle" as const, updatedAt: Date.now() };
		this.states.set(key, reduceInteractionEvent(previous, event));
	}

	private async publish(source: Source, event: InteractionEvent, sink?: InteractionEventSink): Promise<void> {
		await this.enqueue(source, event, sink);
	}

	private enqueue(source: Source, event: InteractionEvent, sink?: InteractionEventSink): Promise<void> {
		const key = interactionKey(source);
		const previous = this.eventQueues.get(key) ?? Promise.resolve();
		const next = previous.then(async () => {
			this.apply(source, event);
			await (sink ?? this.sinks.get(key))?.(event);
		}).catch((error: unknown) => {
			if (!this.sinkFailures.has(key)) this.sinkFailures.set(key, error);
		});
		this.eventQueues.set(key, next);
		return next;
	}

	private async flush(key: string): Promise<void> { await this.eventQueues.get(key); }

	private throwSinkFailure(key: string): void {
		const error = this.sinkFailures.get(key);
		if (error !== undefined) throw error;
	}
}

export function reduceInteractionEvent(snapshot: InteractionSnapshot, event: InteractionEvent): InteractionSnapshot {
	if (event.type === "turn.started") return { ...snapshot, phase: "running", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "turn.finished") return { ...snapshot, phase: "completed", turnId: event.turnId, model: event.result.model, updatedAt: event.at };
	if (event.type === "turn.failed") return { ...snapshot, phase: "failed", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "turn.cancelled") return { ...snapshot, phase: "cancelled", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "approval.requested") return { ...snapshot, phase: "awaiting_approval", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "approval.resolved") return { ...snapshot, phase: "running", turnId: event.turnId, updatedAt: event.at };
	return { ...snapshot, updatedAt: Date.now() };
}

export function mapAgentSessionEvent(turnId: string, event: AgentSessionEvent): InteractionEvent | undefined {
	if (event.type === "tool_execution_start") return { type: "tool.changed", turnId, callId: event.toolCallId, name: event.toolName, state: "running" };
	if (event.type === "tool_execution_end") return { type: "tool.changed", turnId, callId: event.toolCallId, name: event.toolName, state: event.isError ? "failed" : "completed", summary: typeof event.result === "string" ? event.result.slice(0, 500) : undefined };
	if (event.type !== "message_update" || event.message.role !== "assistant") return undefined;
	if (event.assistantMessageEvent.type === "text_delta") return { type: "answer.delta", turnId, text: event.assistantMessageEvent.delta };
	if (event.assistantMessageEvent.type === "thinking_delta") return { type: "reasoning.delta", turnId, text: event.assistantMessageEvent.delta };
	return undefined;
}

function interactionKey(source: BeeMaxRuntimeSource): string { return sessionKeyForSource(source); }

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRunInput, AgentRunResult, AgentRuntimePort, AgentSessionUsage } from "./agent-runtime.ts";
import type { BeeMaxRuntimeSource } from "./runtime.ts";

export type InteractionSurface = "chat" | "gateway" | "web";
export type InteractionPhase = "idle" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";

export type InteractionEvent =
	| { type: "turn.started"; turnId: string; at: number }
	| { type: "answer.delta"; turnId: string; text: string }
	| { type: "reasoning.delta"; turnId: string; text: string }
	| { type: "tool.changed"; turnId: string; callId: string; name: string; state: "running" | "completed" | "failed"; summary?: string }
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
 * Core-owned interaction seam. Presenters dispatch semantic actions and consume
 * semantic events instead of coupling to the underlying Pi event vocabulary.
 */
export class InteractionRuntime<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	private readonly states = new Map<string, InteractionSnapshot>();
	private readonly runtime: AgentRuntimePort<Source>;

	constructor(runtime: AgentRuntimePort<Source>) { this.runtime = runtime; }

	async dispatch(action: InteractionAction<Source>, sink?: InteractionEventSink): Promise<AgentRunResult | boolean> {
		if (action.type === "turn.cancel") {
			const cancelled = await this.runtime.cancel(action.source);
			const key = interactionKey(action.source);
			const state = this.states.get(key);
			if (cancelled && state?.turnId) {
				const event: InteractionEvent = { type: "turn.cancelled", turnId: state.turnId, at: Date.now() };
				this.apply(action.source, event);
				await sink?.(event);
			}
			return cancelled;
		}

		const turnId = crypto.randomUUID();
		const started: InteractionEvent = { type: "turn.started", turnId, at: Date.now() };
		this.apply(action.source, started);
		await sink?.(started);
		try {
			const result = await this.runtime.run({ ...action.input, source: action.source, text: action.text }, (event) => {
				const mapped = mapAgentSessionEvent(turnId, event);
				if (!mapped) return;
				this.apply(action.source, mapped);
				void sink?.(mapped);
			});
			const finished: InteractionEvent = { type: "turn.finished", turnId, result, at: Date.now() };
			this.apply(action.source, finished);
			await sink?.(finished);
			return result;
		} catch (error) {
			const failed: InteractionEvent = { type: "turn.failed", turnId, error: error instanceof Error ? error.message : String(error), at: Date.now() };
			this.apply(action.source, failed);
			await sink?.(failed);
			throw error;
		}
	}

	async snapshot(source: Source): Promise<InteractionSnapshot> {
		const current = this.states.get(interactionKey(source));
		const [status, usage] = await Promise.all([this.runtime.modelStatus(source), this.runtime.usage(source)]);
		return { phase: current?.phase ?? "idle", turnId: current?.turnId, model: status?.model, usage, updatedAt: current?.updatedAt ?? Date.now() };
	}

	private apply(source: Source, event: InteractionEvent): void {
		const key = interactionKey(source);
		const previous = this.states.get(key) ?? { phase: "idle" as const, updatedAt: Date.now() };
		this.states.set(key, reduceInteractionEvent(previous, event));
	}
}

export function reduceInteractionEvent(snapshot: InteractionSnapshot, event: InteractionEvent): InteractionSnapshot {
	if (event.type === "turn.started") return { ...snapshot, phase: "running", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "turn.finished") return { ...snapshot, phase: "completed", turnId: event.turnId, model: event.result.model, updatedAt: event.at };
	if (event.type === "turn.failed") return { ...snapshot, phase: "failed", turnId: event.turnId, updatedAt: event.at };
	if (event.type === "turn.cancelled") return { ...snapshot, phase: "cancelled", turnId: event.turnId, updatedAt: event.at };
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

function interactionKey(source: BeeMaxRuntimeSource): string { return `${source.platform}:${source.chatId}:${source.threadId ?? "default"}:${source.userIdAlt ?? source.userId ?? "anon"}`; }

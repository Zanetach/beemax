import type { AgentRunInput, AgentRunResult, AgentRuntimePort, AgentSessionUsage, BeeMaxAgentRunEvent } from "./agent-runtime.ts";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { sessionIdForSource, sessionKeyForSource } from "./session-coordinator.ts";
import type { ToolApprovalBroker, ToolApprovalChoice } from "./tool-approval.ts";
import type { InteractionEventJournal } from "./interaction-event-journal.ts";
import type { ToolApprovalDetails } from "./tool-approval.ts";
import { conversationIdentity, type ConversationIdentity } from "./agent-scope.ts";
import type { InteractionInputQueueStore, InteractionQueuedInput } from "./interaction-input-queue.ts";

export type InteractionSurface = "chat" | "gateway" | "web";
export type InteractionPhase = "idle" | "running" | "queued" | "awaiting_approval" | "completed" | "failed" | "cancelled";

/** Stable visibility and authorization boundary for an interaction session. */
export interface InteractionScope extends ConversationIdentity {
	profileId: string;
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
	| { type: "model.fallback"; from: string; to: string; attempt: number }
	| { type: "planning.selected"; mode: "direct" | "delegate" | "dag"; concurrency: number; maxSubagents: number; requiredTools: string[] }
	| { type: "planning.completed"; mode: "direct" | "delegate" | "dag"; compliant: boolean; corrected: boolean }
	| { type: "work.changed"; workId: string; kind: "subagent" | "task_plan"; state: "queued" | "running" | "completed" | "failed" | "cancelled"; summary?: string }
	| { type: "turn.queued"; position: number; replaced: boolean; mode: InteractionDeliveryMode }
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
	| { type: "model.fallback"; from: string; to: string; attempt: number }
	| { type: "planning.selected"; mode: "direct" | "delegate" | "dag"; concurrency: number; maxSubagents: number; requiredTools: string[] }
	| { type: "planning.completed"; mode: "direct" | "delegate" | "dag"; compliant: boolean; corrected: boolean }
	| { type: "work.changed"; workId: string; kind: "subagent" | "task_plan"; state: "queued" | "running" | "completed" | "failed" | "cancelled"; summary?: string }
	| { type: "turn.queued"; position: number; replaced: boolean; mode: InteractionDeliveryMode }
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
	taskPlansCancelled: number;
	errors: string[];
	queuedCancelled: boolean;
}

export type InteractionDeliveryMode = "queue" | "steer_fallback" | "steer" | "follow_up";
export interface InteractionQueueResult { queued: boolean; position: number; replaced: boolean; mode: InteractionDeliveryMode; }
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
	| { type: "interaction.input_queued"; surface: string; mode: InteractionDeliveryMode; waitMs: number }
	| { type: "interaction.model_fallback"; surface: string; from: string; to: string; attempt: number }
	| { type: "interaction.planning_selected"; surface: string; mode: "direct" | "delegate" | "dag"; concurrency: number; maxSubagents: number; requiredToolCount: number }
	| { type: "interaction.planning_completed"; surface: string; mode: "direct" | "delegate" | "dag"; compliant: boolean; corrected: boolean }
	| { type: "interaction.presenter_reconnected"; surface: string; gapEvents: number }
	| { type: "interaction.session_resumed"; source: string; age: number };
export type InteractionTelemetrySink = (event: InteractionTelemetryEvent) => void;

export interface InteractionEventAdapterOptions<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	profileId?: string;
	approvalBroker?: ToolApprovalBroker;
	cancelSubagents?: (source: Source) => number | Promise<number>;
	cancelTaskPlans?: (source: Source) => number | Promise<number>;
	eventHistoryLimit?: number;
	actionHistoryLimit?: number;
	eventJournal?: InteractionEventJournal;
	telemetry?: InteractionTelemetrySink;
	inputQueueStore?: InteractionInputQueueStore<Source>;
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
	private readonly queuedInputs = new Map<string, InteractionQueuedInput<Source>[]>();
	private readonly nativeQueuedInputs = new Map<string, Set<string>>();
	private readonly primaryQueuedInputs = new Map<string, Set<string>>();
	private readonly nativeClaimTokens = new Map<string, Map<string, string>>();
	private readonly actions = new Map<string, Map<string, Promise<InteractionActionResult>>>();
	private readonly approvalStartedAt = new Map<string, number>();
	private readonly turnModels = new Map<string, string>();
	private readonly runtime: AgentRuntimePort<Source>;
	private readonly approvalBroker?: ToolApprovalBroker;
	private readonly cancelSubagents?: (source: Source) => number | Promise<number>;
	private readonly cancelTaskPlans?: (source: Source) => number | Promise<number>;
	private readonly profileId: string;
	private readonly unsubscribeApproval?: () => void;
	private readonly eventHistoryLimit: number;
	private readonly actionHistoryLimit: number;
	private readonly eventJournal?: InteractionEventJournal;
	private readonly telemetry?: InteractionTelemetrySink;
	private readonly inputQueueStore?: InteractionInputQueueStore<Source>;

	constructor(runtime: AgentRuntimePort<Source>, options: InteractionEventAdapterOptions<Source> = {}) {
		this.runtime = runtime;
		this.approvalBroker = options.approvalBroker;
		this.cancelSubagents = options.cancelSubagents;
		this.cancelTaskPlans = options.cancelTaskPlans;
		this.profileId = options.profileId ?? "default";
		this.eventHistoryLimit = Math.max(20, Math.min(options.eventHistoryLimit ?? 500, 10_000));
		this.actionHistoryLimit = Math.max(20, Math.min(options.actionHistoryLimit ?? 200, 10_000));
		this.eventJournal = options.eventJournal;
		this.telemetry = options.telemetry;
		this.inputQueueStore = options.inputQueueStore;
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
		if (action.type === "turn.queue") return this.deliverOrQueue(action.source, action.text, "follow_up", sink);
		if (action.type === "turn.steer") return this.deliverOrQueue(action.source, action.text, "steer", sink);
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
		// Reserve synchronously before any model/session I/O so concurrent presenters
		// observe one active turn and route later input through follow-up/steer.
		this.states.set(key, { phase: "running", turnId, updatedAt: Date.now() });
		let completed = false;
		try {
			this.turnModels.set(interactionEventMeta(action.source, "", 0, this.profileId).sessionId, (await this.runtime.modelStatus?.(action.source))?.model ?? "unresolved");
			await this.publish(action.source, turnId, { type: "turn.started" }, sink);
			const result = await this.runtime.run({ ...action.input, source: action.source, text: action.text }, (event) => {
				const mapped = mapAgentSessionEvent(event);
				const work = mapAgentWorkEvent(event);
				if (mapped && work) return Promise.all([this.enqueue(action.source, turnId, mapped, sink), this.enqueue(action.source, turnId, work, sink)]).then(() => undefined);
				return mapped ? this.enqueue(action.source, turnId, mapped, sink) : work ? this.enqueue(action.source, turnId, work, sink) : undefined;
			});
			await this.flush(key);
			this.throwSinkFailure(key);
			await this.publish(action.source, turnId, { type: "turn.finished", result }, sink);
			completed = true;
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
			const nativeIds = this.nativeQueuedInputs.get(key) ?? new Set<string>();
			const primaryIds = this.primaryQueuedInputs.get(key) ?? new Set<string>();
			if (completed) for (const id of nativeIds) this.acknowledgeNativeInput(key, id);
			else for (const id of primaryIds) this.acknowledgeNativeInput(key, id);
			this.nativeQueuedInputs.delete(key);
			this.primaryQueuedInputs.delete(key);
			this.nativeClaimTokens.delete(key);
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
		const [status, usage] = await Promise.all([this.runtime.modelStatus?.(source), this.runtime.usage?.(source)]);
		const key = interactionKey(source);
		return { phase: current?.phase ?? "idle", turnId: current?.turnId, model: status?.model, usage, queueDepth: this.fallbackQueue(key).length, updatedAt: current?.updatedAt ?? Date.now() };
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

	/** Consume the oldest fallback input after a turn reaches a terminal state. */
	takeQueuedInput(source: Source): string | undefined {
		const key = interactionKey(source);
		const queue = this.fallbackQueue(key);
		const liveNative = this.nativeQueuedInputs.get(key) ?? new Set<string>();
		const input = queue.find((candidate) => !liveNative.has(candidate.id));
		if (!input) return undefined;
		this.removeQueuedInput(key, input.id);
		return input.text;
	}

	peekQueuedInput(source: Source): InteractionQueuedInput<Source> | undefined {
		const key = interactionKey(source);
		const liveNative = this.nativeQueuedInputs.get(key) ?? new Set<string>();
		return this.fallbackQueue(key).find((candidate) => !liveNative.has(candidate.id));
	}

	/** Durably reserves a primary inbound message before the channel acknowledges admission. */
	reservePrimaryInput(source: Source, text: string, leaseMs = 60 * 60_000): InteractionQueuedInput<Source> | undefined {
		const key = interactionKey(source);
		const input = this.newQueuedInput(key, source, text);
		const queue = this.fallbackQueue(key);
		const position = this.inputQueueStore?.enqueueClaimed(input, 100, leaseMs) ?? (queue.length < 100 ? queue.length + 1 : 0);
		if (!position) return undefined;
		if (this.inputQueueStore) this.queuedInputs.set(key, this.inputQueueStore.load(key));
		else { queue.push(input); this.queuedInputs.set(key, queue); }
		if (input.claimToken || position === 1) {
			const native = this.nativeQueuedInputs.get(key) ?? new Set<string>(); native.add(input.id); this.nativeQueuedInputs.set(key, native);
			if (input.claimToken) { const claims = this.nativeClaimTokens.get(key) ?? new Map<string, string>(); claims.set(input.id, input.claimToken); this.nativeClaimTokens.set(key, claims); }
		}
		const primary = this.primaryQueuedInputs.get(key) ?? new Set<string>(); primary.add(input.id); this.primaryQueuedInputs.set(key, primary);
		return input;
	}
	demotePrimaryInput(source: Source, id: string): void {
		const key = interactionKey(source);
		this.nativeQueuedInputs.get(key)?.delete(id);
		const token = this.nativeClaimTokens.get(key)?.get(id);
		if (token) this.inputQueueStore?.release(key, id, token);
		this.nativeClaimTokens.get(key)?.delete(id);
	}
	discardPrimaryInput(source: Source, id: string): void { this.acknowledgeNativeInput(interactionKey(source), id); }

	/** Durable inputs left by a crashed presenter/runtime, ordered for startup recovery. */
	recoveredQueuedInputs(): InteractionQueuedInput<Source>[] {
		return (this.inputQueueStore?.all() ?? [...this.queuedInputs.values()].flat()).sort((a, b) => a.createdAt - b.createdAt);
	}
	claimRecoveredInputs(platform: string, limit = 1, leaseMs = 60 * 60_000): InteractionQueuedInput<Source>[] {
		return (this.inputQueueStore?.claim(platform, limit, leaseMs) ?? this.recoveredQueuedInputs().filter((input) => input.source.platform === platform).slice(0, limit)).sort((a, b) => a.createdAt - b.createdAt);
	}
	claimQueuedInput(source: Source, leaseMs = 60 * 60_000): InteractionQueuedInput<Source> | undefined {
		return this.inputQueueStore?.claimKey(interactionKey(source), leaseMs) ?? this.peekQueuedInput(source);
	}
	releaseQueuedInput(source: Source, input: InteractionQueuedInput<Source>): boolean {
		return input.claimToken && this.inputQueueStore ? this.inputQueueStore.release(interactionKey(source), input.id, input.claimToken) : true;
	}

	acknowledgeQueuedInput(source: Source, id: string, claimToken?: string): boolean {
		const key = interactionKey(source);
		if (claimToken && this.inputQueueStore) {
			const acknowledged = this.inputQueueStore.acknowledge(key, id, claimToken);
			if (acknowledged) this.queuedInputs.delete(key);
			return acknowledged;
		}
		this.removeQueuedInput(key, id);
		return true;
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
			Promise.resolve(this.cancelTaskPlans?.(source) ?? 0),
		]);
		const errors = results.flatMap((result) => result.status === "rejected" ? [errorMessage(result.reason)] : []);
		const cancelled = results[0].status === "fulfilled" ? results[0].value : false;
		const approvalCancelled = results[1].status === "fulfilled" ? results[1].value : false;
		const subagentsCancelled = results[2].status === "fulfilled" ? results[2].value : 0;
		const taskPlansCancelled = results[3].status === "fulfilled" ? results[3].value : 0;
		if (cancelled && state?.turnId && !this.cancellationPublished.has(key)) {
			this.cancellationPublished.add(key);
			await this.publish(source, state.turnId, { type: "turn.cancelled" }, sink);
		}
		const localQueuedCancelled = this.fallbackQueue(key).length > 0;
		this.queuedInputs.delete(key);
		if (localQueuedCancelled) this.inputQueueStore?.clear(key);
		const nativeQueuedCancelled = this.nativeQueuedInputs.delete(key);
		const queuedCancelled = localQueuedCancelled || nativeQueuedCancelled;
		if (!cancelled) this.cancellationRequested.delete(key);
		return { cancelled, approvalCancelled, subagentsCancelled, taskPlansCancelled, errors, queuedCancelled };
	}

	private async queue(source: Source, text: string, mode: InteractionQueueResult["mode"], sink?: InteractionEventSink): Promise<InteractionQueueResult> {
		const key = interactionKey(source);
		const turnId = this.states.get(key)?.turnId;
		const phase = this.states.get(key)?.phase;
		if (!turnId || !["running", "queued", "awaiting_approval"].includes(phase ?? "")) return { queued: false, position: 0, replaced: false, mode };
		const input = this.newQueuedInput(key, source, text);
		const position = this.enqueueQueuedInput(input);
		if (!position) return { queued: false, position: this.fallbackQueue(key).length, replaced: false, mode };
		await this.publish(source, turnId, { type: "turn.queued", position, replaced: false, mode }, sink);
		return { queued: true, position, replaced: false, mode };
	}

	private async deliverOrQueue(source: Source, text: string, mode: "steer" | "follow_up", sink?: InteractionEventSink): Promise<InteractionQueueResult> {
		const key = interactionKey(source);
		const turnId = this.states.get(key)?.turnId;
		const phase = this.states.get(key)?.phase;
		if (!turnId || !["running", "queued", "awaiting_approval"].includes(phase ?? "")) return { queued: false, position: 0, replaced: false, mode };
		const deliver = mode === "steer" ? this.runtime.steer : this.runtime.followUp;
		if (deliver) {
			const input = this.newQueuedInput(key, source, text);
			const position = this.enqueueQueuedInput(input);
			if (!position) return { queued: false, position: this.fallbackQueue(key).length, replaced: false, mode };
			if (await deliver.call(this.runtime, source, text)) {
				const native = this.nativeQueuedInputs.get(key) ?? new Set<string>();
				native.add(input.id);
				this.nativeQueuedInputs.set(key, native);
				await this.publish(source, turnId, { type: "turn.queued", position, replaced: false, mode }, sink);
				return { queued: true, position, replaced: false, mode };
			}
			await this.publish(source, turnId, { type: "turn.queued", position, replaced: false, mode: mode === "steer" ? "steer_fallback" : "queue" }, sink);
			return { queued: true, position, replaced: false, mode: mode === "steer" ? "steer_fallback" : "queue" };
		}
		return this.queue(source, text, mode === "steer" ? "steer_fallback" : "queue", sink);
	}

	private fallbackQueue(key: string): InteractionQueuedInput<Source>[] {
		if (this.inputQueueStore) {
			const restored = this.inputQueueStore.load(key);
			if (restored.length) this.queuedInputs.set(key, restored);
			else this.queuedInputs.delete(key);
			return restored;
		}
		const current = this.queuedInputs.get(key);
		if (current) return current;
		return [];
	}

	private newQueuedInput(key: string, source: Source, text: string): InteractionQueuedInput<Source> {
		return { id: crypto.randomUUID(), key, text, source: { ...source }, createdAt: Date.now() };
	}

	private enqueueQueuedInput(input: InteractionQueuedInput<Source>): number {
		const queue = this.fallbackQueue(input.key);
		const position = this.inputQueueStore?.enqueue(input, 100) ?? (queue.length < 100 ? queue.length + 1 : 0);
		if (!position) return 0;
		if (this.inputQueueStore) this.queuedInputs.set(input.key, this.inputQueueStore.load(input.key));
		else { queue.push(input); this.queuedInputs.set(input.key, queue); }
		return position;
	}

	private removeQueuedInput(key: string, id: string): void {
		const queue = this.fallbackQueue(key).filter((input) => input.id !== id);
		if (queue.length) this.queuedInputs.set(key, queue);
		else this.queuedInputs.delete(key);
		this.inputQueueStore?.remove(key, id);
	}

	private acknowledgeNativeInput(key: string, id: string): void {
		const token = this.nativeClaimTokens.get(key)?.get(id);
		if (token && this.inputQueueStore) this.inputQueueStore.acknowledge(key, id, token);
		else this.removeQueuedInput(key, id);
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
		const persistedSequence = this.eventJournal?.lastSequence(sessionId) ?? 0;
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
		else if (event.type === "model.fallback") this.telemetry({ type: "interaction.model_fallback", surface: event.scope.platform, from: event.from, to: event.to, attempt: event.attempt });
		else if (event.type === "planning.selected") this.telemetry({ type: "interaction.planning_selected", surface: event.scope.platform, mode: event.mode, concurrency: event.concurrency, maxSubagents: event.maxSubagents, requiredToolCount: event.requiredTools.length });
		else if (event.type === "planning.completed") this.telemetry({ type: "interaction.planning_completed", surface: event.scope.platform, mode: event.mode, compliant: event.compliant, corrected: event.corrected });
	}
}

export function interactionScopeForSource(source: BeeMaxRuntimeSource, profileId = "default"): InteractionScope {
	return { profileId, ...conversationIdentity(source) };
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
	if (event.type === "turn.queued") return { ...snapshot, phase: snapshot.phase === "awaiting_approval" ? "awaiting_approval" : event.mode === "steer" ? "running" : "queued", turnId: event.turnId, updatedAt: event.at };
	return { ...snapshot, updatedAt: event.at };
}

export function mapAgentSessionEvent(event: BeeMaxAgentRunEvent): InteractionEventPayload | undefined {
	if (event.type === "model_fallback") return { type: "model.fallback", from: event.from, to: event.to, attempt: event.attempt };
	if (event.type === "planning_decision") return { type: "planning.selected", mode: event.mode, concurrency: event.concurrency, maxSubagents: event.maxSubagents, requiredTools: [...event.requiredTools] };
	if (event.type === "planning_outcome") return { type: "planning.completed", mode: event.mode, compliant: event.compliant, corrected: event.corrected };
	if (event.type === "tool_execution_start") return { type: "tool.changed", callId: event.toolCallId, name: event.toolName, state: "running" };
	if (event.type === "tool_execution_end") return { type: "tool.changed", callId: event.toolCallId, name: event.toolName, state: event.isError ? "failed" : "completed", summary: typeof event.result === "string" ? event.result.slice(0, 500) : undefined };
	if (event.type !== "message_update" || event.message.role !== "assistant") return undefined;
	if (event.assistantMessageEvent.type === "text_delta") return { type: "answer.delta", text: event.assistantMessageEvent.delta };
	if (event.assistantMessageEvent.type === "thinking_delta") return { type: "reasoning.delta", text: event.assistantMessageEvent.delta };
	return undefined;
}

function mapAgentWorkEvent(event: BeeMaxAgentRunEvent): InteractionEventPayload | undefined {
	if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return undefined;
	if (event.toolName !== "task_spawn" && event.toolName !== "task_wait" && event.toolName !== "task_plan_execute") return undefined;
	const kind = event.toolName === "task_plan_execute" ? "task_plan" : "subagent";
	// Tool activity already represents creation-in-progress. Work progress starts
	// only after the durable task/plan identity is known, so later terminal
	// events update the same presenter item instead of leaving a stale call row.
	if (event.type === "tool_execution_start") return undefined;
	const details = event.result && typeof event.result === "object" ? (event.result as { details?: unknown }).details : undefined;
	const record = details && typeof details === "object" ? details as Record<string, unknown> : undefined;
	const identity = typeof record?.planId === "string" ? record.planId : typeof record?.id === "string" ? record.id : undefined;
	const status = record?.status;
	if (event.toolName === "task_wait" && status !== "completed" && status !== "failed" && status !== "cancelled") return undefined;
	const state = event.isError ? "failed"
		: status === "queued" ? "queued"
			: status === "running" ? "running"
				: status === "failed" ? "failed"
					: status === "cancelled" ? "cancelled"
						: event.toolName === "task_spawn" || event.toolName === "task_plan_execute" ? "running" : "completed";
	return {
		type: "work.changed", workId: identity ?? event.toolCallId, kind, state,
		summary: identity ? `${identity}${state === "queued" ? " · 已排队" : state === "running" ? " · 后台运行中" : ""}` : undefined,
	};
}


function interactionKey(source: BeeMaxRuntimeSource): string { return sessionKeyForSource(source); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

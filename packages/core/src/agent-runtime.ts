import type { Agent } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type ImageContent, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ConversationContext } from "./conversation-context.ts";
import {
	reloadRuntimeResourcesIfNeeded,
	type BeeMaxRuntimeSource,
} from "./runtime.ts";
import { SessionCoordinator, type RuntimeSessionFactory, type RuntimeSessionSnapshot, type SessionCoordinatorOptions } from "./session-coordinator.ts";
import { SessionCatalog, type SavedSessionChoice, type SessionPreferences } from "./session-catalog.ts";
import type { AgentControlHandler, AgentControlInput, AgentControlResult } from "./agent-control.ts";
import { conversationKey, conversationOwnerKey } from "./agent-scope.ts";
import type { TaskKind, TaskLedger, TaskPlanRecord, TaskPlanStatus, TaskRecord, TaskRunRecord, TaskStatus } from "./task-ledger.ts";
import type { AutonomousPlanningPolicy, PlanningBudgetRegistry } from "./autonomous-planning.ts";
import { TurnUnderstandingEngine, renderWorkContext, selectTurnTools, type TurnUnderstandingPort } from "./turn-understanding.ts";

export interface AgentRunInput<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	source: Source;
	text: string;
	timeoutMs: number | null;
	signal?: AbortSignal;
	expandPromptTemplates?: boolean;
	mode?: "interactive" | "automation";
	/** Bind this Turn to an existing durable Objective instead of creating another responsibility. */
	objectiveTaskId?: string;
	/** Native vision attachments. Binary data must never be copied into telemetry. */
	images?: ImageContent[];
}

export interface AgentRunResult {
	answer: string;
	model: string;
	durationMs: number;
	usage: { input_tokens?: number; output_tokens?: number };
}

export interface AgentHistoryEntry {
	role: "user" | "assistant" | "tool" | "system";
	text: string;
}

export interface AgentSessionUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	contextTokens: number | null;
	contextWindow: number | null;
	contextPercent: number | null;
}

export interface AgentModelStatus {
	model: string;
	thinkingLevel: ModelThinkingLevel;
	supportedThinkingLevels: ModelThinkingLevel[];
}

export interface ModelFallbackEvent { type: "model_fallback"; from: string; to: string; attempt: number; }
export interface PlanningDecisionEvent { type: "planning_decision"; mode: "direct" | "delegate" | "dag"; concurrency: number; maxSubagents: number; requiredTools: string[]; }
export interface PlanningOutcomeEvent { type: "planning_outcome"; mode: "direct" | "delegate" | "dag"; compliant: boolean; corrected: boolean; }
export type CapabilityRankReason = "exact_name" | "name" | "trigger" | "alias" | "lexical";
export interface CapabilityRankedCandidate { kind: "tool" | "mcp" | "skill"; name: string; score: number; confidence: number; reason: CapabilityRankReason; }
export interface CapabilityRankedEvent { type: "capability_ranked"; candidates: CapabilityRankedCandidate[]; activatedTools: string[]; }
export interface ContextBuiltEvent { type: "context_built"; included: Array<{ kind: string; source: string; costChars: number }>; released: Array<{ kind: string; source: string; costChars: number }>; contextChars: number; }
export type BeeMaxAgentRunEvent = AgentSessionEvent | ModelFallbackEvent | PlanningDecisionEvent | PlanningOutcomeEvent | CapabilityRankedEvent | ContextBuiltEvent;
export type BeeMaxAgentRunEventSink = (event: BeeMaxAgentRunEvent) => void | Promise<void>;
/** Gateway-facing runtime contract; implementations may be local or remote. */
export interface AgentRuntimePort<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	run(input: AgentRunInput<Source>, onEvent?: BeeMaxAgentRunEventSink): Promise<AgentRunResult>;
	/** Deliver guidance into an active Pi run. Optional for legacy/remote runtimes. */
	steer?(source: Source, text: string, images?: ImageContent[]): Promise<boolean>;
	/** Deliver a message after the active Pi run becomes idle. Optional for legacy/remote runtimes. */
	followUp?(source: Source, text: string, images?: ImageContent[]): Promise<boolean>;
	cancel(source: Source): Promise<boolean>;
	compact(source: Source, instructions?: string): Promise<boolean>;
	open(source: Source): Promise<boolean>;
	history(source: Source, limit?: number): Promise<AgentHistoryEntry[]>;
	usage(source: Source): Promise<AgentSessionUsage | undefined>;
	listSessions(source: Source): RuntimeSessionSnapshot[];
	listSavedSessions(source: Source): Promise<SavedSessionChoice[]>;
	hasSavedSession(source: Source): Promise<boolean>;
	sessionPreferences(source: Source): Promise<SessionPreferences>;
	updateSessionPreferences(source: Source, preferences: SessionPreferences): Promise<void>;
	reset(source: Source): boolean;
	handleControl(input: AgentControlInput<Source>): Promise<AgentControlResult<Source> | undefined>;
	isBusy(): boolean;
	setModel(source: Source, model: Model<Api>): Promise<boolean>;
	modelStatus(source: Source): Promise<AgentModelStatus | undefined>;
	tasks(source: Source, query?: { kind?: TaskKind; status?: TaskStatus; planId?: string; parentId?: string; limit?: number }): TaskRecord[];
	taskPlans(source: Source, query?: { id?: string; status?: TaskPlanStatus; limit?: number }): TaskPlanRecord[];
	taskRuns(source: Source, taskId: string): TaskRunRecord[];
	setThinkingLevel(source: Source, level: ModelThinkingLevel): Promise<AgentModelStatus | undefined>;
	dispose(): void;
}

export interface BeeMaxAgentRuntimeOptions<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> extends SessionCoordinatorOptions {
	createAgent: RuntimeSessionFactory<Source>;
	createAutomationAgent?: RuntimeSessionFactory<Source>;
	context?: ConversationContext;
	controlHandler?: AgentControlHandler<Source>;
	sessionCatalog?: SessionCatalog<Source>;
	/** Ordered failover candidates. The active model is skipped automatically. */
	fallbackModels?: Model<Api>[];
	maxModelFallbacks?: number;
	taskLedger?: TaskLedger;
	/** Deterministic per-turn execution admission and resource policy. */
	planningPolicy?: Pick<AutonomousPlanningPolicy, "decide">;
	planningBudgets?: PlanningBudgetRegistry;
	turnUnderstanding?: TurnUnderstandingPort;
}

/**
 * The product-level Agent execution entry point. It owns prompt enrichment,
 * persistent session reuse, turn timeout, event subscription, resource reload
 * and candidate-memory capture. Channels only subscribe and present events.
 */
export class BeeMaxAgentRuntime<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> implements AgentRuntimePort<Source> {
	private readonly sessions: SessionCoordinator<Source>;
	private readonly createAgent: RuntimeSessionFactory<Source>;
	private readonly createAutomationAgent?: RuntimeSessionFactory<Source>;
	private readonly context?: ConversationContext;
	private readonly controlHandler?: AgentControlHandler<Source>;
	private readonly sessionCatalog?: SessionCatalog<Source>;
	private readonly fallbackModels: Model<Api>[];
	private readonly maxModelFallbacks: number;
	private readonly taskLedger?: TaskLedger;
	private readonly planningPolicy?: Pick<AutonomousPlanningPolicy, "decide">;
	private readonly planningBudgets?: PlanningBudgetRegistry;
	private readonly turnUnderstanding: TurnUnderstandingPort;

	constructor(options: BeeMaxAgentRuntimeOptions<Source>) {
		this.sessions = new SessionCoordinator(options);
		this.createAgent = options.createAgent;
		this.createAutomationAgent = options.createAutomationAgent;
		this.context = options.context;
		this.controlHandler = options.controlHandler;
		this.sessionCatalog = options.sessionCatalog;
		this.fallbackModels = options.fallbackModels ?? [];
		this.maxModelFallbacks = Math.max(0, Math.min(options.maxModelFallbacks ?? 2, 5));
		this.taskLedger = options.taskLedger;
		this.planningPolicy = options.planningPolicy;
		this.planningBudgets = options.planningBudgets;
		this.turnUnderstanding = options.turnUnderstanding ?? new TurnUnderstandingEngine();
	}

	async run(input: AgentRunInput<Source>, onEvent?: BeeMaxAgentRunEventSink): Promise<AgentRunResult> {
		const factory = input.mode === "automation" ? this.createAutomationAgent ?? this.createAgent : this.createAgent;
		return this.sessions.run(input.source, factory, async (session) => {
			await this.sessionCatalog?.touch(input.source);
			const scopedSession = session.piSession as typeof session.piSession & { beemaxSkillHistorySanitized?: boolean };
			if (!scopedSession.beemaxSkillHistorySanitized) { releaseHistoricalSkillContext(session.piSession); scopedSession.beemaxSkillHistorySanitized = true; }
			const turnMessageStart = session.piSession.agent.state.messages.length;
			if (input.signal?.aborted) {
				await session.piSession.abort();
				throw new AgentRunError("Agent turn was cancelled", false, input.signal.reason);
			}
			const startedAt = Date.now();
			const planning = input.mode === "interactive" || !input.mode ? this.planningPolicy?.decide(input.text) : undefined;
			const requestedText = explicitSkillRequest(input.text);
			const activeObjective = (input.mode === "interactive" || !input.mode) && this.taskLedger && typeof this.taskLedger.queryTasks === "function"
				? this.taskLedger.queryTasks({ ownerKeys: [conversationKey(input.source)], ...(input.objectiveTaskId ? { id: input.objectiveTaskId } : { kinds: ["objective"], statuses: ["pending", "running"] }), limit: 1 })[0]
				: undefined;
			const understanding = input.mode === "interactive" || !input.mode ? this.turnUnderstanding.understand(input.text, { activeObjective: activeObjective?.title }) : undefined;
			const contextAssembly = (input.mode === "interactive" || !input.mode) && this.context && typeof this.context.assemble === "function"
				? this.context.assemble(input.source, requestedText, { model: modelOf(session.piSession.agent), memoryQuery: understanding?.memoryQuery }) : undefined;
			const recalledText = contextAssembly?.text ?? ((input.mode === "interactive" || !input.mode)
				? this.context?.enrich(input.source, requestedText, { model: modelOf(session.piSession.agent), memoryQuery: understanding?.memoryQuery }) ?? requestedText
				: requestedText);
			const needsWorkContext = understanding && (understanding.action !== "create" || understanding.executionMode !== "direct" || understanding.constraints.length > 0 || understanding.acceptanceCriteria.length > 0);
			const enrichedText = needsWorkContext ? `${renderWorkContext(understanding)}\n\n${recalledText}` : recalledText;
			const objectiveBinding = (input.mode === "interactive" || !input.mode) && (planning?.mode !== "direct" || Boolean(input.objectiveTaskId) || isObjectiveContinuation(input.text)) ? this.createObjective(input, startedAt) : undefined;
			const objective = objectiveBinding?.task;
			const planningScope = conversationKey(input.source);
			const planningLease = planning && this.planningBudgets ? this.planningBudgets.begin(planningScope, planning, objective?.id) : undefined;
			const text = planning ? `${enrichedText}\n\n${planning.directive()}` : enrichedText;
			const supportsProgressiveTools = typeof session.piSession.getActiveToolNames === "function" && typeof session.piSession.setActiveToolsByName === "function";
			const activeTools = supportsProgressiveTools ? session.piSession.getActiveToolNames() : undefined;
			const allTools = typeof session.piSession.getAllTools === "function" ? session.piSession.getAllTools() : [];
			const toolSideEffects = new Map(allTools.map((tool) => [tool.name, (tool as { beemaxPolicy?: { sideEffect?: string } }).beemaxPolicy?.sideEffect]));
			const prefetchedTools = understanding ? selectTurnTools(understanding.capabilityQuery, allTools) : [];
			const progressiveTools = [...new Set(["capability_discover", ...(planning?.requiredTools ?? []), ...prefetchedTools])];
			if (activeTools) session.piSession.setActiveToolsByName(progressiveTools);
			let observableProgress = false;
			let toolCalls = 0;
			let consumedTokens = 0;
			let budgetExceeded: string | undefined;
			const requiredToolsUsed: string[] = [];
			const requiredToolCalls = new Map<string, { name: string; args?: unknown }>();
			let delegatedTaskId: string | undefined;
			let discoveredCapabilities = false;
			let singleFailedReadTool: string | undefined;
			let nonDiscoveryOutcomes = 0;
			let eventDelivery = Promise.resolve();
			const enqueueEvent = (event: BeeMaxAgentRunEvent) => { eventDelivery = eventDelivery.then(() => onEvent?.(event)).then(() => undefined); };
			const unsubscribe = session.piSession.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					observableProgress = true;
					const expected = planning?.requiredTools[requiredToolsUsed.length];
					if (event.toolName === expected) requiredToolCalls.set(event.toolCallId, { name: event.toolName, args: event.args });
					toolCalls++;
					if (planning?.budget.maxToolCalls !== null && planning && toolCalls > planning.budget.maxToolCalls && !budgetExceeded) {
						budgetExceeded = `Agent tool-call budget exceeded (${planning.budget.maxToolCalls})`;
						void session.piSession.abort();
					}
				} else if (event.type === "tool_execution_end") {
					if (event.toolName === "capability_discover" && !event.isError) {
						const discovery = capabilityDiscoveryMetadata(event.result, new Set(allTools.map((tool) => tool.name))); discoveredCapabilities = discovery.hasMatches;
						if (discovery.candidates.length || discovery.activatedTools.length) enqueueEvent({ type: "capability_ranked", candidates: discovery.candidates, activatedTools: discovery.activatedTools });
					}
					else if (event.toolName !== "capability_discover") {
						nonDiscoveryOutcomes++;
						singleFailedReadTool = nonDiscoveryOutcomes === 1 && event.isError && toolSideEffects.get(event.toolName) === "none" ? event.toolName : undefined;
					}
					const pending = requiredToolCalls.get(event.toolCallId);
					requiredToolCalls.delete(event.toolCallId);
					if (pending && pending.name === event.toolName && !event.isError) {
						const completed = completedPlanningTool(event.toolName, event.result, pending.args, delegatedTaskId);
						if (completed.accepted) {
							requiredToolsUsed.push(event.toolName);
							delegatedTaskId = completed.delegatedTaskId ?? delegatedTaskId;
						}
					}
				} else if (event.type === "message_end" && event.message.role === "assistant") {
					const usage = event.message.usage;
					consumedTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
					if (planning?.budget.maxTokens !== null && planning && consumedTokens > planning.budget.maxTokens && !budgetExceeded) {
						budgetExceeded = `Agent token budget exceeded (${planning.budget.maxTokens})`;
						void session.piSession.abort();
					}
				} else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && event.assistantMessageEvent.delta.length > 0) observableProgress = true;
				enqueueEvent(event);
			});
			let timedOut = false;
			const abortFromCaller = () => { void session.piSession.abort(); };
			input.signal?.addEventListener("abort", abortFromCaller, { once: true });
			const timeout = input.timeoutMs === null ? undefined : setTimeout(() => { timedOut = true; void session.piSession.abort(); }, input.timeoutMs);
			try {
				if (contextAssembly) await onEvent?.({ type: "context_built", included: contextAssembly.included.map(({ kind, source, costChars }) => ({ kind, source, costChars })), released: contextAssembly.released.map(({ kind, source, costChars }) => ({ kind, source, costChars })), contextChars: contextAssembly.contextChars });
				if (planning) await onEvent?.({ type: "planning_decision", mode: planning.mode, concurrency: planning.suggestedConcurrency, maxSubagents: planning.budget.maxSubagents, requiredTools: [...planning.requiredTools] });
				await session.piSession.prompt(text, {
					expandPromptTemplates: input.expandPromptTemplates ?? true,
					source: input.mode === "automation" ? "extension" : undefined,
					images: input.images,
				});
				if (singleFailedReadTool && !discoveredCapabilities && !budgetExceeded) {
					const failedTool = singleFailedReadTool; singleFailedReadTool = undefined;
					await session.piSession.prompt(`[BeeMax capability reroute: ${failedTool} failed and no later Tool succeeded. Use capability_discover now to find an already available alternative, then continue the original request. Do not retry the same external mutation; reconcile any uncertain side effect before another write.]`, { expandPromptTemplates: false });
				}
				if (discoveredCapabilities && !budgetExceeded) {
					discoveredCapabilities = false;
					await session.piSession.prompt("[BeeMax capability continuation: matching Tools or Skills are now active. Continue the original request using them. Do not repeat capability discovery.]", { expandPromptTemplates: false });
				}
				const missingTools = planning?.requiredTools.slice(requiredToolsUsed.length) ?? [];
				let planningCorrected = false;
				if (missingTools.length && !budgetExceeded) {
					planningCorrected = true;
					await session.piSession.prompt(`[BeeMax planning correction: complete these tools in order now using the active execution budget: ${missingTools.join(" -> ")}. Do not answer directly.]`, { expandPromptTemplates: false });
					const stillMissing = planning?.requiredTools.slice(requiredToolsUsed.length) ?? [];
					if (stillMissing.length) {
						await onEvent?.({ type: "planning_outcome", mode: planning!.mode, compliant: false, corrected: true });
						throw new AgentRunError(`Agent did not complete required planning tools: ${stillMissing.join(" -> ")}`, false, undefined);
					}
				}
				if (planning) await onEvent?.({ type: "planning_outcome", mode: planning.mode, compliant: true, corrected: planningCorrected });
				if (budgetExceeded) throw new AgentRunError(budgetExceeded, false, undefined);
				let failure = lastAssistantFailure(session.piSession.agent);
				let attempt = 0;
				for (const fallback of this.fallbackModels) {
					if (!failure || !isRecoverableModelFailure(failure) || observableProgress || attempt >= this.maxModelFallbacks) break;
					const current = session.piSession.agent.state.model;
					if (sameModel(current, fallback) || (input.images?.length && !fallback.input.includes("image"))) continue;
					attempt++;
					await onEvent?.({ type: "model_fallback", from: current?.id ?? "Unknown", to: fallback.id, attempt });
					if (!await session.piSession.retryWithModel(fallback)) break;
					failure = lastAssistantFailure(session.piSession.agent);
				}
				if (failure) throw new AgentRunError(errorMessage(failure), false, failure, isRecoverableModelFailure(failure));
			} catch (cause) {
				if (objectiveBinding?.created && objective && !requiredToolsUsed.includes("task_plan_execute")) this.taskLedger?.transition(objective.id, { status: "failed", finishedAt: Date.now(), error: errorMessage(cause).slice(0, 5_000) });
				if (cause instanceof AgentRunError) throw cause;
				throw new AgentRunError(timedOut && input.timeoutMs !== null ? `Agent turn timed out after ${Math.round(input.timeoutMs / 60_000)} minutes` : errorMessage(cause), timedOut, cause, timedOut || isRecoverableModelFailure(cause));
			} finally {
				await eventDelivery;
				releaseHistoricalSkillContext(session.piSession, turnMessageStart);
				(session.piSession as typeof session.piSession & { beemaxResetTurnResources?: () => void }).beemaxResetTurnResources?.();
				if (activeTools) session.piSession.setActiveToolsByName(activeTools);
				if (planningLease) this.planningBudgets?.end(planningScope, planningLease);
				if (timeout) clearTimeout(timeout);
				input.signal?.removeEventListener("abort", abortFromCaller);
				unsubscribe?.();
			}
			const answer = lastAssistantText(session.piSession.agent) || "(no response)";
			if (objectiveBinding?.created && objective && !requiredToolsUsed.includes("task_plan_execute")) this.taskLedger?.transition(objective.id, { status: "succeeded", finishedAt: Date.now(), result: answer.slice(0, 50_000) });
			try {
				if (await reloadRuntimeResourcesIfNeeded(session.piSession)) console.info("[beemax] skills and resources hot-reloaded after agent evolution");
			} catch (error) { console.error(`[beemax] resource reload failed: ${errorMessage(error)}`); }
			if (input.mode !== "automation") this.context?.record(input.source, { user: input.text, assistant: answer });
			return { answer, model: modelOf(session.piSession.agent), durationMs: Date.now() - startedAt, usage: usageOf(session.piSession.agent) };
		});
	}

	private createObjective(input: AgentRunInput<Source>, now: number): { task: TaskRecord; created: boolean } | undefined {
		if (!this.taskLedger || input.source.delegatedTask) return undefined;
		const description = input.text.trim();
		if (!description) return undefined;
		const ownerKey = conversationKey(input.source);
		const continuation = input.objectiveTaskId || isObjectiveContinuation(description)
			? this.taskLedger.queryTasks({ ownerKeys: [ownerKey], id: input.objectiveTaskId, kinds: ["objective"], statuses: ["pending", "running"], limit: 1 })[0]
				?? (!input.objectiveTaskId ? this.taskLedger.queryTasks({ ownerKeys: [ownerKey], kinds: ["objective"], statuses: ["pending", "running"], limit: 1 })[0] : undefined)
			: undefined;
		if (continuation) return { task: continuation, created: false };
		const title = description.split(/\r?\n/, 1)[0]!.slice(0, 120);
		const objective: TaskRecord = {
			id: `objective:${crypto.randomUUID()}`, ownerKey, kind: "objective",
			title, description: description.slice(0, 50_000), status: "pending", createdAt: now,
			executionScope: { ...input.source },
		};
		this.taskLedger.record(objective);
		this.taskLedger.transition(objective.id, { status: "running", startedAt: now });
		return { task: { ...objective, status: "running", startedAt: now }, created: true };
	}

	async cancel(source: Source): Promise<boolean> { return this.sessions.abort(source); }
	async steer(source: Source, text: string, images?: ImageContent[]): Promise<boolean> {
		return (await this.sessions.withSession(source, async (session) => {
			if (!session.busy || !session.piSession.isStreaming) return false;
			await session.piSession.steer(text, images);
			return true;
		})) ?? false;
	}
	async followUp(source: Source, text: string, images?: ImageContent[]): Promise<boolean> {
		return (await this.sessions.withSession(source, async (session) => {
			if (!session.busy || !session.piSession.isStreaming) return false;
			await session.piSession.followUp(text, images);
			return true;
		})) ?? false;
	}
	async compact(source: Source, instructions?: string): Promise<boolean> {
		return (await this.sessions.withSession(source, async (session) => {
			if (session.busy) return false;
			const owners = [...new Set([conversationKey(source), conversationOwnerKey(source), "profile"])];
			const active = this.taskLedger && typeof this.taskLedger.queryTasks === "function" ? this.taskLedger.queryTasks({ ownerKeys: owners, statuses: ["pending", "running"], limit: 20 }) : [];
			const preservationPayload = active.length ? JSON.stringify(active.map((task) => ({ id: task.id, kind: task.kind, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria, status: task.status, checkpoint: task.checkpoint, effectReceipts: task.effectReceipts, result: task.result, verificationFeedback: task.verificationFeedback }))) : undefined;
			if (preservationPayload && Buffer.byteLength(preservationPayload) > 40_000) throw new AgentRunError("Task preservation envelope exceeds the safe compaction budget", false, undefined);
			const envelope = preservationPayload ? [
				"<task-preservation-envelope>",
				"Preserve these durable responsibilities, constraints, Acceptance Criteria, completed effects, pending steps, and blockers exactly in the compacted summary.",
				preservationPayload,
				"</task-preservation-envelope>",
			].join("\n") : undefined;
			await session.piSession.compact([instructions, envelope].filter(Boolean).join("\n\n") || undefined);
			return true;
		})) ?? false;
	}
	async open(source: Source): Promise<boolean> {
		await this.sessions.run(source, this.createAgent, async () => undefined);
		await this.sessionCatalog?.touch(source);
		return true;
	}
	async history(source: Source, limit = 20): Promise<AgentHistoryEntry[]> {
		const live = await this.sessions.withSession(source, async (candidate): Promise<{ role?: string; content?: unknown }[]> => candidate.piSession.agent.state.messages as unknown as { role?: string; content?: unknown }[]);
		if (!live) return [];
		return live
			.map((message) => historyEntry(message))
			.filter((entry): entry is AgentHistoryEntry => entry !== undefined)
			.slice(-Math.max(1, Math.min(limit, 100)));
	}
	async usage(source: Source): Promise<AgentSessionUsage | undefined> {
		return this.sessions.withSession(source, async (session) => sessionUsage(session.piSession));
	}
	listSessions(source: Source): RuntimeSessionSnapshot[] { return this.sessions.list(source); }
	async listSavedSessions(source: Source): Promise<SavedSessionChoice[]> { return this.sessionCatalog?.list(source) ?? []; }
	async hasSavedSession(source: Source): Promise<boolean> { return this.sessionCatalog?.has(source) ?? false; }
	async sessionPreferences(source: Source): Promise<SessionPreferences> { return this.sessionCatalog?.preferences(source) ?? {}; }
	async updateSessionPreferences(source: Source, preferences: SessionPreferences): Promise<void> { await this.sessionCatalog?.updatePreferences(source, preferences); }
	reset(source: Source): boolean { return this.sessions.reset(source); }
	async handleControl(input: AgentControlInput<Source>): Promise<AgentControlResult<Source> | undefined> {
		return this.controlHandler?.(input);
	}
	async setModel(source: Source, model: Model<Api>): Promise<boolean> {
		return (await this.sessions.withSession(source, async (session) => {
			if (session.busy) return false;
			await session.piSession.setModel(model);
			return true;
		})) ?? false;
	}
	async modelStatus(source: Source): Promise<AgentModelStatus | undefined> {
		return this.sessions.withSession(source, async (session) => modelStatusOf(session.piSession));
	}
	tasks(source: Source, query: { kind?: TaskKind; status?: TaskStatus; planId?: string; parentId?: string; limit?: number } = {}): TaskRecord[] {
		return this.taskLedger?.queryTasks({
			ownerKeys: [...new Set([conversationKey(source), conversationOwnerKey(source), "profile"])],
			kinds: query.kind ? [query.kind] : undefined,
			statuses: query.status ? [query.status] : undefined,
			planIds: query.planId ? [query.planId] : undefined,
			parentIds: query.parentId ? [query.parentId] : undefined,
			limit: query.limit,
		}) ?? [];
	}
	taskPlans(source: Source, query: { id?: string; status?: TaskPlanStatus; limit?: number } = {}): TaskPlanRecord[] {
		return this.taskLedger?.queryTaskPlans({
			ownerKeys: [...new Set([conversationKey(source), conversationOwnerKey(source), "profile"])],
			id: query.id,
			statuses: query.status ? [query.status] : undefined,
			limit: query.limit,
		}) ?? [];
	}
	taskRuns(source: Source, taskId: string): TaskRunRecord[] {
		const ownerKeys = [...new Set([conversationKey(source), conversationOwnerKey(source), "profile"])];
		if (!this.taskLedger?.queryTasks({ ownerKeys, id: taskId, limit: 1 })[0]) throw new Error(`Task not found: ${taskId}`);
		return this.taskLedger?.taskRuns(taskId) ?? [];
	}
	async setThinkingLevel(source: Source, level: ModelThinkingLevel): Promise<AgentModelStatus | undefined> {
		return this.sessions.withSession(source, async (session) => {
			if (session.busy) return undefined;
			const model = session.piSession.agent.state.model;
			session.piSession.setThinkingLevel(model ? clampThinkingLevel(model, level) : "off");
			return modelStatusOf(session.piSession);
		});
	}
	isBusy(): boolean { return this.sessions.isBusy(); }
	dispose(): void { this.sessions.dispose(); }
}

function releaseHistoricalSkillContext(session: AgentSession, fromIndex = 0): void {
	const names = new Set(["skill_activate", "skill_read", "skill_resource_read"]);
	const current = session.agent.state.messages; let messages: typeof current | undefined;
	for (let index = Math.max(0, fromIndex); index < current.length; index++) {
		const message = current[index]!;
		if (message.role !== "toolResult" || !names.has(message.toolName) || message.content.every((block) => block.type !== "text" || !block.text || block.text.startsWith("[Turn-scoped Skill context"))) continue;
		messages ??= [...current]; messages[index] = { ...message, content: [{ type: "text" as const, text: "[Turn-scoped Skill context released; version and loaded-resource summary retained in tool details.]" }] };
	}
	if (messages) session.agent.state.messages = messages;
}

function capabilityDiscoveryMetadata(result: unknown, knownTools: ReadonlySet<string>): { hasMatches: boolean; candidates: CapabilityRankedCandidate[]; activatedTools: string[] } {
	const details = result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
	if (!details || typeof details !== "object") return { hasMatches: false, candidates: [], activatedTools: [] };
	const value = details as { activatedTools?: unknown; tools?: unknown; skills?: unknown; ranked?: unknown };
	const validName = (item: unknown): item is string => typeof item === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(item);
	const activatedTools = Array.isArray(value.activatedTools) ? [...new Set(value.activatedTools.filter((item): item is string => validName(item) && knownTools.has(item)))].slice(0, 20) : [];
	const candidates = Array.isArray(value.ranked) ? value.ranked.flatMap((item): CapabilityRankedCandidate[] => {
		if (!item || typeof item !== "object") return []; const entry = item as Record<string, unknown>;
		if (!["tool", "mcp", "skill"].includes(String(entry.kind)) || !validName(entry.name) || typeof entry.score !== "number" || !Number.isFinite(entry.score) || typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence) || typeof entry.reason !== "string") return [];
		const reason: CapabilityRankReason = entry.reason.includes("trigger") ? "trigger" : entry.reason.includes("alias") ? "alias" : entry.reason.includes("exact") ? "exact_name" : entry.reason.includes("name") ? "name" : "lexical";
		return [{ kind: entry.kind as "tool" | "mcp" | "skill", name: entry.name, score: entry.score, confidence: Math.max(0, Math.min(1, entry.confidence)), reason }];
	}).slice(0, 10) : [];
	const hasMatches = activatedTools.length > 0 || candidates.length > 0;
	return { hasMatches, candidates, activatedTools };
}

function isObjectiveContinuation(text: string): boolean { return /^(?:(?:继续|接着|补充|换成|改成|再加|先不要)(?:\s|处理|这个|该|中文|英文|一个|做|$)|(?:continue|go on|change|add)\b)/iu.test(text.trim()); }
function explicitSkillRequest(text: string): string {
	const match = text.match(/^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/i); if (!match) return text;
	return `[Explicit Skill request: ${match[1]}]\nUse capability_discover with this exact Skill name, then follow skill_activate, skill_route, skill_resource_read, and skill_complete. Do not expand or read SKILL.md directly.${match[2]?.trim() ? `\n\nUser request: ${match[2].trim()}` : ""}`;
}

function completedPlanningTool(toolName: string, result: unknown, args: unknown, delegatedTaskId?: string): { accepted: boolean; delegatedTaskId?: string } {
	const details = result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
	const record = details && typeof details === "object" ? details as Record<string, unknown> : undefined;
	if (toolName === "task_spawn") return typeof record?.id === "string" ? { accepted: true, delegatedTaskId: record.id } : { accepted: false };
	if (toolName === "task_wait") {
		const requestedId = args && typeof args === "object" ? (args as { id?: unknown }).id : undefined;
		return { accepted: Boolean(delegatedTaskId && requestedId === delegatedTaskId && record?.id === delegatedTaskId && record.status === "completed") };
	}
	if (toolName === "task_plan_execute") {
		const backgroundAccepted = record?.accepted === true && record.status === "running" && typeof record.planId === "string";
		const terminalAccepted = record?.failed === 0 && record?.cancelled === 0 && Array.isArray(record.blocked) && record.blocked.length === 0;
		return { accepted: backgroundAccepted || terminalAccepted };
	}
	return { accepted: false };
}

export class AgentRunError extends Error {
	readonly timedOut: boolean;
	readonly recoverable: boolean;
	readonly cause: unknown;
	constructor(message: string, timedOut: boolean, cause: unknown, recoverable = false) {
		super(message);
		this.name = "AgentRunError";
		this.timedOut = timedOut;
		this.recoverable = recoverable;
		this.cause = cause;
	}
}

/** Only transient upstream failures may trigger a configured model fallback. */
export function isRecoverableModelFailure(error: unknown): boolean {
	const status = httpStatus(error);
	if (status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) return true;
	const message = errorMessage(error).toLowerCase();
	return /(?:\b(?:408|409|425|429|5\d\d)\b|fetch failed|network error|networkerror|econnreset|econnrefused|etimedout|socket hang up|temporarily unavailable|rate limit|overloaded)/.test(message);
}

function lastAssistantText(agent: Agent): string {
	const last = agent.state.messages[agent.state.messages.length - 1];
	if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return "";
	const text: string[] = [];
	for (const block of last.content) {
		if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") text.push(block.text);
	}
	return text.join("");
}
function modelOf(agent: Agent): string { return agent.state.model?.id ?? "Unknown"; }
function sameModel(left: Model<Api> | undefined, right: Model<Api>): boolean { return left?.provider === right.provider && left.id === right.id; }
function lastAssistantFailure(agent: Agent): unknown | undefined {
	const last = agent.state.messages.at(-1);
	if (!last || last.role !== "assistant" || last.stopReason !== "error") return undefined;
	return new Error(last.errorMessage ?? "Model request failed");
}
function usageOf(agent: Agent): { input_tokens?: number; output_tokens?: number } {
	const last = agent.state.messages[agent.state.messages.length - 1];
	return last?.role === "assistant" ? { input_tokens: last.usage.input, output_tokens: last.usage.output } : {};
}
function historyEntry(message: { role?: string; content?: unknown }): AgentHistoryEntry | undefined {
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool" && message.role !== "system") return undefined;
	const text = typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content.flatMap((block) => typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? [block.text] : []).join("")
			: "";
	return text ? { role: message.role, text } : undefined;
}
function sessionUsage(session: AgentSession): AgentSessionUsage {
	const messages = session.agent.state.messages as unknown as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }[];
	const totals = messages.reduce((total, message) => message.role === "assistant" && message.usage
		? {
			inputTokens: total.inputTokens + (message.usage.input ?? 0),
			outputTokens: total.outputTokens + (message.usage.output ?? 0),
			cacheReadTokens: total.cacheReadTokens + (message.usage.cacheRead ?? 0),
			cacheWriteTokens: total.cacheWriteTokens + (message.usage.cacheWrite ?? 0),
		}
		: total, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
	const context = session.getContextUsage();
	return { ...totals, contextTokens: context?.tokens ?? null, contextWindow: context?.contextWindow ?? null, contextPercent: context?.percent ?? null };
}
function modelStatusOf(session: AgentSession): AgentModelStatus {
	const model = session.agent.state.model;
	return {
		model: model?.id ?? "Unknown",
		thinkingLevel: session.thinkingLevel,
		supportedThinkingLevels: model ? getSupportedThinkingLevels(model) : ["off"],
	};
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function httpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown }; $metadata?: { httpStatusCode?: unknown } };
	for (const candidate of [value.status, value.statusCode, value.response?.status, value.$metadata?.httpStatusCode]) if (typeof candidate === "number") return candidate;
	return undefined;
}

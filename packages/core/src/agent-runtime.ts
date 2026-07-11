import type { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ConversationContext } from "./conversation-context.ts";
import {
	reloadRuntimeResourcesIfNeeded,
	type BeeMaxRuntimeSource,
} from "./runtime.ts";
import { SessionCoordinator, type RuntimeSessionFactory, type RuntimeSessionSnapshot, type SessionCoordinatorOptions } from "./session-coordinator.ts";
import { SessionCatalog, type SavedSessionChoice, type SessionPreferences } from "./session-catalog.ts";
import type { AgentControlHandler, AgentControlInput, AgentControlResult } from "./agent-control.ts";

export interface AgentRunInput<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	source: Source;
	text: string;
	timeoutMs: number;
	signal?: AbortSignal;
	expandPromptTemplates?: boolean;
	mode?: "interactive" | "automation";
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

export type AgentRunEventSink = (event: AgentSessionEvent) => void | Promise<void>;

/** Gateway-facing runtime contract; implementations may be local or remote. */
export interface AgentRuntimePort<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	run(input: AgentRunInput<Source>, onEvent?: AgentRunEventSink): Promise<AgentRunResult>;
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
	handleControl(input: AgentControlInput<Source>): Promise<AgentControlResult | undefined>;
	isBusy(): boolean;
	setModel(source: Source, model: Model<Api>): Promise<boolean>;
	dispose(): void;
}

export interface BeeMaxAgentRuntimeOptions<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> extends SessionCoordinatorOptions {
	createAgent: RuntimeSessionFactory<Source>;
	createAutomationAgent?: RuntimeSessionFactory<Source>;
	context?: ConversationContext;
	controlHandler?: AgentControlHandler<Source>;
	sessionCatalog?: SessionCatalog<Source>;
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

	constructor(options: BeeMaxAgentRuntimeOptions<Source>) {
		this.sessions = new SessionCoordinator(options);
		this.createAgent = options.createAgent;
		this.createAutomationAgent = options.createAutomationAgent;
		this.context = options.context;
		this.controlHandler = options.controlHandler;
		this.sessionCatalog = options.sessionCatalog;
	}

	async run(input: AgentRunInput<Source>, onEvent?: AgentRunEventSink): Promise<AgentRunResult> {
		const factory = input.mode === "automation" ? this.createAutomationAgent ?? this.createAgent : this.createAgent;
		return this.sessions.run(input.source, factory, async (session) => {
			await this.sessionCatalog?.touch(input.source);
			if (input.signal?.aborted) {
				await session.piSession.abort();
				throw new AgentRunError("Agent turn was cancelled", false, input.signal.reason);
			}
			const startedAt = Date.now();
			const text = input.mode === "interactive" || !input.mode
				? this.context?.enrich(input.source, input.text) ?? input.text
				: input.text;
			const unsubscribe = onEvent ? session.piSession.subscribe((event) => { void onEvent(event); }) : undefined;
			let timedOut = false;
			const abortFromCaller = () => { void session.piSession.abort(); };
			input.signal?.addEventListener("abort", abortFromCaller, { once: true });
			const timeout = setTimeout(() => { timedOut = true; void session.piSession.abort(); }, input.timeoutMs);
			try {
				await session.piSession.prompt(text, { expandPromptTemplates: input.expandPromptTemplates ?? true, source: input.mode === "automation" ? "extension" : undefined });
			} catch (cause) {
				throw new AgentRunError(timedOut ? `Agent turn timed out after ${Math.round(input.timeoutMs / 60_000)} minutes` : errorMessage(cause), timedOut, cause);
			} finally {
				clearTimeout(timeout);
				input.signal?.removeEventListener("abort", abortFromCaller);
				unsubscribe?.();
			}
			const answer = lastAssistantText(session.piSession.agent) || "(no response)";
			try {
				if (await reloadRuntimeResourcesIfNeeded(session.piSession)) console.info("[beemax] skills and resources hot-reloaded after agent evolution");
			} catch (error) { console.error(`[beemax] resource reload failed: ${errorMessage(error)}`); }
			if (input.mode !== "automation") this.context?.record(input.source, { user: input.text, assistant: answer });
			return { answer, model: modelOf(session.piSession.agent), durationMs: Date.now() - startedAt, usage: usageOf(session.piSession.agent) };
		});
	}

	async cancel(source: Source): Promise<boolean> { return this.sessions.abort(source); }
	async compact(source: Source, instructions?: string): Promise<boolean> {
		return (await this.sessions.withSession(source, async (session) => {
			if (session.busy) return false;
			await session.piSession.compact(instructions);
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
	async handleControl(input: AgentControlInput<Source>): Promise<AgentControlResult | undefined> {
		return this.controlHandler?.(input);
	}
	async setModel(source: Source, model: Model<Api>): Promise<boolean> {
		return (await this.sessions.withSession(source, async (session) => {
			if (session.busy) return false;
			await session.piSession.setModel(model);
			return true;
		})) ?? false;
	}
	isBusy(): boolean { return this.sessions.isBusy(); }
	dispose(): void { this.sessions.dispose(); }
}

export class AgentRunError extends Error {
	readonly timedOut: boolean;
	readonly cause: unknown;
	constructor(message: string, timedOut: boolean, cause: unknown) {
		super(message);
		this.name = "AgentRunError";
		this.timedOut = timedOut;
		this.cause = cause;
	}
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
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ConversationContext } from "./conversation-context.ts";
import {
	reloadRuntimeResourcesIfNeeded,
	type BeeMaxRuntimeSource,
} from "./runtime.ts";
import { SessionCoordinator, type RuntimeSessionFactory, type SessionCoordinatorOptions } from "./session-coordinator.ts";

export interface AgentRunInput<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	source: Source;
	text: string;
	timeoutMs: number;
	expandPromptTemplates?: boolean;
	mode?: "interactive" | "automation";
}

export interface AgentRunResult {
	answer: string;
	model: string;
	durationMs: number;
	usage: { input_tokens?: number; output_tokens?: number };
}

export type AgentRunEventSink = (event: AgentSessionEvent) => void | Promise<void>;

export interface BeeMaxAgentRuntimeOptions<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> extends SessionCoordinatorOptions {
	createAgent: RuntimeSessionFactory<Source>;
	createAutomationAgent?: RuntimeSessionFactory<Source>;
	context?: ConversationContext;
}

/**
 * The product-level Agent execution entry point. It owns prompt enrichment,
 * persistent session reuse, turn timeout, event subscription, resource reload
 * and candidate-memory capture. Channels only subscribe and present events.
 */
export class BeeMaxAgentRuntime<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	private readonly sessions: SessionCoordinator<Source>;
	private readonly createAgent: RuntimeSessionFactory<Source>;
	private readonly createAutomationAgent?: RuntimeSessionFactory<Source>;
	private readonly context?: ConversationContext;

	constructor(options: BeeMaxAgentRuntimeOptions<Source>) {
		this.sessions = new SessionCoordinator(options);
		this.createAgent = options.createAgent;
		this.createAutomationAgent = options.createAutomationAgent;
		this.context = options.context;
	}

	async run(input: AgentRunInput<Source>, onEvent?: AgentRunEventSink): Promise<AgentRunResult> {
		const factory = input.mode === "automation" ? this.createAutomationAgent ?? this.createAgent : this.createAgent;
		return this.sessions.run(input.source, factory, async (session) => {
			const startedAt = Date.now();
			const text = input.mode === "interactive" || !input.mode
				? this.context?.enrich(input.source, input.text) ?? input.text
				: input.text;
			const unsubscribe = onEvent ? session.piSession.subscribe((event) => { void onEvent(event); }) : undefined;
			let timedOut = false;
			const timeout = setTimeout(() => { timedOut = true; void session.piSession.abort(); }, input.timeoutMs);
			try {
				await session.piSession.prompt(text, { expandPromptTemplates: input.expandPromptTemplates ?? true, source: input.mode === "automation" ? "extension" : undefined });
			} catch (cause) {
				throw new AgentRunError(timedOut ? `Agent turn timed out after ${Math.round(input.timeoutMs / 60_000)} minutes` : errorMessage(cause), timedOut, cause);
			} finally {
				clearTimeout(timeout);
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
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

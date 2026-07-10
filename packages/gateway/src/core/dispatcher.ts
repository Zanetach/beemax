/**
 * The dispatcher wires a platform adapter to Pi agent sessions and renders
 * streaming replies as one continuously-updated Feishu interactive card.
 *
 * Pure-TS card pipeline (no Python sidecar):
 *   Pi AgentEvent -> CardSession.apply() -> renderCard() -> FlushController
 *     -> platform.sendCard() (first frame) / platform.updateCard() (deltas)
 *
 * The flush controller coalesces rapid text deltas into throttled card patches
 * (Feishu patch is 5 QPS limited), and drains immediately for terminal events.
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { InboundMessage, PlatformAdapter } from "./types.ts";
import { sessionIdForSource, sessionKeyForSource } from "./session-router.ts";
import { CardSession } from "../card/session.ts";
import { renderCard, type CardRenderOptions } from "../card/render.ts";
import { FlushController } from "../card/flush.ts";
import type { ToolApprovalBroker } from "./tool-approval.ts";
import { reloadResourcesIfNeeded } from "./resource-reload.ts";

export interface DispatcherSession {
	sessionKey: string;
	sessionId: string;
	piSession: AgentSession;
	busy: boolean;
	lastActiveAt: number;
}

export interface DispatcherDeps {
	createAgent(sessionId: string, source: InboundMessage["source"]): Promise<AgentSession>;
	createAutomationAgent?(sessionId: string, source: InboundMessage["source"]): Promise<AgentSession>;
	recall?: (source: InboundMessage["source"], text: string) => Promise<string | undefined>;
	remember?: (source: InboundMessage["source"], exchange: { user: string; assistant: string }) => Promise<void>;
	cardOptions?: CardRenderOptions;
	flushIntervalMs?: number;
	/** Bound long-running Gateway memory usage; busy sessions are never evicted. */
	maxSessions?: number;
	/** Dispose inactive sessions after this duration; JSONL state remains persistent. */
	sessionIdleMs?: number;
	/** Abort an individual interactive turn that exceeds this duration. */
	turnTimeoutMs?: number;
	approvalBroker?: ToolApprovalBroker;
	cancelTasks?: (source: InboundMessage["source"]) => number;
}

export class Dispatcher {
	private readonly sessions = new Map<string, DispatcherSession>();
	private readonly sessionCreations = new Map<string, Promise<DispatcherSession>>();
	private readonly lock = new Map<string, Promise<void>>();
	private readonly deps: DispatcherDeps;
	private readonly platform: PlatformAdapter;
	private readonly maxSessions: number;
	private readonly sessionIdleMs: number;
	private readonly turnTimeoutMs: number;

	constructor(deps: DispatcherDeps, platform: PlatformAdapter) {
		this.deps = deps;
		this.platform = platform;
		this.maxSessions = clamp(deps.maxSessions ?? 100, 1, 10_000);
		this.sessionIdleMs = clamp(deps.sessionIdleMs ?? 30 * 60_000, 60_000, 24 * 60 * 60_000);
		this.turnTimeoutMs = clamp(deps.turnTimeoutMs ?? 10 * 60_000, 30_000, 60 * 60_000);
		this.platform.onMessage((msg) => {
			void this.handle(msg).catch((error) => {
				console.error(`[beemax] message dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		});
	}

	private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.lock.get(key) ?? Promise.resolve();
		let resolve!: () => void;
		const next = new Promise<void>((r) => {
			resolve = r;
		});
		const chain = prev.then(() => next);
		this.lock.set(key, chain);
		await prev;
		try {
			return await fn();
		} finally {
			resolve();
			if (this.lock.get(key) === chain) this.lock.delete(key);
		}
	}

	private async getOrCreateSession(
		msg: InboundMessage,
		factory = this.deps.createAgent,
	): Promise<DispatcherSession> {
		const sessionKey = sessionKeyForSource(msg.source);
		const existing = this.sessions.get(sessionKey);
		if (existing) {
			existing.lastActiveAt = Date.now();
			return existing;
		}
		const pending = this.sessionCreations.get(sessionKey);
		if (pending) return pending;
		this.pruneSessions(Date.now(), 1);

		const creation = (async () => {
			const sessionId = sessionIdForSource(msg.source);
			const piSession = await factory(sessionId, msg.source);
			const session: DispatcherSession = { sessionKey, sessionId, piSession, busy: false, lastActiveAt: Date.now() };
			this.sessions.set(sessionKey, session);
			return session;
		})();
		this.sessionCreations.set(sessionKey, creation);
		try {
			return await creation;
		} finally {
			this.sessionCreations.delete(sessionKey);
		}
	}

	private async handle(msg: InboundMessage): Promise<void> {
		if (this.deps.approvalBroker && (await this.deps.approvalBroker.handleMessage(msg))) return;
		if (msg.text.trim().toLowerCase() === "/stop") {
			const existing = this.sessions.get(sessionKeyForSource(msg.source));
			if (existing) await existing.piSession.abort();
			const cancelled = this.deps.cancelTasks?.(msg.source) ?? 0;
			await this.platform.send(msg.source.chatId, `Stopped the active Agent turn and cancelled ${cancelled} Sub-Agent task(s).`);
			return;
		}
		const sessionKey = sessionKeyForSource(msg.source);
		await this.withLock(sessionKey, async () => {
			this.pruneSessions();
			const session = await this.getOrCreateSession(msg);
			session.busy = true;
			try {
				await this.runTurn(session, msg);
			} finally {
				session.busy = false;
				session.lastActiveAt = Date.now();
			}
		});
	}

	private async runTurn(session: DispatcherSession, msg: InboundMessage): Promise<void> {
		const startedAt = Date.now();
		session.lastActiveAt = startedAt;
		let userInput = msg.text;
		if (this.deps.recall) {
			const injected = await this.deps.recall(msg.source, msg.text);
			if (injected) userInput = injected;
		}

		const chatId = msg.source.chatId;
		const card = new CardSession();
		const flush = new FlushController(this.deps.flushIntervalMs ?? 800);
		let cardMessageId: string | undefined;

		const renderUpdate = async (): Promise<boolean> => {
			const rendered = renderCard(card, this.deps.cardOptions);
			if (!cardMessageId) {
				const res = await this.platform.sendCard(chatId, rendered, msg.source.messageId);
				if (res.success && res.messageId) cardMessageId = res.messageId;
				return res.success;
			}
			const res = await this.platform.updateCard(cardMessageId, rendered);
			return res.success;
		};

		const unsubscribe = session.piSession.subscribe((event: AgentSessionEvent) => {
			void this.onAgentEvent(event, card, flush, renderUpdate).catch((error) => {
				console.error(`[beemax] card update failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		});

		await this.platform.sendTyping(chatId).catch((error) => {
			console.warn(`[beemax] typing indicator failed: ${error instanceof Error ? error.message : String(error)}`);
		});

		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			void session.piSession.abort();
		}, this.turnTimeoutMs);
		try {
			await session.piSession.prompt(userInput);
		} catch (err) {
			const errorText = timedOut ? `Agent turn timed out after ${Math.round(this.turnTimeoutMs / 60_000)} minutes` : err instanceof Error ? err.message : String(err);
			card.apply("message.failed", { error: errorText });
			await flush.schedule(renderUpdate, true);
			await flush.drain(3000);
			if (!cardMessageId) await this.platform.send(chatId, `❌ ${errorText}`);
			await this.platform.stopTyping(chatId).catch(() => undefined);
			unsubscribe();
			flush.close();
			return;
		} finally {
			clearTimeout(timeout);
		}

		// Terminal: emit completed with footer stats, drain immediately.
		card.apply("message.completed", {
			answer: card.answerText || lastAssistantText(session.piSession.agent) || "(no response)",
			model: modelOf(session.piSession.agent),
			duration: (Date.now() - startedAt) / 1000,
			tokens: usageOf(session.piSession.agent),
		});
		await flush.schedule(renderUpdate, true);
		await flush.drain(5000);
		if (!cardMessageId) await this.platform.send(chatId, card.answerText || "(no response)");
		await this.platform.stopTyping(chatId).catch(() => undefined);
		unsubscribe();
		flush.close();

		try {
			if (await reloadResourcesIfNeeded(session.piSession)) {
				console.info("[beemax] skills and resources hot-reloaded after agent evolution");
			}
		} catch (error) {
			console.error(`[beemax] resource reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (this.deps.remember) {
			void this.deps.remember(msg.source, {
				user: msg.text,
				assistant: card.answerText || lastAssistantText(session.piSession.agent) || "",
			});
		}
	}

	isBusy(): boolean {
		return this.lock.size > 0 || [...this.sessions.values()].some((session) => session.busy);
	}

	async runAutomation(
		source: InboundMessage["source"],
		prompt: string,
		options: { key: string; timeoutMs: number },
	): Promise<string> {
		const automationSource = { ...source, threadId: `__automation:${options.key}`, messageId: undefined };
		const msg: InboundMessage = {
			text: prompt,
			messageType: "text",
			source: automationSource,
			mediaPaths: [],
			mediaTypes: [],
			raw: { automation: options.key },
			timestamp: Date.now(),
		};
		const factory = this.deps.createAutomationAgent ?? this.deps.createAgent;
		const sessionKey = sessionKeyForSource(msg.source);
		return this.withLock(sessionKey, async () => {
			this.pruneSessions();
			const session = await this.getOrCreateSession(msg, factory);
			session.busy = true;
			const timer = setTimeout(() => session.piSession.abort(), options.timeoutMs);
			try {
				await session.piSession.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
				const answer = lastAssistantText(session.piSession.agent).trim();
				if (!answer) throw new Error("Automation agent returned no answer");
				return answer;
			} finally {
				clearTimeout(timer);
				session.busy = false;
				session.lastActiveAt = Date.now();
			}
		});
	}

	dispose(): void {
		this.deps.approvalBroker?.dispose();
		for (const session of this.sessions.values()) session.piSession.dispose();
		this.sessions.clear();
	}

	private pruneSessions(now = Date.now(), reserve = 0): void {
		const idle = [...this.sessions.values()]
			.filter((session) => !session.busy)
			.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
		for (const session of idle) {
			if (now - session.lastActiveAt < this.sessionIdleMs && this.sessions.size + reserve <= this.maxSessions) break;
			session.piSession.dispose();
			this.sessions.delete(session.sessionKey);
		}
	}

	private async onAgentEvent(
		event: AgentSessionEvent,
		card: CardSession,
		flush: FlushController,
		renderUpdate: () => Promise<boolean>,
	): Promise<void> {
		switch (event.type) {
			case "tool_execution_start":
				card.apply("tool.updated", {
					tool_id: event.toolCallId,
					name: event.toolName,
					status: "running",
				});
				await flush.schedule(renderUpdate);
				break;
			case "tool_execution_end": {
				const status = event.isError ? "error" : "completed";
				card.apply("tool.updated", {
					tool_id: event.toolCallId,
					name: event.toolName,
					status,
					detail: toolResultSummary(event.result),
				});
				await flush.schedule(renderUpdate);
				break;
			}
			case "message_update": {
				if (event.assistantMessageEvent.type === "text_delta") {
					card.apply("answer.delta", { text: event.assistantMessageEvent.delta });
					await flush.schedule(renderUpdate);
				} else if (event.assistantMessageEvent.type === "thinking_delta") {
					card.apply("thinking.delta", { text: event.assistantMessageEvent.delta });
					await flush.schedule(renderUpdate);
				}
				break;
			}
		}
	}
}

function assistantText(message: { role: string; content?: unknown }): string {
	if (!Array.isArray((message as { content?: unknown[] }).content)) return "";
	const parts: string[] = [];
	for (const block of (message as { content: unknown[] }).content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("");
}

function lastAssistantText(agent: Agent): string {
	const state = agent.state;
	const last = state.messages[state.messages.length - 1];
	if (!last || last.role !== "assistant") return "";
	return assistantText(last);
}

function modelOf(agent: Agent): string {
	return agent.state.model?.id ?? "Unknown";
}

function usageOf(agent: Agent): { input_tokens?: number; output_tokens?: number } {
	const state = agent.state;
	const last = state.messages[state.messages.length - 1];
	if (!last || last.role !== "assistant") return {};
	return { input_tokens: last.usage.input, output_tokens: last.usage.output };
}

function toolResultSummary(result: unknown): string {
	if (typeof result === "string") return result.slice(0, 200);
	if (result && typeof result === "object") {
		const r = result as { content?: Array<{ text?: string }> };
		const text = r.content?.map((c) => c.text ?? "").join("");
		if (text) return text.slice(0, 200);
	}
	return "";
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

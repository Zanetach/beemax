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

import {
	AgentRunError,
	sessionOwnerKey,
	type ToolApprovalBroker,
	type AgentSessionEvent,
	type AgentRuntimePort,
} from "@beemax/core";
import type { InboundMessage, PlatformAdapter } from "./types.ts";
import { CardSession } from "../card/session.ts";
import { renderCard, type CardRenderOptions } from "../card/render.ts";
import { FlushController } from "../card/flush.ts";
import { MessageDeduplicator } from "./message-deduplicator.ts";

export interface DispatcherDeps {
	runtime: AgentRuntimePort<InboundMessage["source"]>;
	cardOptions?: CardRenderOptions;
	flushIntervalMs?: number;
	/** Abort an individual interactive turn that exceeds this duration. */
	turnTimeoutMs?: number;
	approvalBroker?: ToolApprovalBroker;
	cancelTasks?: (source: InboundMessage["source"]) => number;
	/** Isolated deployment/profile identity used for ingress idempotency. */
	profileId?: string;
	messageDeduplicator?: MessageDeduplicator;
}

export class Dispatcher {
	private readonly runtime: AgentRuntimePort<InboundMessage["source"]>;
	private readonly deps: DispatcherDeps;
	private readonly platform: PlatformAdapter;
	private readonly turnTimeoutMs: number;
	private readonly profileId: string;
	private readonly deduplicator: MessageDeduplicator;
	private readonly sessionOverrides = new Map<string, InboundMessage["source"]>();
	private static readonly maxSessionOverrides = 10_000;

	constructor(deps: DispatcherDeps, platform: PlatformAdapter) {
		this.deps = deps;
		this.platform = platform;
		this.runtime = deps.runtime;
		this.turnTimeoutMs = Math.max(30_000, Math.min(60 * 60_000, deps.turnTimeoutMs ?? 10 * 60_000));
		this.profileId = deps.profileId ?? "default";
		this.deduplicator = deps.messageDeduplicator ?? new MessageDeduplicator();
		this.platform.onMessage((msg) => {
			return this.handle(msg).catch((error) => {
				console.error(`[beemax] message dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		});
	}

	private async handle(msg: InboundMessage): Promise<void> {
		if (!this.deduplicator.accept(this.profileId, msg.source.platform, msg.source.messageId)) return;
		const effective = { ...msg, source: this.sessionOverrides.get(sessionOwnerKey(msg.source)) ?? msg.source };
		if (this.deps.approvalBroker && (await this.deps.approvalBroker.handleReply(effective.source, effective.text))) return;
		const control = await this.runtime.handleControl({ source: effective.source, text: effective.text });
		if (control?.handled) {
			if (control.nextSource) this.setSessionOverride(msg.source, control.nextSource.threadId);
			await this.platform.send(msg.source.chatId, control.message);
			return;
		}
		if (effective.text.trim().toLowerCase() === "/stop") {
			await this.runtime.cancel(effective.source);
			const cancelled = this.deps.cancelTasks?.(effective.source) ?? 0;
			await this.platform.send(msg.source.chatId, `Stopped the active Agent turn and cancelled ${cancelled} Sub-Agent task(s).`);
			return;
		}
		await this.runTurn(effective);
	}

	private async runTurn(msg: InboundMessage): Promise<void> {
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

		await this.platform.sendTyping(chatId).catch((error) => {
			console.warn(`[beemax] typing indicator failed: ${error instanceof Error ? error.message : String(error)}`);
		});

		let result;
		try {
			result = await this.runtime.run({ source: msg.source, text: msg.text, timeoutMs: this.turnTimeoutMs, mode: "interactive" }, (event: AgentSessionEvent) => {
				void this.onAgentEvent(event, card, flush, renderUpdate).catch((error) => {
					console.error(`[beemax] card update failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			});
		} catch (err) {
			const errorText = err instanceof AgentRunError ? err.message : err instanceof Error ? err.message : String(err);
			card.apply("message.failed", { error: errorText });
			await flush.schedule(renderUpdate, true);
			await flush.drain(3000);
			if (!cardMessageId) await this.platform.send(chatId, `❌ ${errorText}`);
			await this.platform.stopTyping(chatId).catch(() => undefined);
			flush.close();
			return;
		}

		// Terminal: emit completed with footer stats, drain immediately.
		card.apply("message.completed", {
			answer: card.answerText || result.answer,
			model: result.model,
			duration: result.durationMs / 1000,
			tokens: result.usage,
		});
		await flush.schedule(renderUpdate, true);
		await flush.drain(5000);
		if (!cardMessageId) await this.platform.send(chatId, card.answerText || result.answer);
		await this.platform.stopTyping(chatId).catch(() => undefined);
		flush.close();
	}

	isBusy(): boolean {
		return this.runtime.isBusy();
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
		const result = await this.runtime.run({ source: msg.source, text: prompt, timeoutMs: options.timeoutMs, expandPromptTemplates: false, mode: "automation" });
		if (!result.answer.trim() || result.answer === "(no response)") throw new Error("Automation agent returned no answer");
		return result.answer.trim();
	}

	dispose(): void {
		this.deps.approvalBroker?.dispose();
	}

	private setSessionOverride(source: InboundMessage["source"], threadId: string | undefined): void {
		const key = sessionOwnerKey(source);
		this.sessionOverrides.delete(key);
		if (this.sessionOverrides.size >= Dispatcher.maxSessionOverrides) {
			const oldest = this.sessionOverrides.keys().next().value;
			if (oldest) this.sessionOverrides.delete(oldest);
		}
		this.sessionOverrides.set(key, { ...source, threadId });
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

function toolResultSummary(result: unknown): string {
	if (typeof result === "string") return result.slice(0, 200);
	if (result && typeof result === "object") {
		const r = result as { content?: Array<{ text?: string }> };
		const text = r.content?.map((c) => c.text ?? "").join("");
		if (text) return text.slice(0, 200);
	}
	return "";
}

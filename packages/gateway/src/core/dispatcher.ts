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
	InteractionEventAdapter,
	parseInteractionCommand,
	sessionOwnerKey,
	type ToolApprovalBroker,
	type InteractionEvent,
	type AgentRuntimePort,
} from "@beemax/core";
import type { InboundMessage, PlatformAdapter, PlatformCardAction } from "./types.ts";
import { CardSession } from "../card/session.ts";
import { renderCard, type CardRenderOptions } from "../card/render.ts";
import { FlushController } from "../card/flush.ts";
import { MessageDeduplicator } from "./message-deduplicator.ts";
import { prepareAgentMediaInput } from "./media-input.ts";
import { AdaptiveTextBuffer } from "./stream-presentation.ts";
import { TurnStatusPulse } from "./turn-status.ts";

interface CardBinding {
	source: InboundMessage["source"];
	pendingApprovalId?: string;
}

export interface DispatcherDeps {
	runtime: AgentRuntimePort<InboundMessage["source"]>;
	/** Core semantic boundary. When omitted, legacy callers get a local adapter. */
	interaction?: InteractionEventAdapter<InboundMessage["source"]>;
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
	private readonly interaction: InteractionEventAdapter<InboundMessage["source"]>;
	private readonly deps: DispatcherDeps;
	private readonly platform: PlatformAdapter;
	private readonly turnTimeoutMs: number;
	private readonly profileId: string;
	private readonly deduplicator: MessageDeduplicator;
	private readonly sessionOverrides = new Map<string, InboundMessage["source"]>();
	private readonly cardBindings = new Map<string, CardBinding>();
	private static readonly maxSessionOverrides = 10_000;

	constructor(deps: DispatcherDeps, platform: PlatformAdapter) {
		this.deps = deps;
		this.platform = platform;
		this.runtime = deps.runtime;
		this.interaction = deps.interaction ?? new InteractionEventAdapter(deps.runtime, {
			approvalBroker: deps.approvalBroker,
			cancelSubagents: deps.cancelTasks,
		});
		this.turnTimeoutMs = Math.max(30_000, Math.min(60 * 60_000, deps.turnTimeoutMs ?? 10 * 60_000));
		this.profileId = deps.profileId ?? "default";
		this.deduplicator = deps.messageDeduplicator ?? new MessageDeduplicator();
		this.platform.onMessage((msg) => {
			return this.handle(msg).catch((error) => {
				console.error(`[beemax] message dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		});
		this.platform.onCardAction?.((action) => this.handleCardAction(action));
	}

	private async handle(msg: InboundMessage): Promise<void> {
		try {
			if (!this.deduplicator.accept(this.profileId, msg.source.platform, msg.source.messageId)) return;
			const effective = { ...msg, source: this.sessionOverrides.get(sessionOwnerKey(msg.source)) ?? msg.source };
			const command = parseInteractionCommand(effective.text);
			if (command?.kind === "stop") {
				const outcome = await this.interaction.dispatch({ type: "turn.cancel", source: effective.source });
				if (!("cancelled" in outcome)) throw new Error("Cancellation dispatch did not produce a cancellation result");
				await this.platform.send(msg.source.chatId, `${outcome.cancelled ? "已停止当前任务" : "当前没有正在执行的任务"}${outcome.subagentsCancelled ? `；同时取消 ${outcome.subagentsCancelled} 个子任务` : ""}${outcome.approvalCancelled ? "；已取消待审批操作" : ""}。`);
				return;
			}
			if (await this.interaction.handleApprovalReply(effective.source, effective.text)) return;
			const control = await this.runtime.handleControl({ source: effective.source, text: effective.text });
			if (control?.handled) {
				if (control.nextSource) this.setSessionOverride(msg.source, control.nextSource.threadId);
				await this.platform.send(msg.source.chatId, control.message);
				return;
			}
			const snapshot = await this.interaction.snapshot(effective.source);
			if (["running", "queued", "awaiting_approval"].includes(snapshot.phase)) {
				const queued = command?.kind === "steer"
					? await this.interaction.dispatch({ type: "turn.steer", source: effective.source, text: command.text })
					: await this.interaction.dispatch({ type: "turn.queue", source: effective.source, text: effective.text });
				if (!("queued" in queued) || !queued.queued) throw new Error("Active Agent turn rejected follow-up input");
				const feedback = queued.mode === "steer"
					? "已更新当前任务要求，Agent 会在下一步按新要求继续。"
					: queued.mode === "follow_up"
						? "已收到补充消息，将在当前任务中继续处理。"
						: queued.replaced
							? "已更新下一条待处理消息。"
							: `已加入当前会话队列${queued.position > 0 ? `（第 ${queued.position} 条）` : ""}。`;
				await this.platform.send(msg.source.chatId, `${feedback} 发送 /stop 可随时停止。`);
				return;
			}
			await this.runTurn(effective);
		} finally {
			await msg.releaseMedia?.().catch((error) => {
				console.warn(`[beemax] temporary inbound media cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
	}

	private async runTurn(msg: InboundMessage): Promise<void> {
		const chatId = msg.source.chatId;
		const card = new CardSession();
		const flush = new FlushController(this.deps.flushIntervalMs ?? 800);
		let cardMessageId: string | undefined;

		const renderUpdate = async (): Promise<boolean> => {
			const rendered = renderCard(card, this.deps.cardOptions);
			if (!cardMessageId) {
				const res = await this.platform.sendCard(chatId, rendered, msg.source.messageId, Boolean(msg.source.threadId));
				if (res.success && res.messageId) {
					cardMessageId = res.messageId;
					this.rememberCardBinding(res.messageId, msg.source, card.pendingApprovalId);
				}
				return res.success;
			}
			const res = await this.platform.updateCard(cardMessageId, rendered);
			if (res.success) this.rememberCardBinding(cardMessageId, msg.source, card.pendingApprovalId);
			return res.success;
		};
		const answerBuffer = new AdaptiveTextBuffer(async (chunk) => {
			card.apply("answer.delta", { text: chunk });
			await flush.schedule(renderUpdate);
		});
		const statusPulse = new TurnStatusPulse(async (message) => {
			card.apply("notice.updated", { id: "turn:status", label: "当前状态", status: "running", message });
			await flush.schedule(renderUpdate);
		});
		statusPulse.start();

		await this.platform.sendTyping(chatId, msg.source.messageId).catch((error) => {
			console.warn(`[beemax] typing indicator failed: ${error instanceof Error ? error.message : String(error)}`);
		});

		let failed = false;
		try {
			let result;
			try {
				const media = await prepareAgentMediaInput(msg);
				result = await this.interaction.dispatch({ type: "message.send", source: msg.source, text: media.text, input: { timeoutMs: this.turnTimeoutMs, mode: "interactive", images: media.images } }, (event) => this.onInteractionEvent(event, card, flush, answerBuffer, statusPulse, renderUpdate));
				if (!("answer" in result)) throw new Error("Message dispatch did not produce an Agent result");
			} catch (err) {
				failed = true;
				const errorText = err instanceof AgentRunError ? err.message : err instanceof Error ? err.message : String(err);
				if (card.status !== "cancelled") card.apply("message.failed", { error: errorText });
				await flush.schedule(renderUpdate, true);
				await flush.drain(3000);
				if (!cardMessageId) await this.platform.send(chatId, `❌ ${errorText}`);
				return;
			}

			// Terminal event already owns completion; only drain its final card patch.
			await flush.schedule(renderUpdate, true);
			await flush.drain(5000);
			if (!cardMessageId) await this.platform.send(chatId, card.answerText || result.answer);
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			statusPulse.stop();
			await answerBuffer.close();
			await this.platform.stopTyping(chatId, msg.source.messageId, failed).catch(() => undefined);
			flush.close();
		}
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

	private async handleCardAction(action: PlatformCardAction): Promise<void> {
		const binding = this.cardBindings.get(action.messageId);
		const source = binding?.source;
		if (!binding || !source || source.chatId !== action.chatId) return;
		const expectedUserIds = [source.userId, source.userIdAlt].filter((value): value is string => Boolean(value));
		const actionUserIds = [action.userId, action.userIdAlt].filter((value): value is string => Boolean(value));
		const sameUser = expectedUserIds.length > 0 && actionUserIds.some((value) => expectedUserIds.includes(value));
		if (!sameUser || action.value.beemax_action !== "approval.decide") return;
		const choice = action.value.choice;
		if (choice !== "once" && choice !== "session" && choice !== "deny") return;
		if (typeof action.value.approval_id !== "string" || action.value.approval_id !== binding.pendingApprovalId) return;
		// Consume before dispatch so concurrent/re-delivered clicks fail closed.
		binding.pendingApprovalId = undefined;
		await this.interaction.dispatch({ type: "approval.decide", source, choice, actionId: action.actionId });
	}

	private rememberCardBinding(messageId: string, source: InboundMessage["source"], pendingApprovalId?: string): void {
		this.cardBindings.delete(messageId);
		if (this.cardBindings.size >= Dispatcher.maxSessionOverrides) this.cardBindings.delete(this.cardBindings.keys().next().value!);
		this.cardBindings.set(messageId, { source: { ...source }, pendingApprovalId });
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

	private async onInteractionEvent(
		event: InteractionEvent,
		card: CardSession,
		flush: FlushController,
		answerBuffer: AdaptiveTextBuffer,
		statusPulse: TurnStatusPulse,
		renderUpdate: () => Promise<boolean>,
	): Promise<void> {
		switch (event.type) {
			case "tool.changed":
				card.apply("tool.updated", {
					tool_id: event.callId,
					name: event.name,
					status: event.state === "failed" ? "error" : event.state,
					detail: event.summary,
				});
				await flush.schedule(renderUpdate);
				break;
			case "answer.delta":
				statusPulse.contentStarted();
				answerBuffer.push(event.text);
				break;
			case "reasoning.delta":
				card.apply("thinking.delta", { text: event.text });
				break;
			case "model.fallback":
				card.apply("notice.updated", { id: `model:${event.turnId}:${event.attempt}`, label: "模型回退", status: "running", message: `${event.from} 暂时不可用，已切换到 ${event.to}` });
				await flush.schedule(renderUpdate);
				break;
			case "planning.selected":
				card.apply("notice.updated", { id: `planning:${event.turnId}`, label: "执行规划", status: "running", message: `${event.mode} · 并发 ${event.concurrency} · 子代理上限 ${event.maxSubagents}${event.requiredTools.length ? ` · ${event.requiredTools.join(" → ")}` : ""}` });
				await flush.schedule(renderUpdate);
				break;
			case "planning.completed":
				card.apply("notice.updated", { id: `planning:${event.turnId}`, label: "执行规划", status: event.compliant ? "completed" : "error", message: `${event.mode}${event.corrected ? " · 已自动纠正" : ""}` });
				await flush.schedule(renderUpdate);
				break;
			case "turn.failed":
				statusPulse.stop();
				await answerBuffer.flush();
				card.apply("message.failed", { error: event.error });
				await flush.schedule(renderUpdate, true);
				break;
			case "turn.cancelled":
				statusPulse.stop();
				await answerBuffer.flush();
				card.apply("message.cancelled", { message: "运行已取消" });
				await flush.schedule(renderUpdate, true);
				break;
			case "turn.finished":
				statusPulse.stop();
				await answerBuffer.flush();
				card.apply("message.completed", { answer: card.answerText || event.result.answer, model: event.result.model, duration: event.result.durationMs / 1000, tokens: event.result.usage });
				await flush.schedule(renderUpdate, true);
				break;
			case "approval.requested":
				card.apply("approval.updated", {
					id: `approval:${event.turnId}`,
					status: "pending",
					message: event.details
						? `等待审批：${event.toolName}\n目标：${event.details.target}\n风险：${event.details.risk} · ${event.details.impact}\n可逆性：${event.details.reversibility}\n回复 1（一次）/ 2（本会话）/ 3（拒绝），或 /stop 取消。`
						: `等待审批：${event.toolName}`,
				});
				await flush.schedule(renderUpdate);
				break;
			case "approval.resolved":
				card.apply("approval.updated", { id: `approval:${event.turnId}`, status: event.allowed ? "allowed" : "denied", message: `${event.toolName}：${event.allowed ? "已允许" : "已拒绝"}` });
				await flush.schedule(renderUpdate);
				break;
			case "turn.queued":
				card.apply("approval.updated", {
					id: `queue:${event.turnId}`,
					status: "queued",
					message: event.mode === "steer"
						? "已更新当前任务要求"
						: event.mode === "follow_up"
							? "已收到补充消息，将在当前任务中继续处理"
							: `${event.mode === "steer_fallback" ? "当前运行时不支持中途引导，" : ""}${event.replaced ? "已更新下一条待处理消息" : `消息已进入当前会话队列（第 ${event.position} 条）`}`,
				});
				await flush.schedule(renderUpdate);
				break;
		}
	}
}

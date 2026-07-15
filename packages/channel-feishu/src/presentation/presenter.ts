import { AdaptiveTextBuffer, TurnStatusPulse, interactionCompletionDeliveryKey, type DeliveryOptions, type DeliveryReceipt, type InteractionEvent } from "@beemax/core";
import { formatApprovalRequest, formatWorkProgress, type InteractionPresentationOpen, type InteractionPresenter, type SendOptions, type SendResult, type TurnPresentation, type WorkProgressPresentation } from "@beemax/channel-runtime";
import { FlushController } from "./flush.ts";
import { renderCard, type CardRenderOptions } from "./render.ts";
import { CardSession } from "./session.ts";

interface FeishuPresentationTransport {
	send(chatId: string, content: string, options?: SendOptions): Promise<SendResult>;
	sendCard(chatId: string, card: Record<string, unknown>, replyTo?: string, replyInThread?: boolean, idempotencyKey?: string): Promise<SendResult>;
	updateCard(messageId: string, card: Record<string, unknown>): Promise<SendResult>;
	sendTyping(chatId: string, messageId?: string): Promise<void>;
	stopTyping(chatId: string, messageId?: string, failed?: boolean): Promise<void>;
}

/** Feishu owns CardKit state, rendering, throttling, delivery, and degradation. */
export class FeishuInteractionPresenter implements InteractionPresenter {
	private readonly transport: FeishuPresentationTransport;
	constructor(transport: FeishuPresentationTransport) { this.transport = transport; }
	open(input: InteractionPresentationOpen): TurnPresentation { return new FeishuTurnPresentation(this.transport, input); }
	async presentWorkProgress({ target, event, idempotencyKey }: WorkProgressPresentation): Promise<void> {
		const card = new CardSession();
		card.apply("notice.updated", {
			id: `work:${event.workId}`, label: "异步任务计划", status: event.state === "failed" ? "error" : event.state,
			message: formatWorkProgress(event),
		});
		try {
			const result = await this.transport.sendCard(target.chatId, renderCard(card), undefined, Boolean(target.threadId), idempotencyKey);
			if (result.success) return;
		} catch (error) {
			console.warn(`[beemax] Feishu work progress card failed: ${safeError(error)}`);
		}
		const fallback = await this.transport.send(target.chatId, formatWorkProgress(event), { idempotencyKey });
		if (!fallback.success) throw new Error(fallback.error ?? `Failed to present Task Plan ${event.workId}`);
	}
}

class FeishuTurnPresentation implements TurnPresentation {
	private readonly transport: FeishuPresentationTransport;
	private readonly input: InteractionPresentationOpen;
	private readonly card = new CardSession();
	private readonly flush: FlushController;
	private readonly answerBuffer: AdaptiveTextBuffer;
	private readonly statusPulse: TurnStatusPulse;
	private readonly renderOptions: CardRenderOptions;
	private cardMessageId?: string;
	private cardCreation?: Promise<SendResult>;
	private cardUpdate?: Promise<boolean>;
	private pendingCardRender?: Record<string, unknown>;
	private degraded = false;
	private readonly interactionIdempotencyKey: string;

	constructor(transport: FeishuPresentationTransport, input: InteractionPresentationOpen) {
		this.transport = transport;
		this.input = input;
		this.interactionIdempotencyKey = input.source.messageId
			? `${interactionCompletionDeliveryKey(input.profileId, input.source, input.source.messageId)}:progress`
			: `${input.profileId}:turn`;
		this.flush = new FlushController(input.preferences?.updateIntervalMs ?? 350);
		this.renderOptions = { title: input.preferences?.title, reasoningDisplay: input.preferences?.reasoningDisplay };
		this.answerBuffer = new AdaptiveTextBuffer(async (chunk) => {
			try { this.card.apply("answer.delta", { text: chunk }); await this.flush.schedule(() => this.renderUpdate(), false, true); }
			catch (error) { console.error(`[beemax] Feishu answer presenter failed: ${safeError(error)}`); }
		}, { minChunkChars: 6, preferredChunkChars: 28, maxChunkChars: 80, maxWaitMs: 50, flushSmallOnMaxWait: true });
		this.statusPulse = new TurnStatusPulse(async (message) => {
			this.card.apply("notice.updated", { id: "turn:status", label: "当前状态", status: "running", message });
			await this.flush.schedule(() => this.renderUpdate(), false, true);
		});
	}

	async start(): Promise<void> {
		await settleWithin(this.statusPulse.start(), this.ioTimeout());
		await this.transport.sendTyping(this.input.source.chatId, this.input.source.messageId).catch((error) => console.warn(`[beemax] Feishu typing indicator failed: ${safeError(error)}`));
	}

	async onEvent(event: InteractionEvent): Promise<void> {
		switch (event.type) {
			case "tool.changed":
				this.card.apply("notice.updated", { id: "turn:status", label: "当前状态", status: "running", message: event.state === "running" ? `正在执行 ${event.name}` : event.state === "failed" ? "操作未成功 · 正在处理" : "操作完成 · 正在整理结果" });
				this.card.apply("tool.updated", { tool_id: event.callId, name: event.name, status: event.state === "failed" ? "error" : event.state, detail: event.summary });
				await this.flush.schedule(() => this.renderUpdate(), false, true); break;
			case "answer.delta": this.statusPulse.contentStarted(); this.answerBuffer.push(event.text); break;
			case "reasoning.delta": this.card.apply("thinking.delta", { text: event.text }); break;
			case "model.fallback":
				this.card.apply("notice.updated", { id: `model:${event.turnId}:${event.attempt}`, label: "模型回退", status: "running", message: `${event.from} 暂时不可用，已切换到 ${event.to}` });
				await this.flush.schedule(() => this.renderUpdate(), false, true); break;
			case "planning.selected":
				this.card.apply("notice.updated", { id: `planning:${event.turnId}`, label: "执行规划", status: "running", message: `${event.mode} · 并发 ${event.concurrency} · 子代理上限 ${event.maxSubagents}${event.requiredTools.length ? ` · ${event.requiredTools.join(" → ")}` : ""}` });
				await this.flush.schedule(() => this.renderUpdate(), false, true); break;
			case "planning.completed":
				this.card.apply("notice.updated", { id: `planning:${event.turnId}`, label: "执行规划", status: event.compliant ? "completed" : "error", message: `${event.mode}${event.corrected ? " · 已自动纠正" : ""}` });
				await this.flush.schedule(() => this.renderUpdate(), false, true); break;
			case "work.changed":
				this.card.apply("notice.updated", { id: `work:${event.workId}`, label: event.kind === "subagent" ? "并行子任务" : "异步任务计划", status: event.state === "failed" ? "error" : event.state, message: event.summary ?? (event.state === "queued" ? "已排队" : event.state === "running" ? "运行中" : event.state === "completed" ? "已完成" : event.state === "cancelled" ? "已取消" : "执行失败") });
				await this.flush.schedule(() => this.renderUpdate(), false, true); break;
			case "turn.failed":
				await this.stopPulse(); await this.answerBuffer.flush(); this.card.apply("message.failed", { error: event.error });
				await this.flush.schedule(() => this.renderUpdate(), true); break;
			case "turn.cancelled":
				await this.stopPulse(); await this.answerBuffer.flush(); this.card.apply("message.cancelled", { message: "运行已取消" });
				await this.flush.schedule(() => this.renderUpdate(), true); break;
			case "turn.finished":
				await this.stopPulse(); await this.answerBuffer.flush(); this.card.apply("message.completed", { answer: this.card.answerText || event.result.answer, model: event.result.model, duration: event.result.durationMs / 1000, tokens: event.result.usage });
				await this.flush.schedule(() => this.renderUpdate(), true); break;
			case "approval.requested": {
				const message = formatApprovalRequest(event);
				this.card.apply("approval.updated", { id: `approval:${event.turnId}`, status: "pending", message });
				await this.flush.schedule(() => this.renderUpdate(), false, true);
				break;
			}
			case "approval.resolved":
				this.card.apply("approval.updated", { id: `approval:${event.turnId}`, status: event.allowed ? "allowed" : "denied", message: `${event.toolName}：${event.allowed ? "已允许" : "已拒绝"}` });
				await this.flush.schedule(() => this.renderUpdate(), false, true); break;
			case "turn.queued":
				this.card.apply("approval.updated", { id: `queue:${event.turnId}`, status: "queued", message: event.mode === "steer" ? "已更新当前任务要求" : event.mode === "follow_up" ? "已收到补充消息，将在当前任务中继续处理" : `${event.mode === "steer_fallback" ? "当前运行时不支持中途引导，" : ""}${event.replaced ? "已更新下一条待处理消息" : `消息已进入当前会话队列（第 ${event.position} 条）`}` });
				await this.flush.schedule(() => this.renderUpdate(), false, true); break;
		}
	}

	async finish(answer: string, options?: DeliveryOptions): Promise<DeliveryReceipt> {
		await this.answerBuffer.flush();
		if (!this.card.answerText && answer) this.card.apply("answer.delta", { text: answer });
		await this.flush.schedule(() => this.renderUpdate(), true);
		const drained = await this.flush.drain(5_000);
		if (options?.idempotencyKey) {
			// The rich card is transient progress. A canonical text delivery uses the
			// durable Completion key so Outbox recovery can replay the exact same
			// provider operations, including every chunk of a long result.
			const result = await this.sendFallback(answer, options.idempotencyKey);
			return { idempotencyKey: options.idempotencyKey, deliveredAt: Date.now(), ...(result.messageId ? { providerMessageId: result.messageId } : {}) };
		}
		if (this.cardMessageId && drained && !this.degraded) {
			return { idempotencyKey: this.interactionIdempotencyKey, deliveredAt: Date.now(), providerMessageId: this.cardMessageId };
		}
		const fallbackKey = `${this.interactionIdempotencyKey}:fallback`;
		const result = await this.sendFallback(this.card.answerText || answer, fallbackKey);
		return { idempotencyKey: fallbackKey, deliveredAt: Date.now(), ...(result.messageId ? { providerMessageId: result.messageId } : {}) };
	}

	async fail(error: string): Promise<void> {
		if (this.card.status !== "cancelled" && this.card.status !== "failed") this.card.apply("message.failed", { error });
		await this.flush.schedule(() => this.renderUpdate(), true);
		await this.flush.drain(3_000);
		if (!this.cardMessageId || this.degraded) await this.sendFallback(`❌ ${error}`);
	}

	async close(failed: boolean): Promise<void> {
		await this.stopPulse();
		await this.answerBuffer.close();
		await this.transport.stopTyping(this.input.source.chatId, this.input.source.messageId, failed).catch(() => undefined);
		this.flush.close();
	}

	private async renderUpdate(): Promise<boolean> {
		const rendered = renderCard(this.card, this.renderOptions);
		if (!this.cardMessageId) {
			if (!this.cardCreation) {
				this.cardCreation = this.transport.sendCard(this.input.source.chatId, rendered, this.input.source.replyToMessageId ?? this.input.source.messageId, Boolean(this.input.source.threadId), this.interactionIdempotencyKey).then((result) => {
					if (result.success && result.messageId) { this.cardMessageId = result.messageId; this.input.onBinding?.(result.messageId, this.card.pendingApprovalId); }
					return result;
				});
			}
			const result = await settleWithin(this.cardCreation, this.ioTimeout());
			if (!result) { this.degraded = true; return false; }
			this.degraded = !result.success; return result.success;
		}
		this.pendingCardRender = rendered;
		if (!this.cardUpdate) {
			this.cardUpdate = (async () => {
				let success = true;
				while (this.pendingCardRender) {
					const next = this.pendingCardRender; this.pendingCardRender = undefined;
					const result = await this.transport.updateCard(this.cardMessageId!, next);
					success = success && result.success;
					if (result.success) this.input.onBinding?.(this.cardMessageId!, this.card.pendingApprovalId);
				}
				return success;
			})().finally(() => { this.cardUpdate = undefined; });
		}
		const success = await settleWithin(this.cardUpdate, this.ioTimeout());
		if (success === undefined) { this.degraded = true; return false; }
		this.degraded = !success; return success;
	}

	private ioTimeout(): number { return this.input.preferences?.ioTimeoutMs ?? 2_000; }
	private async stopPulse(): Promise<void> { await this.statusPulse.stop().catch((error) => console.error(`[beemax] Feishu status presenter failed: ${safeError(error)}`)); }
	private async sendFallback(text: string, idempotencyKey?: string): Promise<SendResult> {
		const result = await this.transport.send(this.input.source.chatId, text, {
			...(idempotencyKey ? { idempotencyKey } : {}),
			...(this.input.source.replyToMessageId ? { replyTo: this.input.source.replyToMessageId, replyInThread: Boolean(this.input.source.threadId) } : {}),
		});
		if (!result.success) throw new Error(result.error ?? "Feishu text fallback failed");
		return result;
	}
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([operation, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(10, timeoutMs)); })]); }
	finally { if (timer) clearTimeout(timer); }
}

function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

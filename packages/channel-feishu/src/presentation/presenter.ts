import { interactionCompletionDeliveryKey, interactionPhaseForOutcome, type DeliveryOptions, type DeliveryReceipt, type InteractionEvent } from "@beemax/core";
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

type FinishedResult = Extract<InteractionEvent, { type: "turn.finished" }>["result"];
type ProgressStage = "understanding" | "planning" | "working" | "recovering" | "composing";

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
	private readonly renderOptions: CardRenderOptions;
	private cardMessageId?: string;
	private cardCreation?: Promise<SendResult>;
	private cardCreationPending = false;
	private cardUpdate?: Promise<boolean>;
	private pendingCardRender?: Record<string, unknown>;
	private progressTimer?: ReturnType<typeof setTimeout>;
	private progressReady = false;
	private progressUpdateCount = 0;
	private progressStage: ProgressStage = "understanding";
	private pendingCompletion?: FinishedResult;
	private terminalPresented = false;
	private degraded = false;
	private readonly progressIdempotencyKey: string;
	private readonly resultIdempotencyKey: string;

	constructor(transport: FeishuPresentationTransport, input: InteractionPresentationOpen) {
		this.transport = transport;
		this.input = input;
		const interactionKey = input.source.messageId
			? interactionCompletionDeliveryKey(input.profileId, input.source, input.source.messageId)
			: `${input.profileId}:turn`;
		this.progressIdempotencyKey = `${interactionKey}:progress`;
		this.resultIdempotencyKey = `${interactionKey}:result`;
		this.flush = new FlushController(input.preferences?.updateIntervalMs ?? 350);
		this.renderOptions = { title: input.preferences?.title, reasoningDisplay: input.preferences?.reasoningDisplay };
	}

	async start(): Promise<void> {
		this.card.apply("notice.updated", { id: "turn:status", label: "当前状态", status: "running", message: "正在理解你的需求" });
		const delayMs = Math.max(0, this.input.preferences?.progressDelayMs ?? 5_000);
		if (delayMs === 0) {
			this.progressReady = true;
			await this.publishProgress();
		} else {
			this.progressTimer = setTimeout(() => {
				this.progressTimer = undefined;
				if (this.terminalPresented) return;
				this.progressReady = true;
				void this.publishProgress().catch((error) => console.error(`[beemax] Feishu progress presenter failed: ${safeError(error)}`));
			}, delayMs);
		}
		await this.transport.sendTyping(this.input.source.chatId, this.input.source.messageId).catch((error) => console.warn(`[beemax] Feishu typing indicator failed: ${safeError(error)}`));
	}

	async onEvent(event: InteractionEvent): Promise<void> {
		switch (event.type) {
			case "tool.changed": {
				this.card.apply("tool.updated", { tool_id: event.callId, name: event.name, status: event.state === "failed" ? "error" : event.state, detail: event.summary });
				await this.setProgress(
					event.state === "running" ? "working" : event.state === "failed" ? "recovering" : "composing",
					event.state === "running" ? "正在获取并处理所需信息" : event.state === "failed" ? "操作未成功，正在切换方案" : "资料已取得，正在生成结果",
				);
				break;
			}
			case "answer.delta":
				await this.setProgress("composing", "正在生成最终结果");
				break;
			case "reasoning.delta": this.card.apply("thinking.delta", { text: event.text }); break;
			case "model.fallback": break;
			case "planning.selected":
				this.card.apply("notice.updated", { id: `planning:${event.turnId}`, label: "执行规划", status: "running", message: "执行方案已就绪" });
				await this.setProgress("planning", "正在制定执行方案"); break;
			case "planning.completed":
				this.card.apply("notice.updated", { id: `planning:${event.turnId}`, label: "执行规划", status: event.compliant ? "completed" : "error", message: event.corrected ? "已自动调整方案" : "执行方案完成" });
				break;
			case "work.changed": {
				this.card.apply("notice.updated", { id: `work:${event.workId}`, label: event.kind === "subagent" ? "并行子任务" : "异步任务计划", status: event.state === "failed" ? "error" : event.state, message: event.summary ?? (event.state === "queued" ? "已排队" : event.state === "running" ? "运行中" : event.state === "completed" ? "已完成" : event.state === "cancelled" ? "已取消" : "执行失败") });
				await this.setProgress(
					event.state === "completed" ? "composing" : event.state === "failed" ? "recovering" : "working",
					event.state === "completed" ? "并行处理完成，正在整理结果" : event.state === "failed" ? "部分处理未成功，正在调整方案" : "正在处理任务",
				);
				break;
			}
			case "turn.failed":
				this.stopProgress(); this.card.apply("message.failed", { error: event.error });
				await this.presentTerminal(); break;
			case "turn.cancelled":
				this.stopProgress(); this.card.apply("message.cancelled", { message: "运行已取消" });
				await this.presentTerminal(); break;
			case "turn.finished": {
				this.stopProgress();
				this.pendingCompletion = event.result;
				break;
			}
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
		this.stopProgress();
		const progressCardStarted = Boolean(this.cardMessageId || this.cardCreation);
		if (!this.terminalPresented && (!options?.idempotencyKey || progressCardStarted)) {
			this.applyCompletion(options?.idempotencyKey ? "处理结束，最终结果见下方消息。" : answer, this.pendingCompletion);
			await this.presentTerminal();
		}
		const drained = await this.flush.drain(5_000);
		if (options?.idempotencyKey) {
			// Durable Completions use the replayable text lane. The transient
			// progress card contains status only, so the answer still appears once.
			const result = await this.sendFallback(answer, options.idempotencyKey);
			return { idempotencyKey: options.idempotencyKey, deliveredAt: Date.now(), ...(result.messageId ? { providerMessageId: result.messageId } : {}) };
		}
		const pendingDelivery = this.pendingCardDelivery();
		if (pendingDelivery) {
			void pendingDelivery.then(async (success) => {
				if (!success) await this.sendFallback(answer, this.resultIdempotencyKey);
			}).catch(async () => {
				await this.sendFallback(answer, this.resultIdempotencyKey).catch((error) => console.error(`[beemax] Feishu late result fallback failed: ${safeError(error)}`));
			});
			return { idempotencyKey: this.progressIdempotencyKey, deliveredAt: Date.now(), ...(this.cardMessageId ? { providerMessageId: this.cardMessageId } : {}) };
		}
		if (this.cardMessageId && drained && !this.degraded) {
			return { idempotencyKey: this.progressIdempotencyKey, deliveredAt: Date.now(), providerMessageId: this.cardMessageId };
		}
		const result = await this.sendFallback(answer, this.resultIdempotencyKey);
		return { idempotencyKey: this.resultIdempotencyKey, deliveredAt: Date.now(), ...(result.messageId ? { providerMessageId: result.messageId } : {}) };
	}

	async fail(error: string): Promise<void> {
		this.stopProgress();
		if (this.card.status !== "cancelled" && this.card.status !== "failed") this.card.apply("message.failed", { error });
		if (!this.terminalPresented) await this.presentTerminal();
		await this.flush.drain(3_000);
		if (!this.cardMessageId || this.degraded) await this.sendFallback(`❌ ${error}`);
	}

	async close(failed: boolean): Promise<void> {
		this.stopProgress();
		await this.transport.stopTyping(this.input.source.chatId, this.input.source.messageId, failed).catch(() => undefined);
		this.flush.close();
	}

	private async setProgress(stage: ProgressStage, message: string): Promise<void> {
		if (this.terminalPresented || this.pendingCompletion) return;
		const changed = this.progressStage !== stage;
		this.progressStage = stage;
		this.card.apply("notice.updated", { id: "turn:status", label: "当前状态", status: "running", message });
		if (!changed || !this.progressReady || this.progressUpdateCount >= 2) return;
		await this.publishProgress();
	}

	private async publishProgress(): Promise<void> {
		if (this.terminalPresented || this.pendingCompletion || this.progressUpdateCount >= 2) return;
		this.progressUpdateCount++;
		await this.flush.schedule(() => this.renderUpdate(), false, true);
	}

	private applyCompletion(answer: string, result?: FinishedResult): void {
		const outcomePhase = result ? interactionPhaseForOutcome(result.outcome) : "completed";
		const presentationEvent = outcomePhase === "completed" ? "message.completed"
			: outcomePhase === "cancelled" ? "message.cancelled"
				: outcomePhase === "rejected" ? "message.rejected" : "message.incomplete";
		this.card.apply(presentationEvent, {
			answer,
			message: answer,
			...(result ? { model: result.model, duration: result.durationMs / 1000, tokens: result.usage } : {}),
		});
	}

	private async presentTerminal(): Promise<void> {
		if (this.terminalPresented) return;
		this.terminalPresented = true;
		await this.flush.schedule(() => this.renderUpdate(), true);
	}

	private stopProgress(): void {
		if (this.progressTimer) clearTimeout(this.progressTimer);
		this.progressTimer = undefined;
	}

	private async renderUpdate(): Promise<boolean> {
		const rendered = renderCard(this.card, this.renderOptions);
		if (!this.cardMessageId) {
			if (!this.cardCreation) {
				this.cardCreationPending = true;
				this.cardCreation = this.transport.sendCard(this.input.source.chatId, rendered, this.input.source.replyToMessageId ?? this.input.source.messageId, Boolean(this.input.source.threadId), this.progressIdempotencyKey).catch((error): SendResult => ({
					success: false,
					error: safeError(error),
				})).then(async (result) => {
					if (result.success && result.messageId) { this.cardMessageId = result.messageId; this.input.onBinding?.(result.messageId, this.card.pendingApprovalId); }
					this.degraded = !result.success;
					if (result.success && this.pendingCardRender) {
						const updated = await this.ensureCardUpdate();
						if (!updated) return { success: false, messageId: result.messageId, error: "Feishu card update failed" };
					}
					return result;
				}).finally(() => { this.cardCreationPending = false; });
			} else {
				this.pendingCardRender = rendered;
			}
			const result = await settleWithin(this.cardCreation, this.ioTimeout());
			if (!result) return false;
			this.degraded = !result.success; return result.success;
		}
		this.pendingCardRender = rendered;
		const success = await settleWithin(this.ensureCardUpdate(), this.ioTimeout());
		if (success === undefined) return false;
		this.degraded = !success; return success;
	}

	private ensureCardUpdate(): Promise<boolean> {
		if (!this.cardUpdate) {
			this.cardUpdate = (async () => {
				let success = true;
				while (this.pendingCardRender) {
					const next = this.pendingCardRender; this.pendingCardRender = undefined;
					const result = await this.transport.updateCard(this.cardMessageId!, next).catch((error) => ({ success: false, error: safeError(error) }));
					success = result.success;
					this.degraded = !result.success;
					if (result.success) this.input.onBinding?.(this.cardMessageId!, this.card.pendingApprovalId);
				}
				return success;
			})().finally(() => { this.cardUpdate = undefined; });
		}
		return this.cardUpdate;
	}

	private pendingCardDelivery(): Promise<boolean> | undefined {
		if (this.cardCreationPending && this.cardCreation) return this.cardCreation.then((result) => result.success);
		return this.cardUpdate;
	}

	private ioTimeout(): number { return this.input.preferences?.ioTimeoutMs ?? 2_000; }
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

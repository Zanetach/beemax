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
	AdaptiveTextBuffer,
	InteractionEventAdapter,
	parseInteractionCommand,
	sessionOwnerKey,
	TurnStatusPulse,
	type ToolApprovalBroker,
	type InteractionEvent,
	type AgentRuntimePort,
	type DeliveryTarget,
	type ExecutionEnvelope,
	type TaskPlanProgressEvent,
} from "@beemax/core";
import type { InboundMessage, PlatformAdapter, PlatformCardAction } from "./types.ts";
import { CardSession } from "../card/session.ts";
import { renderCard, type CardRenderOptions } from "../card/render.ts";
import { FlushController } from "../card/flush.ts";
import { MessageDeduplicator } from "./message-deduplicator.ts";
import { prepareAgentMediaInput } from "./media-input.ts";

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
	/** Bound initial/final presentation I/O so a stuck channel cannot block the Turn. */
	presentationTimeoutMs?: number;
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
	private readonly turnStarts = new Map<string, Promise<void>>();
	private readonly activeHandles = new Set<Promise<void>>();
	private recoveryTimer?: ReturnType<typeof setTimeout>;
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
		this.platform.onMessage((msg) => this.admit(msg));
		this.platform.onCardAction?.((action) => this.handleCardAction(action));
	}

	private admit(msg: InboundMessage): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let admitted = false;
			const markAdmitted = () => { if (!admitted) { admitted = true; resolve(); } };
			let work!: Promise<void>;
			work = this.handle(msg, markAdmitted).then(markAdmitted).catch((error) => {
				if (!admitted) { this.deduplicator.rollback(this.profileId, msg.source.platform, msg.source.messageId); reject(error); }
				else console.error(`[beemax] message dispatch failed after admission: ${error instanceof Error ? error.message : String(error)}`);
			}).finally(() => this.activeHandles.delete(work));
			this.activeHandles.add(work);
		});
	}

	private async handle(msg: InboundMessage, onAdmitted?: () => void): Promise<void> {
		let releaseAdmission: (() => void) | undefined;
		const admit = () => { releaseAdmission?.(); onAdmitted?.(); };
		try {
			if (!this.deduplicator.accept(this.profileId, msg.source.platform, msg.source.messageId)) { onAdmitted?.(); return; }
			const effective = { ...msg, source: this.sessionOverrides.get(sessionOwnerKey(msg.source)) ?? msg.source };
			const command = parseInteractionCommand(effective.text);
			if (command?.kind === "stop") {
				const outcome = await this.interaction.dispatch({ type: "turn.cancel", source: effective.source });
				if (!("cancelled" in outcome)) throw new Error("Cancellation dispatch did not produce a cancellation result");
				await this.platform.send(msg.source.chatId, `${outcome.cancelled ? "已停止当前任务" : "当前没有正在执行的任务"}${outcome.subagentsCancelled ? `；同时取消 ${outcome.subagentsCancelled} 个子任务` : ""}${outcome.approvalCancelled ? "；已取消待审批操作" : ""}。`);
				onAdmitted?.();
				return;
			}
			const admissionKey = sessionOwnerKey(effective.source);
			releaseAdmission = await this.acquireTurnAdmission(admissionKey);
			if (await this.interaction.handleApprovalReply(effective.source, effective.text)) { admit(); return; }
			const control = await this.runtime.handleControl({ source: effective.source, text: effective.text });
			if (control?.handled) {
				if (control.nextSource) this.setSessionOverride(msg.source, control.nextSource.threadId);
				await this.platform.send(msg.source.chatId, control.message);
				admit();
				return;
			}
			const snapshot = await this.interaction.snapshot(effective.source);
			if (["running", "queued", "awaiting_approval"].includes(snapshot.phase)) {
				const media = effective.mediaPaths.length ? await prepareAgentMediaInput(effective) : undefined;
				const queued = command?.kind === "steer"
					? await this.interaction.dispatch({ type: "turn.steer", source: effective.source, text: command.text, images: media?.images })
					: await this.interaction.dispatch({ type: "turn.queue", source: effective.source, text: media?.text ?? effective.text, images: media?.images });
				if (!("queued" in queued)) throw new Error("Active Agent turn returned an invalid queue result");
				if (!queued.queued) {
					await this.platform.send(msg.source.chatId, `当前会话队列已满（${queued.position} 条），请等待部分消息处理完成，或发送 /stop 停止当前任务。`);
					admit();
					return;
				}
				const feedback = queued.mode === "steer"
					? "已更新当前任务要求，Agent 会在下一步按新要求继续。"
					: queued.mode === "follow_up"
						? "已收到补充消息，将在当前任务中继续处理。"
						: queued.replaced
							? "已更新下一条待处理消息。"
							: `已加入当前会话队列${queued.position > 0 ? `（第 ${queued.position} 条）` : ""}。`;
				await this.platform.send(msg.source.chatId, `${feedback} 发送 /stop 可随时停止。`);
				admit();
				return;
			}
			const primary = effective.mediaPaths.length ? undefined : this.interaction.reservePrimaryInput(effective.source, effective.text, this.turnTimeoutMs + 60_000);
			if (!effective.mediaPaths.length && !primary) {
				await this.platform.send(msg.source.chatId, "当前会话队列已满（100 条），请稍后重试。");
				admit();
				return;
			}
			if (primary && this.interaction.peekQueuedInput(effective.source)) {
				this.interaction.demotePrimaryInput(effective.source, primary.id);
				admit();
				await this.drainQueuedInputs(effective.source);
				return;
			}
			if (await this.runTurn(effective, admit)) await this.drainQueuedInputs(effective.source);
			else if (primary) this.interaction.discardPrimaryInput(effective.source, primary.id);
		} finally {
			releaseAdmission?.();
			await msg.releaseMedia?.().catch((error) => {
				console.warn(`[beemax] temporary inbound media cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
	}

	private async acquireTurnAdmission(key: string): Promise<() => void> {
		const prior = this.turnStarts.get(key) ?? Promise.resolve();
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
		const tail = prior.catch(() => undefined).then(() => gate);
		this.turnStarts.set(key, tail);
		await prior.catch(() => undefined);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			releaseGate();
			if (this.turnStarts.get(key) === tail) this.turnStarts.delete(key);
		};
	}

	private async runTurn(msg: InboundMessage, onReserved?: () => void): Promise<boolean> {
		const chatId = msg.source.chatId;
		const card = new CardSession();
		const flush = new FlushController(this.deps.flushIntervalMs ?? 350);
		let cardMessageId: string | undefined;
		let cardCreation: Promise<Awaited<ReturnType<PlatformAdapter["sendCard"]>>> | undefined;
		let cardUpdate: Promise<boolean> | undefined;
		let pendingCardRender: Record<string, unknown> | undefined;
		let presentationDegraded = false;

		const renderUpdate = async (): Promise<boolean> => {
			const rendered = renderCard(card, this.deps.cardOptions);
			if (!cardMessageId) {
				if (!cardCreation) {
					const pending = this.platform.sendCard(chatId, rendered, msg.source.messageId, Boolean(msg.source.threadId), `${this.profileId}:${msg.source.messageId ?? "turn"}`);
					cardCreation = pending.then((res) => {
						if (res.success && res.messageId) { cardMessageId = res.messageId; this.rememberCardBinding(res.messageId, msg.source, card.pendingApprovalId); }
						return res;
					});
				}
				const res = await settleWithin(cardCreation, this.deps.presentationTimeoutMs ?? 2_000);
				if (!res) { presentationDegraded = true; return false; }
				presentationDegraded = !res.success;
				return res.success;
			}
			pendingCardRender = rendered;
			if (!cardUpdate) {
				cardUpdate = (async () => {
					let success = true;
					while (pendingCardRender) {
						const next = pendingCardRender; pendingCardRender = undefined;
						const res = await this.platform.updateCard(cardMessageId!, next);
						success = success && res.success;
						if (res.success) this.rememberCardBinding(cardMessageId!, msg.source, card.pendingApprovalId);
					}
					return success;
				})().finally(() => { cardUpdate = undefined; });
			}
			const res = await settleWithin(cardUpdate, this.deps.presentationTimeoutMs ?? 2_000);
			if (res === undefined) { presentationDegraded = true; return false; }
			presentationDegraded = !res;
			return res;
		};
		const answerBuffer = new AdaptiveTextBuffer(async (chunk) => {
			try {
				card.apply("answer.delta", { text: chunk });
				await flush.schedule(renderUpdate, false, true);
			} catch (error) { console.error(`[beemax] answer presenter failed: ${error instanceof Error ? error.message : String(error)}`); }
		}, { minChunkChars: 6, preferredChunkChars: 28, maxChunkChars: 80, maxWaitMs: 50, flushSmallOnMaxWait: true });
		const statusPulse = new TurnStatusPulse(async (message) => {
			card.apply("notice.updated", { id: "turn:status", label: "当前状态", status: "running", message });
			await flush.schedule(renderUpdate, false, true);
		});
		let failed = false;
		try {
			await settleWithin(statusPulse.start(), this.deps.presentationTimeoutMs ?? 2_000);
			await this.platform.sendTyping(chatId, msg.source.messageId).catch((error) => {
				console.warn(`[beemax] typing indicator failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			let result;
			try {
				const media = await prepareAgentMediaInput(msg);
				const turn = this.interaction.dispatch({ type: "message.send", source: msg.source, text: media.text, input: { timeoutMs: this.turnTimeoutMs, mode: "interactive", images: media.images } }, (event) => this.onInteractionEvent(event, card, flush, answerBuffer, statusPulse, renderUpdate));
				onReserved?.();
				result = await turn;
				if (!("answer" in result)) throw new Error("Message dispatch did not produce an Agent result");
			} catch (err) {
				failed = true;
				const errorText = err instanceof AgentRunError ? err.message : err instanceof Error ? err.message : String(err);
				if (card.status !== "cancelled") card.apply("message.failed", { error: errorText });
				await flush.schedule(renderUpdate, true);
				await flush.drain(3000);
				if (!cardMessageId || presentationDegraded) await this.platform.send(chatId, `❌ ${errorText}`);
				return false;
			}

			// Terminal event already owns completion; only drain its final card patch.
			await flush.schedule(renderUpdate, true);
			await flush.drain(5000);
			if (!cardMessageId || presentationDegraded) await this.platform.send(chatId, card.answerText || result.answer);
			return true;
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			await settleWithin(statusPulse.stop(), 1_000).catch((error) => console.error(`[beemax] turn status presenter failed: ${error instanceof Error ? error.message : String(error)}`));
			await answerBuffer.close();
			await this.platform.stopTyping(chatId, msg.source.messageId, failed).catch(() => undefined);
			flush.close();
		}
	}

	/** Replays crash-surviving inputs only after their previous turn failed to acknowledge them. */
	async recoverQueuedInputs(): Promise<number> {
		let recovered = 0;
		type RecoveredInput = ReturnType<InteractionEventAdapter<InboundMessage["source"]>["claimRecoveredInputs"]>[number];
		const failed: RecoveredInput[] = [];
		let firstFailed: RecoveredInput | undefined;
		while (true) {
			const input = this.interaction.claimRecoveredInputs(this.platform.name, 1, this.turnTimeoutMs + 60_000)[0];
			if (!input) break;
			const message: InboundMessage = {
				text: input.text,
				messageType: "text",
				source: { ...input.source, messageId: `recovery:${input.id}` },
				mediaPaths: [], mediaTypes: [], raw: { recoveredInputId: input.id }, timestamp: input.createdAt,
			};
			const release = await this.acquireTurnAdmission(sessionOwnerKey(input.source));
			let succeeded = false;
			try { succeeded = await this.runTurn(message, release); }
			finally { release(); }
			if (!succeeded) { failed.push(input); firstFailed ??= input; continue; }
			if (!this.interaction.acknowledgeQueuedInput(input.source, input.id, input.claimToken)) throw new Error(`Recovered input acknowledgement failed: ${input.id}`);
			recovered++;
		}
		for (const input of failed) this.interaction.releaseQueuedInput(input.source, input);
		if (firstFailed && !this.recoveryTimer) {
			this.recoveryTimer = setTimeout(() => { this.recoveryTimer = undefined; void this.recoverQueuedInputs().catch((error) => console.error(`[beemax] queued input recovery failed: ${String(error)}`)); }, 5_000);
			this.recoveryTimer.unref?.();
		}
		return recovered;
	}

	private async drainQueuedInputs(source: InboundMessage["source"]): Promise<number> {
		let drained = 0;
		while (true) {
			const input = this.interaction.claimQueuedInput(source, this.turnTimeoutMs + 60_000);
			if (!input) return drained;
			const release = await this.acquireTurnAdmission(sessionOwnerKey(source));
			try {
				const snapshot = await this.interaction.snapshot(source);
				if (["running", "queued", "awaiting_approval"].includes(snapshot.phase)) { this.interaction.releaseQueuedInput(source, input); return drained; }
				const message: InboundMessage = {
					text: input.text, messageType: "text", source: { ...input.source, messageId: `queued:${input.id}` },
					mediaPaths: [], mediaTypes: [], raw: { queuedInputId: input.id }, timestamp: input.createdAt,
				};
				if (!await this.runTurn(message, release)) { this.interaction.releaseQueuedInput(source, input); return drained; }
				if (!this.interaction.acknowledgeQueuedInput(input.source, input.id, input.claimToken)) throw new Error(`Queued input acknowledgement failed: ${input.id}`);
				drained++;
			} finally { release(); }
		}
	}

	isBusy(): boolean {
		return this.runtime.isBusy();
	}

	async runAutomation(
		source: InboundMessage["source"],
		prompt: string,
		options: { key: string; timeoutMs: number; signal?: AbortSignal; executionEnvelope?: Readonly<ExecutionEnvelope>; objectiveTaskId?: string; allowedCapabilities?: string[] },
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
		if (options.signal?.aborted) throw options.signal.reason;
		let rejectAbort: ((reason: unknown) => void) | undefined;
		const aborted = options.signal ? new Promise<never>((_resolve, reject) => { rejectAbort = reject; }) : undefined;
		const abort = () => { void this.runtime.cancel(automationSource); rejectAbort?.(options.signal?.reason ?? new Error("Automation aborted")); };
		options.signal?.addEventListener("abort", abort, { once: true });
		let result;
		try {
			result = await Promise.race([this.runtime.run({ source: msg.source, text: prompt, timeoutMs: options.timeoutMs, expandPromptTemplates: false, mode: "automation", ...(options.objectiveTaskId ? { objectiveTaskId: options.objectiveTaskId } : {}), ...(options.allowedCapabilities ? { allowedCapabilities: options.allowedCapabilities } : {}), ...(options.executionEnvelope ? { executionEnvelope: options.executionEnvelope } : {}) }), ...(aborted ? [aborted] : [])]);
		} finally { options.signal?.removeEventListener("abort", abort); }
		if (!result.answer.trim() || result.answer === "(no response)") throw new Error("Automation agent returned no answer");
		return result.answer.trim();
	}

	async presentWorkProgress(target: DeliveryTarget, event: TaskPlanProgressEvent, idempotencyKey?: string): Promise<void> {
		if (target.platform !== this.platform.name) throw new Error(`Cannot present ${target.platform} work through ${this.platform.name}`);
		const card = new CardSession();
		card.apply("notice.updated", {
			id: `work:${event.workId}`, label: "异步任务计划", status: event.state === "failed" ? "error" : event.state,
			message: `${event.title} · ${event.completed}/${event.total}${event.failed ? ` · 失败 ${event.failed}` : ""}${event.cancelled ? ` · 取消 ${event.cancelled}` : ""}`,
		});
		const result = await this.platform.sendCard(target.chatId, renderCard(card, this.deps.cardOptions), undefined, Boolean(target.threadId), idempotencyKey);
		if (!result.success) throw new Error(result.error ?? `Failed to present Task Plan ${event.workId}`);
	}

	async dispose(): Promise<void> {
		if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
		if (this.activeHandles.size) {
			let timer!: ReturnType<typeof setTimeout>;
			const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); timer.unref?.(); });
			await Promise.race([Promise.allSettled([...this.activeHandles]).then(() => undefined), timeout]);
			clearTimeout(timer);
		}
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
		if (choice !== "once" && choice !== "task" && choice !== "session" && choice !== "deny") return;
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
				card.apply("notice.updated", { id: "turn:status", label: "当前状态", status: "running", message: event.state === "running" ? `正在执行 ${event.name}` : event.state === "failed" ? "操作未成功 · 正在处理" : "操作完成 · 正在整理结果" });
				card.apply("tool.updated", {
					tool_id: event.callId,
					name: event.name,
					status: event.state === "failed" ? "error" : event.state,
					detail: event.summary,
				});
				await flush.schedule(renderUpdate, false, true);
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
				await flush.schedule(renderUpdate, false, true);
				break;
			case "planning.selected":
				card.apply("notice.updated", { id: `planning:${event.turnId}`, label: "执行规划", status: "running", message: `${event.mode} · 并发 ${event.concurrency} · 子代理上限 ${event.maxSubagents}${event.requiredTools.length ? ` · ${event.requiredTools.join(" → ")}` : ""}` });
				await flush.schedule(renderUpdate, false, true);
				break;
			case "planning.completed":
				card.apply("notice.updated", { id: `planning:${event.turnId}`, label: "执行规划", status: event.compliant ? "completed" : "error", message: `${event.mode}${event.corrected ? " · 已自动纠正" : ""}` });
				await flush.schedule(renderUpdate, false, true);
				break;
			case "work.changed":
				card.apply("notice.updated", {
					id: `work:${event.workId}`,
					label: event.kind === "subagent" ? "并行子任务" : "异步任务计划",
					status: event.state === "failed" ? "error" : event.state,
					message: event.summary ?? (event.state === "queued" ? "已排队" : event.state === "running" ? "运行中" : event.state === "completed" ? "已完成" : event.state === "cancelled" ? "已取消" : "执行失败"),
				});
				await flush.schedule(renderUpdate, false, true);
				break;
			case "turn.failed":
				await statusPulse.stop().catch((error) => console.error(`[beemax] turn status presenter failed: ${error instanceof Error ? error.message : String(error)}`));
				await answerBuffer.flush();
				card.apply("message.failed", { error: event.error });
				await flush.schedule(renderUpdate, true);
				break;
			case "turn.cancelled":
				await statusPulse.stop().catch((error) => console.error(`[beemax] turn status presenter failed: ${error instanceof Error ? error.message : String(error)}`));
				await answerBuffer.flush();
				card.apply("message.cancelled", { message: "运行已取消" });
				await flush.schedule(renderUpdate, true);
				break;
			case "turn.finished":
				await statusPulse.stop().catch((error) => console.error(`[beemax] turn status presenter failed: ${error instanceof Error ? error.message : String(error)}`));
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
				await flush.schedule(renderUpdate, false, true);
				break;
			case "approval.resolved":
				card.apply("approval.updated", { id: `approval:${event.turnId}`, status: event.allowed ? "allowed" : "denied", message: `${event.toolName}：${event.allowed ? "已允许" : "已拒绝"}` });
				await flush.schedule(renderUpdate, false, true);
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
				await flush.schedule(renderUpdate, false, true);
				break;
		}
	}
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([operation, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(10, timeoutMs)); })]); }
	finally { if (timer) clearTimeout(timer); }
}

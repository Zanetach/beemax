/** Platform-neutral ingress, interaction dispatch, and presentation orchestration. */

import {
	AgentRunError,
	conversationKey,
	InteractionEventAdapter,
	parseInteractionCommand,
	sessionOwnerKey,
	type AgentRunResult,
	type MediaArtifact,
	type TaskArtifact,
	type ToolApprovalBroker,
	type AgentRuntimePort,
	type DeliveryTarget,
	type TaskLedger,
	type TaskPlanProgressEvent,
} from "@beemax/core";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { InboundMessage, InteractionPresentationPreferences, PlatformAdapter, PlatformCardAction, PublishedArtifactPresentation } from "@beemax/channel-runtime";
import { MessageDeduplicator } from "./message-deduplicator.ts";
import { prepareAgentMediaInput } from "./media-input.ts";
import type { ProfileBindingResolver } from "./profile-binding.ts";
import type { GatewayInteractionAdmission } from "./ingress-capacity.ts";
import { GatewayIngressController } from "./ingress-capacity.ts";
import { TextInteractionPresenter } from "./text-presentation.ts";
import { GatewayDeliveryPort } from "./delivery-port.ts";

interface CardBinding {
	source: InboundMessage["source"];
	pendingApprovalId?: string;
}

export type PublishedArtifactLink = PublishedArtifactPresentation;

export interface ArtifactPublicationPort {
	publish(artifact: TaskArtifact, media: MediaArtifact): Promise<PublishedArtifactLink>;
}

interface PreparedTurnArtifact {
	artifact: TaskArtifact;
	media: MediaArtifact;
	published?: PublishedArtifactLink;
}

export interface DispatcherDeps {
	runtime: AgentRuntimePort<InboundMessage["source"]>;
	/** Core semantic boundary. When omitted, legacy callers get a local adapter. */
	interaction?: InteractionEventAdapter<InboundMessage["source"]>;
	presentationOptions?: InteractionPresentationPreferences;
	/** @deprecated Use presentationOptions.updateIntervalMs. */
	flushIntervalMs?: number;
	/** Bound initial/final presentation I/O so a stuck channel cannot block the Turn. */
	presentationTimeoutMs?: number;
	/** Optional Turn deadline. Null means the Objective continues until settlement or explicit cancellation. */
	turnTimeoutMs?: number | null;
	approvalBroker?: ToolApprovalBroker;
	cancelTasks?: (source: InboundMessage["source"]) => number;
	/** Isolated deployment/profile identity used for ingress idempotency. */
	profileId?: string;
	/** Stable configured account/connection identity injected into every inbound Interaction. */
	channelInstanceId?: string;
	/** Configured route identity even when a legacy single-instance source keeps its old Session namespace. */
	bindingChannelInstanceId?: string;
	/** Non-secret platform account identity used by deterministic Profile Binding. */
	channelAccountRef?: string;
	/** Fail-closed Profile route authority. Models and adapters cannot override its result. */
	bindingResolver?: Pick<ProfileBindingResolver, "resolve">;
	/** Shared Profile-level ingress budget; one controller may cover every Channel Instance. */
	ingress?: GatewayInteractionAdmission;
	messageDeduplicator?: MessageDeduplicator;
	/** Trusted Profile workspace used to resolve content-addressed workspace: artifacts. */
	artifactWorkspace?: string;
	/** Optional immutable document publisher; receives only workspace files that passed Artifact Manifest integrity checks. */
	artifactPublisher?: ArtifactPublicationPort;
	/** Commits an interactive Delivery Receipt into the shared Completion Outbox. */
	completionAcknowledger?: Required<Pick<TaskLedger, "getObjectiveCompletion" | "acknowledgeObjectiveCompletion">>;
	beforeCompletionAcknowledged?: (completionId: string, source: InboundMessage["source"]) => void | Promise<void>;
}

export class Dispatcher {
	private readonly runtime: AgentRuntimePort<InboundMessage["source"]>;
	private readonly interaction: InteractionEventAdapter<InboundMessage["source"]>;
	private readonly deps: DispatcherDeps;
	private readonly platform: PlatformAdapter;
	private readonly turnTimeoutMs: number | null;
	private readonly profileId: string;
	private readonly deduplicator: MessageDeduplicator;
	private readonly ingress: GatewayInteractionAdmission;
	private readonly delivery: GatewayDeliveryPort;
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
		this.turnTimeoutMs = deps.turnTimeoutMs === null ? null : Math.max(30_000, Math.min(60 * 60_000, deps.turnTimeoutMs ?? 10 * 60_000));
		this.profileId = deps.profileId ?? "default";
		this.deduplicator = deps.messageDeduplicator ?? new MessageDeduplicator();
		this.ingress = deps.ingress ?? new GatewayIngressController();
		this.delivery = new GatewayDeliveryPort(platform);
		this.platform.onMessage((msg) => this.admit(msg));
		this.platform.onCardAction?.((action) => this.handleCardAction(action));
	}

	private admit(msg: InboundMessage): Promise<void> {
		const scoped = this.deps.channelInstanceId && msg.source.channelInstanceId !== this.deps.channelInstanceId
			? { ...msg, source: { ...msg.source, channelInstanceId: this.deps.channelInstanceId } }
			: msg;
		if (this.deps.bindingResolver) {
			try {
				const channelInstanceId = this.deps.bindingChannelInstanceId ?? scoped.source.channelInstanceId;
				if (!channelInstanceId) throw new Error("inbound Interaction has no Channel Instance identity");
				const binding = this.deps.bindingResolver.resolve({
					channelInstanceId,
					...(this.deps.channelAccountRef ? { accountRef: this.deps.channelAccountRef } : {}),
					conversationId: scoped.source.chatId,
					...(scoped.source.threadId ? { threadId: scoped.source.threadId } : {}),
				});
				if (binding.profileId !== this.profileId) throw new Error(`Binding selected Profile ${binding.profileId}`);
			} catch (error) {
				console.warn(`[beemax] rejected inbound Interaction by Profile Binding: ${error instanceof Error ? error.message : String(error)}`);
				return scoped.releaseMedia?.().catch(() => undefined) ?? Promise.resolve();
			}
		}
		const emergencyStop = parseInteractionCommand(scoped.text)?.kind === "stop";
		const releaseIngress = emergencyStop ? () => undefined : this.ingress.tryAcquire(conversationKey(scoped.source));
		if (!releaseIngress) return (async () => {
			try { await this.platform.send(scoped.source.chatId, "当前 Profile 处理容量已满，请稍后重试。"); }
			finally { await scoped.releaseMedia?.().catch(() => undefined); }
		})();
		return new Promise<void>((resolve, reject) => {
			let admitted = false;
			const markAdmitted = () => { if (!admitted) { admitted = true; resolve(); } };
			let work!: Promise<void>;
			work = this.handle(scoped, markAdmitted).then(markAdmitted).catch((error) => {
				if (!admitted) { this.deduplicator.rollback(this.profileId, channelDedupeKey(scoped.source), scoped.source.messageId); reject(error); }
				else console.error(`[beemax] message dispatch failed after admission: ${error instanceof Error ? error.message : String(error)}`);
			}).finally(() => { releaseIngress(); this.activeHandles.delete(work); });
			this.activeHandles.add(work);
		});
	}

	private async handle(msg: InboundMessage, onAdmitted?: () => void): Promise<void> {
		let releaseAdmission: (() => void) | undefined;
		const admit = () => { releaseAdmission?.(); onAdmitted?.(); };
		try {
			if (!this.deduplicator.accept(this.profileId, channelDedupeKey(msg.source), msg.source.messageId)) { onAdmitted?.(); return; }
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
			const primary = effective.mediaPaths.length ? undefined : this.interaction.reservePrimaryInput(effective.source, effective.text, this.claimLeaseMs());
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
		const presenter = this.platform.presentation ?? new TextInteractionPresenter(this.platform);
		const exactSource = msg.source.messageId ? {
			...msg.source,
			originMessageId: msg.source.messageId,
			replyToMessageId: msg.replyToMessageId ?? msg.source.messageId,
		} : msg.source;
		const presentation = presenter.open({
			source: exactSource,
			profileId: this.profileId,
			preferences: {
				...this.deps.presentationOptions,
				updateIntervalMs: this.deps.presentationOptions?.updateIntervalMs ?? this.deps.flushIntervalMs,
				ioTimeoutMs: this.deps.presentationOptions?.ioTimeoutMs ?? this.deps.presentationTimeoutMs,
			},
			onBinding: (messageId, pendingApprovalId) => this.rememberCardBinding(messageId, msg.source, pendingApprovalId),
		});
		let failed = false;
		try {
			await presentation.start();
			let result;
			try {
				const media = await prepareAgentMediaInput(msg);
				const turn = this.interaction.dispatch({ type: "message.send", source: exactSource, text: media.text, input: { timeoutMs: this.turnTimeoutMs, mode: "interactive", images: media.images } }, (event) => presentation.onEvent(event));
				onReserved?.();
				result = await turn;
				if (!("answer" in result)) throw new Error("Message dispatch did not produce an Agent result");
			} catch (err) {
				failed = true;
				const errorText = err instanceof AgentRunError ? err.message : err instanceof Error ? err.message : String(err);
				await presentation.fail(errorText);
				return false;
			}
			const completion = result.completionId ? this.deps.completionAcknowledger?.getObjectiveCompletion(result.completionId) : undefined;
			if (result.completionId) {
				if (!completion) {
					console.error(`[beemax] Interactive Objective delivery deferred because its Completion is unavailable: ${result.completionId}`);
					return true;
				}
				const preparedArtifacts = await this.prepareTurnArtifacts(result.artifacts);
				const publishedArtifacts = publishedArtifactPresentations(preparedArtifacts);
				let receipt;
				try {
					receipt = await presentation.finish(completion.result, { idempotencyKey: completion.deliveryIdempotencyKey, deliveryClass: "interactive", publishedArtifacts });
				} catch (error) {
					console.error(`[beemax] Interactive Objective delivery deferred to Completion Outbox: ${result.completionId} (${error instanceof Error ? error.message : String(error)})`);
					return true;
				}
				if (receipt.idempotencyKey !== completion.deliveryIdempotencyKey) {
					console.error(`[beemax] Interactive Objective returned an invalid Delivery Receipt; Completion remains queued: ${result.completionId}`);
					return true;
				}
				await this.deliverTurnArtifacts(preparedArtifacts, exactSource);
				try { await this.deps.beforeCompletionAcknowledged?.(result.completionId, msg.source); }
				catch { console.error(`[beemax] Interactive Objective publication deferred to Completion Outbox: ${result.completionId}`); return true; }
				if (!this.deps.completionAcknowledger!.acknowledgeObjectiveCompletion(result.completionId, receipt)) {
					console.error(`[beemax] Interactive Objective acknowledgement deferred to Completion Outbox: ${result.completionId}`);
				}
			} else {
				const preparedArtifacts = await this.prepareTurnArtifacts(result.artifacts);
				await presentation.finish(result.answer, { publishedArtifacts: publishedArtifactPresentations(preparedArtifacts) });
				await this.deliverTurnArtifacts(preparedArtifacts, exactSource);
			}
			return true;
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			await presentation.close(failed);
		}
	}

	private async prepareTurnArtifacts(artifacts: AgentRunResult["artifacts"]): Promise<PreparedTurnArtifact[]> {
		const files = artifacts?.filter((artifact) => artifact.type === "file") ?? [];
		if (!files.length) return [];
		if (!this.deps.artifactWorkspace) throw new Error("Interactive artifact delivery has no trusted Profile workspace");
		const prepared: PreparedTurnArtifact[] = [];
		for (const artifact of files) {
			const media = await verifiedWorkspaceMedia(artifact, this.deps.artifactWorkspace);
			let published: PublishedArtifactLink | undefined;
			if (this.deps.artifactPublisher) {
				try {
					published = await this.deps.artifactPublisher.publish(artifact, media);
				} catch (error) {
					console.warn(`[beemax] Artifact Site publication skipped for ${artifact.uri}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			prepared.push({ artifact, media, ...(published ? { published } : {}) });
		}
		return prepared;
	}

	private async deliverTurnArtifacts(artifacts: readonly PreparedTurnArtifact[], source: InboundMessage["source"]): Promise<void> {
		if (!artifacts.length) return;
		const target: DeliveryTarget = {
			platform: source.platform,
			...(source.channelInstanceId ? { channelInstanceId: source.channelInstanceId } : {}),
			chatId: source.chatId,
			...(source.chatType ? { chatType: source.chatType } : {}),
			...(source.userId ? { userId: source.userId } : {}),
			...(source.threadId ? { threadId: source.threadId } : {}),
			...(source.replyToMessageId ? { replyToMessageId: source.replyToMessageId } : {}),
		};
		for (const { artifact, media } of artifacts) {
			await this.delivery.sendMedia(target, media, {
				idempotencyKey: `${this.profileId}:${source.messageId ?? "turn"}:${artifact.manifest!.id}`,
				deliveryClass: "interactive",
			});
		}
	}

	/** Replays crash-surviving inputs only after their previous turn failed to acknowledge them. */
	async recoverQueuedInputs(): Promise<number> {
		let recovered = 0;
		type RecoveredInput = ReturnType<InteractionEventAdapter<InboundMessage["source"]>["claimRecoveredInputs"]>[number];
		const failed: RecoveredInput[] = [];
		let firstFailed: RecoveredInput | undefined;
		while (true) {
			const input = this.interaction.claimRecoveredInputs(this.platform.name, 1, this.claimLeaseMs())[0];
			if (!input) break;
			const message: InboundMessage = {
				text: input.text,
				messageType: "text",
				source: input.source.messageId ? input.source : { ...input.source, messageId: `recovery:${input.id}` },
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
			const input = this.interaction.claimQueuedInput(source, this.claimLeaseMs());
			if (!input) return drained;
			const release = await this.acquireTurnAdmission(sessionOwnerKey(source));
			try {
				const snapshot = await this.interaction.snapshot(source);
				if (["running", "queued", "awaiting_approval"].includes(snapshot.phase)) { this.interaction.releaseQueuedInput(source, input); return drained; }
				const message: InboundMessage = {
					text: input.text, messageType: "text", source: input.source.messageId ? input.source : { ...input.source, messageId: `queued:${input.id}` },
					mediaPaths: [], mediaTypes: [], raw: { queuedInputId: input.id }, timestamp: input.createdAt,
				};
				if (!await this.runTurn(message, release)) { this.interaction.releaseQueuedInput(source, input); return drained; }
				if (!this.interaction.acknowledgeQueuedInput(input.source, input.id, input.claimToken)) throw new Error(`Queued input acknowledgement failed: ${input.id}`);
				drained++;
			} finally { release(); }
		}
	}

	/** Recovery leases detect a crashed dispatcher; unlike a Turn deadline they never abort live work. */
	private claimLeaseMs(): number { return this.turnTimeoutMs === null ? 60 * 60_000 : this.turnTimeoutMs + 60_000; }

	isBusy(): boolean {
		return this.runtime.isBusy();
	}

	async presentWorkProgress(target: DeliveryTarget, event: TaskPlanProgressEvent, idempotencyKey?: string): Promise<void> {
		if (target.platform !== this.platform.name) throw new Error(`Cannot present ${target.platform} work through ${this.platform.name}`);
		const presenter = this.platform.presentation ?? new TextInteractionPresenter(this.platform);
		if (!presenter.presentWorkProgress) throw new Error(`Channel ${this.platform.name} cannot present Task Plan progress`);
		await presenter.presentWorkProgress({ target, event, idempotencyKey });
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

}

function publishedArtifactPresentations(artifacts: readonly PreparedTurnArtifact[]): PublishedArtifactPresentation[] {
	return artifacts.flatMap(({ published }) => published ? [published] : []);
}

async function verifiedWorkspaceMedia(artifact: TaskArtifact, workspace: string): Promise<MediaArtifact> {
	const manifest = artifact.manifest;
	if (!manifest || manifest.locator.kind !== "workspace" || !manifest.locator.uri.startsWith("workspace:")) {
		throw new Error(`Interactive file artifact ${artifact.uri} has no trusted workspace Manifest`);
	}
	const locatorPath = manifest.locator.uri.slice("workspace:".length);
	if (!locatorPath || locatorPath.includes("\0") || isAbsolute(locatorPath)) throw new Error(`Invalid workspace artifact locator: ${manifest.locator.uri}`);
	const workspacePath = await realpath(resolve(workspace));
	const artifactPath = await realpath(resolve(workspacePath, locatorPath));
	const relativePath = relative(workspacePath, artifactPath);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`Workspace artifact escapes the trusted Profile workspace: ${manifest.locator.uri}`);
	}
	const file = await stat(artifactPath);
	if (!file.isFile()) throw new Error(`Workspace artifact is not a regular file: ${manifest.locator.uri}`);
	if (file.size !== manifest.byteLength) throw new Error(`Workspace artifact byte length no longer matches its Manifest: ${manifest.locator.uri}`);
	if (await fileSha256(artifactPath) !== manifest.sha256) throw new Error(`Workspace artifact digest no longer matches its Manifest: ${manifest.locator.uri}`);
	return { path: artifactPath, mimeType: manifest.mediaType, name: basename(artifactPath) };
}

async function fileSha256(path: string): Promise<string> {
	return new Promise((resolveDigest, rejectDigest) => {
		const digest = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => digest.update(chunk));
		stream.on("error", rejectDigest);
		stream.on("end", () => resolveDigest(digest.digest("hex")));
	});
}

function channelDedupeKey(source: InboundMessage["source"]): string {
	return source.channelInstanceId ? `${source.platform}@${source.channelInstanceId}` : source.platform;
}

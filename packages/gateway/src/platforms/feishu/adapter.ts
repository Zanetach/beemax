/**
 * Feishu (飞书) platform adapter.
 *
 * Modeled on Hermes' gateway/platforms/feishu.py, but in TypeScript on top of
 * the official `@larksuiteoapi/node-sdk`.
 *
 * Connection: WebSocket long-connection by default, with an optional local
 * webhook listener for deployments fronted by HTTPS/reverse proxy.
 *
 * Identity: self-built (企业内部) app. The bot's own open_id is hydrated at
 * startup via /bot/v3/info (the SDK does this implicitly on first call) and
 * is used only to match @-mentions in groups.
 *
 * Session keying prefers union_id (userIdAlt, stable across apps) over
 * open_id (userId), matching Hermes.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import lark, { adaptDefault, normalizeCardAction, type Client, type EventDispatcher, type RawCardActionEvent, type WSClient } from "@larksuiteoapi/node-sdk";
import { sessionOwnerKey } from "@beemax/core";
import type {
	InboundMessage,
	CardActionHandler,
	PlatformCardAction,
	MessageHandler,
	PlatformAdapter,
	SendResult,
	SessionSource,
} from "../../core/types.ts";
import { validateFeishuWebhookSettings, type FeishuSettings } from "./settings.ts";
import { retryFeishuOperation } from "./retry.ts";

const FEISHU_DOMAIN = lark.Domain.Feishu;
const LARK_DOMAIN = lark.Domain.Lark;

const MAX_TEXT_LENGTH = 4000; // Feishu text message soft cap; we chunk on this.
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
const MAX_INBOUND_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_OUTBOUND_FILE_BYTES = 30 * 1024 * 1024;
const MAX_PROCESSING_REACTIONS = 1024;
const MAX_MEDIA_BATCH_MESSAGES = 8;
const MAX_MEDIA_BATCH_BYTES = 30 * 1024 * 1024;
const MAX_PENDING_INBOUND = 1_000;

interface PendingInboundEvent {
	message: InboundMessage;
	resolve: () => void;
	reject: (error: unknown) => void;
}

interface PendingInboundBatch {
	message: InboundMessage;
	mediaMessages?: InboundMessage[];
	count: number;
	lastChunkLength: number;
	byteCount?: number;
	timer: ReturnType<typeof setTimeout>;
	waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

export class FeishuAdapter implements PlatformAdapter {
	readonly name = "feishu" as const;
	private connected = false;
	private client!: Client;
	private wsClient?: WSClient;
	private webhookServer?: Server;
	private readonly webhookSockets = new Set<Socket>();
	private handler?: MessageHandler;
	private cardActionHandler?: CardActionHandler;
	private dedup = new Map<string, number>();
	private processingReactions = new Map<string, string>();
	private readonly textBatches = new Map<string, PendingInboundBatch>();
	private readonly mediaBatches = new Map<string, PendingInboundBatch>();
	private readonly deliveryTails = new Map<string, Promise<void>>();
	private readonly inFlightDeliveries = new Set<Promise<void>>();
	private readonly pendingInbound: PendingInboundEvent[] = [];
	private drainingInbound?: Promise<void>;
	private pendingInboundInFlight = 0;
	private shuttingDown = false;
	private connectionGeneration = 0;
	private readonly dedupTtlMs = 24 * 60 * 60 * 1000;
	private readonly settings: FeishuSettings;

	constructor(settings: FeishuSettings) {
		this.settings = settings;
	}

	get isConnected(): boolean {
		return this.connected;
	}

	/** Shared authenticated SDK client for Feishu custom tools. */
	get apiClient(): Client | undefined {
		return this.connected ? this.client : undefined;
	}

	onMessage(handler: MessageHandler): void {
		this.handler = handler;
		void this.drainPendingInbound().catch((error) => console.error(`[beemax] Feishu inbound replay failed: ${error instanceof Error ? error.message : String(error)}`));
	}

	onCardAction(handler: CardActionHandler): void {
		this.cardActionHandler = handler;
	}

	async connect(): Promise<boolean> {
		if (!this.settings.appId || !this.settings.appSecret) throw new Error("Feishu requires FEISHU_APP_ID and FEISHU_APP_SECRET.");
		validateFeishuWebhookSettings(this.settings);
		this.shuttingDown = false;
		const generation = ++this.connectionGeneration;
		try {
			return await retryFeishuOperation(() => this.connectOnce(generation), {
				attempts: 3,
				baseDelayMs: this.settings.retryBaseDelayMs ?? 1_000,
				retryAllErrors: true,
				onRetry: () => this.cleanupConnectionAttempt(generation),
			});
		} catch (error) {
			await this.cleanupConnectionAttempt(generation);
			throw error;
		}
	}

	private async connectOnce(generation: number): Promise<boolean> {
		this.assertCurrentConnection(generation);
		if (!this.settings.allowAllUsers && this.settings.allowedUsers.length === 0) {
			console.warn(
				"[beemax] Feishu access is deny-by-default and FEISHU_ALLOWED_USERS is empty; all user messages will be rejected",
			);
		}
		const domain = this.settings.domain === "lark" ? LARK_DOMAIN : FEISHU_DOMAIN;

		this.client = new lark.Client({
			appId: this.settings.appId,
			appSecret: this.settings.appSecret,
			appType: lark.AppType.SelfBuild,
			domain,
			disableTokenCache: false,
			loggerLevel: lark.LoggerLevel.warn,
		});

		const dispatcher: EventDispatcher = new lark.EventDispatcher({
			verificationToken: this.settings.webhookVerificationToken,
			encryptKey: this.settings.webhookEncryptKey,
		}).register({
			"im.message.receive_v1": async (data) => {
				await this.onReceive(data);
			},
			"card.action.trigger": async (data: RawCardActionEvent) => {
				const event = parseFeishuCardActionEvent(data);
				if (event && this.cardActionHandler) await this.cardActionHandler(event);
			},
			"vc.meeting.recording_started_v1": async (data) => {
				this.onMeetingRecordingEvent("started", data);
			},
			"vc.meeting.recording_ended_v1": async (data) => {
				this.onMeetingRecordingEvent("ended", data);
			},
			"vc.meeting.recording_ready_v1": async (data) => {
				this.onMeetingRecordingEvent("ready", data);
			},
		});

		if (this.settings.connectionMode === "webhook") {
			const handler = adaptDefault(this.settings.webhookPath ?? "/feishu/events", dispatcher, { autoChallenge: true });
			this.webhookServer = createServer((req, res) => {
				if (req.method !== "POST" || req.url !== (this.settings.webhookPath ?? "/feishu/events")) {
					res.statusCode = 404;
					res.end("not found");
					return;
				}
				const length = Number(req.headers["content-length"] ?? 0);
				if (!Number.isFinite(length) || length > MAX_WEBHOOK_BODY_BYTES) {
					res.writeHead(413).end("payload too large");
					req.destroy();
					return;
				}
				let bytes = 0;
				let rejected = false;
				req.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > MAX_WEBHOOK_BODY_BYTES && !rejected) {
						rejected = true;
						res.writeHead(413).end("payload too large");
						req.destroy();
					}
				});
				void handler(req, res).catch((error) => {
					if (rejected) return;
					console.error(`[beemax] Feishu webhook failed: ${String(error)}`);
					if (!res.headersSent) res.writeHead(500);
					res.end("internal error");
				});
			});
			this.webhookServer.requestTimeout = 15_000;
			this.webhookServer.headersTimeout = 10_000;
			this.webhookServer.keepAliveTimeout = 5_000;
			this.webhookServer.on("connection", (socket) => {
				this.webhookSockets.add(socket);
				socket.once("close", () => this.webhookSockets.delete(socket));
			});
			await new Promise<void>((resolve, reject) => {
				this.webhookServer?.once("error", reject).listen(this.settings.webhookPort ?? 8787, this.settings.webhookHost ?? "127.0.0.1", resolve);
			});
			await this.hydrateBotIdentity();
			this.assertCurrentConnection(generation);
			this.markConnected(generation);
			return true;
		}

		let wsClient!: WSClient;
		wsClient = new lark.WSClient({
			appId: this.settings.appId,
			appSecret: this.settings.appSecret,
			loggerLevel: lark.LoggerLevel.warn,
			domain,
			autoReconnect: true,
			source: "beemax",
			extraUaTags: ["channel"],
			handshakeTimeoutMs: 15_000,
			wsConfig: { pingTimeout: 10 },
			onReady: () => { if (this.isCurrentConnection(generation, wsClient)) this.markConnected(generation); },
			onReconnecting: () => { if (this.isCurrentConnection(generation, wsClient)) this.connected = false; },
			onReconnected: () => { if (this.isCurrentConnection(generation, wsClient)) this.markConnected(generation); },
			onError: (error) => {
				if (!this.isCurrentConnection(generation, wsClient)) return;
				this.connected = false;
				console.error(`[beemax] Feishu WebSocket connection failed: ${error.message}`);
			},
		});
		this.wsClient = wsClient;

		await wsClient.start({ eventDispatcher: dispatcher });
		this.assertCurrentConnection(generation, wsClient);

		// Hydrate bot identity (open_id) for @-mention matching.
		await this.hydrateBotIdentity();
		this.assertCurrentConnection(generation, wsClient);

		this.markConnected(generation);
		return true;
	}

	private async cleanupConnectionAttempt(generation: number): Promise<void> {
		if (generation !== this.connectionGeneration) return;
		this.connected = false;
		if (this.webhookServer) {
			for (const socket of this.webhookSockets) socket.destroy();
			await new Promise<void>((resolve) => this.webhookServer?.close(() => resolve()));
			this.webhookServer = undefined;
			this.webhookSockets.clear();
		}
		this.wsClient?.close({ force: true });
		this.wsClient = undefined;
	}

	private isCurrentConnection(generation: number, wsClient?: WSClient): boolean {
		return !this.shuttingDown && generation === this.connectionGeneration && (!wsClient || this.wsClient === wsClient);
	}

	private assertCurrentConnection(generation: number, wsClient?: WSClient): void {
		if (this.isCurrentConnection(generation, wsClient)) return;
		throw Object.assign(new Error("Feishu connection attempt was cancelled"), { code: "BEEMAX_CONNECTION_CANCELLED" });
	}

	private markConnected(generation: number): void {
		if (!this.isCurrentConnection(generation)) return;
		this.connected = true;
		void this.drainPendingInbound().catch((error) => console.error(`[beemax] Feishu inbound replay failed: ${error instanceof Error ? error.message : String(error)}`));
	}

	async disconnect(): Promise<void> {
		this.connectionGeneration += 1;
		this.connected = false;
		this.shuttingDown = true;
		this.cancelPendingInbound();
		this.cancelInboundBatches();
		await this.drainingInbound?.catch(() => undefined);
		await Promise.allSettled([...this.deliveryTails.values()]);
		await Promise.allSettled([...this.inFlightDeliveries]);
		if (this.webhookServer) {
			for (const socket of this.webhookSockets) socket.destroy();
			await new Promise<void>((resolve) => this.webhookServer?.close(() => resolve()));
			this.webhookServer = undefined;
			this.webhookSockets.clear();
		}
		this.wsClient?.close({ force: true });
		this.wsClient = undefined;
	}

	private async hydrateBotIdentity(): Promise<void> {
		if (this.settings.botOpenId) return;
		try {
			const response = await this.client.request<FeishuBotInfoResponse>({
				method: "GET",
				url: "open-apis/bot/v3/info",
			});
			if (response.code !== 0) throw new Error(response.msg ?? `Feishu code ${response.code}`);
			const bot = response.bot ?? response.data?.bot;
			if (bot?.open_id) this.settings.botOpenId = bot.open_id;
			if (!this.settings.botName && (bot?.app_name || bot?.bot_name)) {
				this.settings.botName = bot.app_name ?? bot.bot_name;
			}
			if (!this.settings.botOpenId) {
				console.warn("[beemax] Feishu bot info did not include open_id; group @mention matching may be unavailable");
			}
		} catch (error) {
			console.warn(
				`[beemax] Could not hydrate Feishu bot identity: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private onMeetingRecordingEvent(
		status: "started" | "ended" | "ready",
		data: FeishuMeetingRecordingEvent,
	): void {
		// Do not log the recording URL: it is a bearer-like sensitive resource.
		console.info("[beemax] Feishu meeting recording event", {
			status,
			meetingId: data.meeting?.id,
			meetingNo: data.meeting?.meeting_no,
			duration: status === "ready" ? data.duration : undefined,
		});
	}

	private async onReceive(data: FeishuReceiveEvent): Promise<void> {
		const msg = data?.message;
		const sender = data?.sender;
		if (!msg || !sender?.sender_id) return;

		if (this.isDuplicate(msg.message_id)) return;

		const reason = this.admit(sender, msg);
		if (reason !== null) {
			if (reason === "pairing required") await this.handlePairing(sender, msg);
			console.warn(`[beemax] rejected Feishu message ${msg.message_id}: ${reason}`);
			return;
		}

		const source = this.buildSource(data);
		const text = await this.extractText(msg);
		if (text.trim().toLowerCase() === "/set-home" && this.settings.setHomeChat) {
			const actorIds = [source.userIdAlt, source.userId].filter((id): id is string => Boolean(id));
			if (!this.settings.admins?.some((id) => actorIds.includes(id))) { await this.send(msg.chat_id, "Only a BeeMax Profile administrator can set the home chat."); return; }
			await this.settings.setHomeChat(msg.chat_id, source.userIdAlt ?? source.userId, source.chatType === "dm" ? "dm" : "group");
			await this.send(msg.chat_id, "This chat is now the BeeMax home destination for heartbeat alerts.");
			return;
		}
		const media = parseFeishuMediaDescriptor(msg);
		if (!text && !media) return;
		const downloaded = media ? await this.downloadMedia(msg.message_id, media) : undefined;

		const inbound: InboundMessage = {
			text: text || media?.displayName || `Received ${msg.message_type} attachment`,
			messageType: this.mapMessageType(msg.message_type),
			source,
			mediaPaths: downloaded ? [downloaded.path] : [],
			mediaTypes: downloaded ? [downloaded.mimeType] : [],
			releaseMedia: downloaded?.release,
			replyToMessageId: msg.root_id ?? msg.parent_id ?? undefined,
			timestamp: Number.parseInt(msg.create_time, 10) * 1000 || Date.now(),
			raw: data,
		};

		try {
			await this.dispatchInbound(inbound);
		} finally {
			// The Dispatcher normally releases during its own finally block. This
			// adapter-level fallback also covers missing or failing consumers.
			await downloaded?.release();
		}
	}

	private async dispatchInbound(message: InboundMessage): Promise<void> {
		if (this.shuttingDown) return;
		if (!this.canDispatchInbound()) {
			await this.queuePendingInbound(message);
			return;
		}
		if (message.messageType === "text" && !message.text.trimStart().startsWith("/")) {
			await this.enqueueTextBatch(message);
			return;
		}
		if (message.mediaPaths.length > 0 && ["image", "audio", "file"].includes(message.messageType)) {
			await this.enqueueMediaBatch(message);
			return;
		}
		await this.deliverInOrder(sessionOwnerKey(message.source), message);
	}

	private canDispatchInbound(): boolean {
		return Boolean(this.handler) && (this.connectionGeneration === 0 || this.connected) && !this.shuttingDown;
	}

	private queuePendingInbound(message: InboundMessage): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this.pendingInbound.length + this.pendingInboundInFlight >= MAX_PENDING_INBOUND) {
				const dropped = this.pendingInbound.shift();
				if (dropped) {
					this.forgetDedup(dropped.message);
					dropped.resolve();
				} else {
					this.forgetDedup(message);
					resolve();
					return;
				}
				console.warn("[beemax] Feishu pending inbound queue full; dropped oldest event");
			}
			this.pendingInbound.push({ message, resolve, reject });
		});
	}

	private async drainPendingInbound(): Promise<void> {
		if (this.drainingInbound) return this.drainingInbound;
		if (!this.canDispatchInbound() || this.pendingInbound.length === 0) return;
		const drain = (async () => {
			while (this.canDispatchInbound() && this.pendingInbound.length > 0) {
				const group = await this.takeReplayGroup();
				if (group.length === 0) continue;
				if (!this.canDispatchInbound()) {
					for (const pending of group) {
						this.forgetDedup(pending.message);
						pending.resolve();
					}
					this.pendingInboundInFlight -= group.length;
					continue;
				}
				const message = replayGroupMessage(group.map((pending) => pending.message));
				try {
					await this.deliverInOrder(sessionOwnerKey(message.source), message);
					for (const pending of group) pending.resolve();
				} catch (error) {
					for (const pending of group) pending.reject(error);
				} finally {
					this.pendingInboundInFlight -= group.length;
				}
			}
		})();
		this.drainingInbound = drain;
		try {
			await drain;
		} finally {
			if (this.drainingInbound === drain) this.drainingInbound = undefined;
		}
	}

	private async takeReplayGroup(): Promise<PendingInboundEvent[]> {
		const first = this.pendingInbound.shift();
		if (!first) return [];
		const message = first.message;
		const group = [first];
		this.pendingInboundInFlight += 1;
		try {
			if (message.messageType === "text" && !message.text.trimStart().startsWith("/")) {
				let chars = message.text.length;
				while (group.length < (this.settings.textBatchMaxMessages ?? 8)) {
					const next = this.pendingInbound[0];
					if (!next || next.message.messageType !== "text" || next.message.text.trimStart().startsWith("/")
						|| sessionOwnerKey(next.message.source) !== sessionOwnerKey(message.source)
						|| !this.batchCompatible(message, next.message)) break;
					const nextChars = chars + (chars && next.message.text ? 1 : 0) + next.message.text.length;
					if (nextChars > (this.settings.textBatchMaxChars ?? 4_000)) break;
					group.push(this.pendingInbound.shift()!);
					this.pendingInboundInFlight += 1;
					chars = nextChars;
				}
				return group;
			}
			if (message.mediaPaths.length > 0 && ["image", "audio", "file"].includes(message.messageType)) {
				let bytes = await mediaByteCount(message);
				while (group.length < MAX_MEDIA_BATCH_MESSAGES) {
					const next = this.pendingInbound[0];
					if (!next || next.message.messageType !== message.messageType
						|| sessionOwnerKey(next.message.source) !== sessionOwnerKey(message.source)
						|| !this.batchCompatible(message, next.message)) break;
					const nextBytes = await mediaByteCount(next.message);
					if (bytes + nextBytes > MAX_MEDIA_BATCH_BYTES) break;
					group.push(this.pendingInbound.shift()!);
					this.pendingInboundInFlight += 1;
					bytes += nextBytes;
				}
			}
			return group;
		} catch (error) {
			for (const pending of group) {
				this.forgetDedup(pending.message);
				pending.reject(error);
			}
			this.pendingInboundInFlight -= group.length;
			return [];
		}
	}

	private cancelPendingInbound(): void {
		for (const pending of this.pendingInbound.splice(0)) {
			this.forgetDedup(pending.message);
			pending.resolve();
		}
	}

	private forgetDedup(message: InboundMessage): void {
		if (message.source.messageId) this.dedup.delete(message.source.messageId);
	}

	private async enqueueTextBatch(message: InboundMessage): Promise<void> {
		const key = sessionOwnerKey(message.source);
		const existing = this.textBatches.get(key);
		if (existing && !this.batchCompatible(existing.message, message)) void this.flushTextBatch(key);
		const current = this.textBatches.get(key);
		const nextText = current ? mergeBatchText(current.message.text, message.text) : message.text;
		const maxMessages = this.settings.textBatchMaxMessages ?? 8;
		const maxChars = this.settings.textBatchMaxChars ?? 4_000;
		if (current && (current.count + 1 > maxMessages || nextText.length > maxChars)) void this.flushTextBatch(key);

		return new Promise<void>((resolve, reject) => {
			const pending = this.textBatches.get(key);
			if (!pending) {
				const batch: PendingInboundBatch = {
					message: { ...message, source: { ...message.source } },
					count: 1,
					lastChunkLength: message.text.length,
					timer: setTimeout(() => undefined, 0),
					waiters: [{ resolve, reject }],
				};
				clearTimeout(batch.timer);
				this.textBatches.set(key, batch);
				this.scheduleTextBatch(key, batch);
				return;
			}
			pending.message.text = mergeBatchText(pending.message.text, message.text);
			pending.message.timestamp = message.timestamp;
			pending.message.source = { ...message.source };
			pending.message.raw = message.raw;
			pending.count += 1;
			pending.lastChunkLength = message.text.length;
			pending.waiters.push({ resolve, reject });
			this.scheduleTextBatch(key, pending);
		});
	}

	private batchCompatible(existing: InboundMessage, incoming: InboundMessage): boolean {
		return existing.replyToMessageId === incoming.replyToMessageId
			&& existing.replyToText === incoming.replyToText
			&& existing.source.threadId === incoming.source.threadId;
	}

	private async enqueueMediaBatch(message: InboundMessage): Promise<void> {
		const key = `${sessionOwnerKey(message.source)}:media:${message.messageType}`;
		const byteCount = await mediaByteCount(message);
		const existing = this.mediaBatches.get(key);
		if (existing && (!this.batchCompatible(existing.message, message) || existing.message.messageType !== message.messageType)) {
			void this.flushMediaBatch(key);
		}
		const current = this.mediaBatches.get(key);
		if (current && (current.count + 1 > MAX_MEDIA_BATCH_MESSAGES || (current.byteCount ?? 0) + byteCount > MAX_MEDIA_BATCH_BYTES)) {
			void this.flushMediaBatch(key);
		}
		return new Promise<void>((resolve, reject) => {
			const pending = this.mediaBatches.get(key);
			if (!pending) {
				const batch: PendingInboundBatch = {
					message: { ...message, source: { ...message.source }, mediaPaths: [...message.mediaPaths], mediaTypes: [...message.mediaTypes] },
					mediaMessages: [message],
					count: 1,
					lastChunkLength: message.text.length,
					byteCount,
					timer: setTimeout(() => undefined, 0),
					waiters: [{ resolve, reject }],
				};
				clearTimeout(batch.timer);
				this.mediaBatches.set(key, batch);
				this.scheduleMediaBatch(key, batch);
				return;
			}
			pending.mediaMessages?.push(message);
			pending.count += 1;
			pending.byteCount = (pending.byteCount ?? 0) + byteCount;
			pending.waiters.push({ resolve, reject });
			this.scheduleMediaBatch(key, pending);
		});
	}

	private scheduleTextBatch(key: string, batch: PendingInboundBatch): void {
		clearTimeout(batch.timer);
		const delay = batch.lastChunkLength >= 4_000
			? (this.settings.textBatchSplitDelayMs ?? 2_000)
			: (this.settings.textBatchDelayMs ?? 600);
		batch.timer = setTimeout(() => { void this.flushTextBatch(key); }, delay);
	}

	private async flushTextBatch(key: string): Promise<void> {
		const batch = this.textBatches.get(key);
		if (!batch) return;
		this.textBatches.delete(key);
		clearTimeout(batch.timer);
		try {
			await this.deliverInOrder(key, batch.message);
			for (const waiter of batch.waiters) waiter.resolve();
		} catch (error) {
			for (const waiter of batch.waiters) waiter.reject(error);
		}
	}

	private scheduleMediaBatch(key: string, batch: PendingInboundBatch): void {
		clearTimeout(batch.timer);
		batch.timer = setTimeout(() => { void this.flushMediaBatch(key); }, this.settings.mediaBatchDelayMs ?? 800);
	}

	private async flushMediaBatch(key: string): Promise<void> {
		const batch = this.mediaBatches.get(key);
		if (!batch) return;
		this.mediaBatches.delete(key);
		clearTimeout(batch.timer);
		try {
			await this.deliverInOrder(sessionOwnerKey(batch.message.source), combineMediaBatch(batch.mediaMessages ?? [batch.message]));
			for (const waiter of batch.waiters) waiter.resolve();
		} catch (error) {
			for (const waiter of batch.waiters) waiter.reject(error);
		}
	}

	private async deliverInOrder(key: string, message: InboundMessage): Promise<void> {
		const prior = this.deliveryTails.get(key) ?? Promise.resolve();
		const admission = prior.catch(() => undefined).then(async () => {
			let delivery!: Promise<void>;
			delivery = Promise.resolve().then(() => this.handler?.(message)).finally(() => this.inFlightDeliveries.delete(delivery));
			this.inFlightDeliveries.add(delivery);
			await delivery;
		});
		this.deliveryTails.set(key, admission);
		try {
			await admission;
		} finally {
			if (this.deliveryTails.get(key) === admission) this.deliveryTails.delete(key);
		}
	}

	private cancelInboundBatches(): void {
		for (const batch of this.textBatches.values()) {
			clearTimeout(batch.timer);
			for (const waiter of batch.waiters) waiter.resolve();
		}
		this.textBatches.clear();
		for (const batch of this.mediaBatches.values()) {
			clearTimeout(batch.timer);
			for (const waiter of batch.waiters) waiter.resolve();
		}
		this.mediaBatches.clear();
	}

	private async downloadMedia(messageId: string, media: FeishuMediaDescriptor): Promise<{ path: string; mimeType: string; release: () => Promise<void> }> {
		const root = join(tmpdir(), "beemax-feishu-media");
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		const directory = await mkdtemp(join(root, "message-"));
		await chmod(directory, 0o700);
		const suffix = safeMediaExtension(media.displayName, media.mimeType);
		const path = join(directory, `${randomUUID()}${suffix}`);
		try {
			const resource = await this.client.im.v1.messageResource.get({
				params: { type: media.resourceType },
				path: { message_id: messageId, file_key: media.fileKey },
			});
			let bytes = 0;
			const limiter = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					bytes += chunk.byteLength;
					callback(bytes > MAX_INBOUND_MEDIA_BYTES ? new Error("Feishu attachment exceeds BeeMax's 25MB inbound limit") : undefined, chunk);
				},
			});
			await pipeline(resource.getReadableStream(), limiter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
			return { path, mimeType: headerMimeType(resource.headers) ?? media.mimeType, release: () => rm(directory, { recursive: true, force: true }) };
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}

	// --- access policy ---------------------------------------------------

	private admit(sender: FeishuSender, msg: FeishuMessage): string | null {
		if (sender.sender_type === "app") return "bot/app senders are not allowed";

		const ids = sender.sender_id
			? [sender.sender_id.union_id, sender.sender_id.user_id, sender.sender_id.open_id].filter(
					(value): value is string => Boolean(value),
				)
			: [];
		const chatType = msg.chat_type ?? "p2p";
		const globallyAuthorized = this.settings.allowAllUsers || ids.some((id) => this.settings.allowedUsers.includes(id)) || Boolean(this.settings.pairing?.isApproved("feishu", ids));
		if (chatType === "p2p") return globallyAuthorized ? null : this.settings.pairing ? "pairing required" : "sender is not authorized";
		const rule = this.settings.groupRules?.[msg.chat_id];
		if (!rule && this.settings.allowedChats.length > 0 && !this.settings.allowedChats.includes(msg.chat_id)) return "chat is not in FEISHU_ALLOWED_CHATS";
		const policy = rule?.policy ?? this.settings.groupPolicy ?? "allowlist";
		if (policy === "disabled") return "group is disabled";
		if (policy === "allowlist" && !(rule?.allowlist?.some((id) => ids.includes(id)) || globallyAuthorized)) return "sender is not authorized for group";
		if (policy === "blacklist" && rule?.blacklist?.some((id) => ids.includes(id))) return "sender is blocked in group";
		if (policy === "admin_only" && !this.settings.admins?.some((id) => ids.includes(id))) return "sender is not a group admin";
		if ((rule?.requireMention ?? this.settings.requireMention) && !this.isBotMentioned(msg)) {
			return "group message without bot mention";
		}
		return null;
	}

	private async handlePairing(sender: FeishuSender, msg: FeishuMessage): Promise<void> {
		const identity = sender.sender_id?.union_id ?? sender.sender_id?.user_id ?? sender.sender_id?.open_id;
		if (!identity || !this.settings.pairing) return;
		const result = this.settings.pairing.request("feishu", identity);
		if (result.status === "created" || result.status === "existing") {
			await this.send(msg.chat_id, `BeeMax access approval is required.\n\nPairing code: ${result.code}\n\nAsk the Profile owner to run:\nbeemax pairing approve feishu ${result.code}\n\nThis code expires in 1 hour.`);
		} else if (result.status === "capacity") {
			await this.send(msg.chat_id, "BeeMax has too many pending access requests. Ask the Profile owner to review them with `beemax pairing list`.");
		}
	}

	private isBotMentioned(msg: FeishuMessage): boolean {
		const mentions = msg.mentions ?? [];
		const botOpenId = this.settings.botOpenId;
		for (const m of mentions) {
			if (botOpenId && m.id.open_id === botOpenId) return true;
			if (this.settings.botName && m.name === this.settings.botName) return true;
		}
		return false;
	}

	private buildSource(data: FeishuReceiveEvent): SessionSource {
		const msg = data.message;
		const senderId = data.sender.sender_id;
		return {
			platform: "feishu",
			chatId: msg.chat_id,
			chatType: (msg.chat_type === "p2p" ? "dm" : "group") as SessionSource["chatType"],
			threadId: msg.thread_id ?? undefined,
			userId: senderId?.open_id ?? undefined,
			userIdAlt: senderId?.union_id ?? undefined,
			messageId: msg.message_id,
			isBot: data.sender.sender_type === "app",
		};
	}

	// --- text extraction -------------------------------------------------

	private async extractText(msg: FeishuMessage): Promise<string> {
		if (msg.message_type !== "text" && msg.message_type !== "post") return "";
		let content: { text?: string; title?: unknown; content?: unknown[] };
		try {
			content = JSON.parse(msg.content);
		} catch {
			return "";
		}
		if (msg.message_type === "text") return content.text ?? "";
		// post: render nested zh_cn/en_us structure to plain text.
		return renderPost(content);
	}

	private mapMessageType(t: string): InboundMessage["messageType"] {
		switch (t) {
			case "text":
				return "text";
			case "image":
				return "image";
			case "audio":
				return "audio";
			case "file":
			case "media":
				return "file";
			default:
				return "text";
		}
	}

	// --- dedup -----------------------------------------------------------

	private isDuplicate(messageId: string): boolean {
		const now = Date.now();
		this.purgeDedup(now);
		if (this.dedup.has(messageId)) return true;
		this.dedup.set(messageId, now);
		return false;
	}

	private purgeDedup(now: number): void {
		for (const [id, ts] of this.dedup) {
			if (now - ts > this.dedupTtlMs) this.dedup.delete(id);
		}
	}

	// --- outbound --------------------------------------------------------

	async send(chatId: string, content: string, opts?: { asCard?: boolean; idempotencyKey?: string }): Promise<SendResult> {
		const chunks = chunkText(content, MAX_TEXT_LENGTH);
		let lastId: string | undefined;
		for (const [index, chunk] of chunks.entries()) {
			const uuid = opts?.idempotencyKey ? deterministicUuid(`${opts.idempotencyKey}:${index}`) : randomUUID();
			const payload = opts?.asCard
				? buildCardPayload(chunk)
				: { msg_type: "text", content: JSON.stringify({ text: chunk }) };
			try {
				const res = await this.retryRequest(() => this.client.im.v1.message.create({
					params: { receive_id_type: "chat_id" },
					data: { receive_id: chatId, ...payload, uuid },
				}));
				if (res.code !== 0) {
					return { success: false, error: res.msg ?? `feishu code ${res.code}` };
				}
				lastId = res.data?.message_id;
			} catch (err) {
				return { success: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		return { success: true, messageId: lastId };
	}

	async sendImage(chatId: string, imagePath: string): Promise<SendResult> {
		try {
			const info = await stat(imagePath);
			if (!info.isFile() || info.size === 0 || info.size > 10 * 1024 * 1024) {
				return { success: false, error: "Feishu image must be a non-empty file no larger than 10MB" };
			}
			const uploaded = await this.retryRequest(() => withFileStream(imagePath, (image) => this.client.im.v1.image.create({
				data: { image_type: "message", image },
			})));
			if (!uploaded?.image_key) return { success: false, error: "Feishu image upload returned no image_key" };
			const uuid = randomUUID();
			const sent = await this.retryRequest(() => this.client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "image",
					content: JSON.stringify({ image_key: uploaded.image_key }),
					uuid,
				},
			}));
			if (sent.code !== 0) return { success: false, error: sent.msg ?? `feishu code ${sent.code}` };
			return { success: true, messageId: sent.data?.message_id };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async sendMedia(chatId: string, mediaPath: string, mimeType?: string, name?: string): Promise<SendResult> {
		if (isImageMedia(mediaPath, mimeType)) return this.sendImage(chatId, mediaPath);
		try {
			const info = await stat(mediaPath);
			if (!info.isFile() || info.size === 0 || info.size > MAX_OUTBOUND_FILE_BYTES) {
				return { success: false, error: "Feishu media must be a non-empty file no larger than 30MB" };
			}
			const fileType = feishuFileType(mediaPath, mimeType);
			const uploaded = await this.retryRequest(() => withFileStream(mediaPath, (file) => this.client.im.v1.file.create({
				data: { file_type: fileType, file_name: name || basename(mediaPath), file },
			})));
			if (!uploaded?.file_key) return { success: false, error: "Feishu file upload returned no file_key" };
			const msgType = fileType === "opus" ? "audio" : fileType === "mp4" ? "media" : "file";
			const uuid = randomUUID();
			const sent = await this.retryRequest(() => this.client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: chatId, msg_type: msgType, content: JSON.stringify({ file_key: uploaded.file_key }), uuid },
			}));
			if (sent.code !== 0) return { success: false, error: sent.msg ?? `feishu code ${sent.code}` };
			return { success: true, messageId: sent.data?.message_id };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async editMessage(chatId: string, messageId: string, content: string): Promise<SendResult> {
		// Edit via patch (update shared card / text). We send an interactive
		// card for the placeholder so patch can update it; final text replaces it.
		try {
			const res = await this.retryRequest(() => this.client.im.v1.message.patch({
				data: { content: JSON.stringify(buildCardContent(content)) },
				path: { message_id: messageId },
			}));
			if (res.code !== 0) {
				// If patch fails (e.g. was a text message, not a card), fall back to a new send.
				return await this.send(chatId, content);
			}
			return { success: true, messageId };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async sendTyping(_chatId: string, messageId?: string): Promise<void> {
		if (!messageId) return;
		if (this.processingReactions.has(messageId)) return;
		try {
			const res = await this.client.im.v1.messageReaction.create({
				path: { message_id: messageId },
				data: { reaction_type: { emoji_type: "Typing" } },
			});
			const reactionId = res.code === 0 ? res.data?.reaction_id : undefined;
			if (!reactionId) return;
			this.processingReactions.delete(messageId);
			this.processingReactions.set(messageId, reactionId);
			while (this.processingReactions.size > MAX_PROCESSING_REACTIONS) {
				const oldest = this.processingReactions.keys().next().value;
				if (typeof oldest !== "string") break;
				const oldestReactionId = this.processingReactions.get(oldest);
				this.processingReactions.delete(oldest);
				if (oldestReactionId) {
					try {
						await this.client.im.v1.messageReaction.delete({ path: { message_id: oldest, reaction_id: oldestReactionId } });
					} catch { /* best effort */ }
				}
			}
		} catch {
			// Reactions are a best-effort UX enhancement and must never fail a turn.
		}
	}

	async stopTyping(_chatId: string, messageId?: string, failed = false): Promise<void> {
		if (!messageId) return;
		const reactionId = this.processingReactions.get(messageId);
		this.processingReactions.delete(messageId);
		if (reactionId) {
			try {
				await this.client.im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } });
			} catch {
				// Best effort; a removed/expired source message is harmless here.
			}
		}
		if (failed) {
			try {
				await this.client.im.v1.messageReaction.create({
					path: { message_id: messageId },
					data: { reaction_type: { emoji_type: "CrossMark" } },
				});
			} catch {
				// Best effort; the error card/text remains the authoritative failure signal.
			}
		}
	}

	/** Send an interactive card. Returns the Feishu message_id for later updates. */
	async sendCard(chatId: string, card: Record<string, unknown>, replyTo?: string, replyInThread = false, idempotencyKey?: string): Promise<SendResult> {
		try {
			const payload = { msg_type: "interactive", content: JSON.stringify(card) };
			const uuid = idempotencyKey ? deterministicUuid(idempotencyKey) : randomUUID();
			let res = replyTo ? await this.retryRequest(() => this.client.im.v1.message.reply({
				path: { message_id: replyTo },
				data: { ...payload, reply_in_thread: replyInThread, uuid },
			})) : await this.retryRequest(() => this.client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: chatId, ...payload, uuid },
			}));
			if (replyTo && !replyInThread && (res.code === 230011 || res.code === 231003)) {
				res = await this.retryRequest(() => this.client.im.v1.message.create({
					params: { receive_id_type: "chat_id" },
					data: { receive_id: chatId, ...payload, uuid: idempotencyKey ? deterministicUuid(`${idempotencyKey}:fallback`) : randomUUID() },
				}));
			}
			if (res.code !== 0) return { success: false, error: res.msg ?? `feishu code ${res.code}` };
			return { success: true, messageId: res.data?.message_id };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Update a previously-sent interactive card in place (streaming). */
	async updateCard(messageId: string, card: Record<string, unknown>): Promise<SendResult> {
		try {
			const res = await this.retryRequest(() => this.client.im.v1.message.patch({
				data: { content: JSON.stringify(card) },
				path: { message_id: messageId },
			}));
			if (res.code !== 0) return { success: false, error: res.msg ?? `feishu code ${res.code}` };
			return { success: true, messageId };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	private retryRequest<T>(operation: () => Promise<T>): Promise<T> {
		return retryFeishuOperation(operation, { attempts: 3, baseDelayMs: this.settings.retryBaseDelayMs ?? 1_000 });
	}
}

function deterministicUuid(value: string): string {
	const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cardActionId(messageId: string, openId: string, element: string, value: unknown): string {
	const action = isRecord(value) ? String(value.beemax_action ?? "") : "";
	const approvalId = isRecord(value) ? String(value.approval_id ?? "") : "";
	const choice = isRecord(value) ? String(value.choice ?? "") : "";
	return `feishu-card:${messageId}:${openId}:${element}:${action}:${approvalId}:${choice}`;
}

export function parseFeishuCardActionEvent(data: RawCardActionEvent): PlatformCardAction | undefined {
	const event = normalizeCardAction(data);
	if (!event) return undefined;
	return {
		messageId: event.messageId,
		chatId: event.chatId,
		userId: event.operator.openId,
		userIdAlt: data.operator?.union_id ?? event.operator.userId,
		actionId: cardActionId(event.messageId, event.operator.openId, event.action.name ?? event.action.tag, event.action.value),
		value: isRecord(event.action.value) ? event.action.value : {},
	};
}

// --- payload builders ----------------------------------------------------

function buildCardPayload(text: string): { msg_type: "interactive"; content: string } {
	return {
		msg_type: "interactive",
		content: JSON.stringify(buildCardContent(text)),
	};
}

function buildCardContent(text: string): {
	config: { wide_screen_mode: boolean; update_multi: boolean };
	elements: Array<{ tag: "markdown"; content: string }>;
} {
	return {
		config: { wide_screen_mode: true, update_multi: true },
		elements: [{ tag: "markdown", content: text }],
	};
}

function chunkText(text: string, max: number): string[] {
	if (text.length <= max) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > max) {
		chunks.push(rest.slice(0, max));
		rest = rest.slice(max);
	}
	if (rest) chunks.push(rest);
	return chunks;
}

function renderPost(content: { title?: unknown; content?: unknown[] }): string {
	const locale = (content as { zh_cn?: unknown; en_us?: unknown }).zh_cn ?? (content as { en_us?: unknown }).en_us;
	const blocks = (locale as { content?: unknown[] } | undefined)?.content;
	if (!Array.isArray(blocks)) return "";
	const parts: string[] = [];
	for (const block of blocks) {
		if (!Array.isArray(block)) continue;
		for (const el of block) {
			if (typeof el !== "object" || el === null) continue;
			const e = el as { tag?: string; text?: string; name?: string; unescape?: string };
			if (e.tag === "text" && typeof e.text === "string") parts.push(e.text);
			else if (e.tag === "at" && typeof e.name === "string") parts.push(`@${e.name}`);
			else if (e.tag === "a" && typeof e.text === "string") parts.push(e.text);
		}
	}
	return parts.join("");
}

// --- inbound event shape (subset we use) --------------------------------

interface FeishuBotInfoResponse {
	code?: number;
	msg?: string;
	bot?: FeishuBotIdentityPayload;
	data?: { bot?: FeishuBotIdentityPayload };
}

interface FeishuBotIdentityPayload {
	open_id?: string;
	app_name?: string;
	bot_name?: string;
}

interface FeishuMeetingRecordingEvent {
	meeting?: {
		id?: string;
		meeting_no?: string;
	};
	duration?: string;
	url?: string;
}

interface FeishuReceiveEvent {
	event_id?: string;
	sender: FeishuSender;
	message: FeishuMessage;
}

interface FeishuSender {
	sender_id?: { open_id?: string; union_id?: string; user_id?: string };
	sender_type: string;
}

interface FeishuMessage {
	message_id: string;
	root_id?: string;
	parent_id?: string;
	chat_id: string;
	thread_id?: string;
	chat_type: string;
	message_type: string;
	content: string;
	mentions?: Array<{ key: string; id: { open_id?: string; union_id?: string }; name: string }>;
	create_time: string;
}

export interface FeishuMediaDescriptor {
	fileKey: string;
	resourceType: "image" | "file";
	mimeType: string;
	displayName?: string;
}

export function parseFeishuMediaDescriptor(message: Pick<FeishuMessage, "message_type" | "content">): FeishuMediaDescriptor | undefined {
	if (!["image", "audio", "file", "media"].includes(message.message_type)) return undefined;
	let content: { image_key?: unknown; file_key?: unknown; file_name?: unknown };
	try { content = JSON.parse(message.content) as typeof content; } catch { return undefined; }
	const key = message.message_type === "image" ? content.image_key : content.file_key;
	if (typeof key !== "string" || !key) return undefined;
	const displayName = typeof content.file_name === "string" ? content.file_name : undefined;
	return {
		fileKey: key,
		resourceType: message.message_type === "image" ? "image" : "file",
		mimeType: inferMediaMimeType(message.message_type, displayName),
		displayName,
	};
}

function inferMediaMimeType(messageType: string, name?: string): string {
	if (messageType === "image") return "image/jpeg";
	if (messageType === "audio") return "audio/ogg";
	const extension = extname(name ?? "").toLowerCase();
	return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4" } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function mergeBatchText(existing: string, incoming: string): string {
	return existing && incoming ? `${existing}\n${incoming}` : existing || incoming;
}

function combineMediaBatch(messages: InboundMessage[]): InboundMessage {
	const ordered = [...messages].sort((left, right) => left.timestamp - right.timestamp);
	const first = ordered[0]!;
	const latest = ordered[ordered.length - 1]!;
	return {
		...first,
		text: ordered.map((message) => message.text).reduce(mergeBatchText, ""),
		source: { ...latest.source },
		mediaPaths: ordered.flatMap((message) => message.mediaPaths),
		mediaTypes: ordered.flatMap((message) => message.mediaTypes),
		timestamp: latest.timestamp,
		raw: latest.raw,
	};
}

function replayGroupMessage(messages: InboundMessage[]): InboundMessage {
	if (messages.length === 1) return messages[0]!;
	if (messages[0]?.mediaPaths.length) return combineMediaBatch(messages);
	const first = messages[0]!;
	const latest = messages[messages.length - 1]!;
	return {
		...first,
		text: messages.map((message) => message.text).reduce(mergeBatchText, ""),
		source: { ...latest.source },
		timestamp: latest.timestamp,
		raw: latest.raw,
	};
}

async function withFileStream<T>(path: string, operation: (stream: ReturnType<typeof createReadStream>) => Promise<T>): Promise<T> {
	const stream = createReadStream(path);
	try {
		return await operation(stream);
	} finally {
		stream.destroy();
	}
}

async function mediaByteCount(message: InboundMessage): Promise<number> {
	let total = 0;
	for (const path of message.mediaPaths) total += (await stat(path)).size;
	return total;
}

function isImageMedia(path: string, mimeType?: string): boolean {
	if (mimeType?.toLowerCase().startsWith("image/")) return true;
	return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".bmp", ".ico"].includes(extname(path).toLowerCase());
}

function feishuFileType(path: string, mimeType?: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
	const extension = extname(path).toLowerCase();
	const mime = mimeType?.toLowerCase();
	if (extension === ".opus" || mime === "audio/opus") return "opus";
	if (extension === ".mp4" || mime === "video/mp4") return "mp4";
	if (extension === ".pdf" || mime === "application/pdf") return "pdf";
	if ([".doc", ".docx"].includes(extension)) return "doc";
	if ([".xls", ".xlsx"].includes(extension)) return "xls";
	if ([".ppt", ".pptx"].includes(extension)) return "ppt";
	return "stream";
}

function safeMediaExtension(name: string | undefined, mimeType: string): string {
	const candidate = extname(name ?? "").toLowerCase();
	if (/^\.[a-z0-9]{1,8}$/.test(candidate)) return candidate;
	return ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/wav": ".wav", "application/pdf": ".pdf", "text/plain": ".txt" } as Record<string, string>)[mimeType] ?? ".bin";
}

function headerMimeType(headers: unknown): string | undefined {
	if (!headers || typeof headers !== "object") return undefined;
	const value = (headers as Record<string, unknown>)["content-type"];
	return typeof value === "string" && value.includes("/") ? value.split(";", 1)[0]?.trim() : undefined;
}

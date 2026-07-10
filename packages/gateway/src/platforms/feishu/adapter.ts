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

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import lark, { adaptDefault, type Client, type EventDispatcher, type WSClient } from "@larksuiteoapi/node-sdk";
import type {
	InboundMessage,
	MessageHandler,
	PlatformAdapter,
	SendResult,
	SessionSource,
} from "../../core/types.ts";
import type { FeishuSettings } from "./settings.ts";

const FEISHU_DOMAIN = lark.Domain.Feishu;
const LARK_DOMAIN = lark.Domain.Lark;

const MAX_TEXT_LENGTH = 4000; // Feishu text message soft cap; we chunk on this.

export class FeishuAdapter implements PlatformAdapter {
	readonly name = "feishu" as const;
	private connected = false;
	private client!: Client;
	private wsClient?: WSClient;
	private webhookServer?: Server;
	private handler?: MessageHandler;
	private dedup = new Map<string, number>();
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
	}

	async connect(): Promise<boolean> {
		if (!this.settings.appId || !this.settings.appSecret) {
			throw new Error("Feishu requires FEISHU_APP_ID and FEISHU_APP_SECRET.");
		}
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
				if (req.url?.split("?", 1)[0] !== (this.settings.webhookPath ?? "/feishu/events")) {
					res.statusCode = 404;
					res.end("not found");
					return;
				}
				void handler(req, res).catch((error) => {
					console.error(`[beemax] Feishu webhook failed: ${String(error)}`);
					if (!res.headersSent) res.writeHead(500);
					res.end("internal error");
				});
			});
			await new Promise<void>((resolve, reject) => {
				this.webhookServer?.once("error", reject).listen(this.settings.webhookPort ?? 8787, this.settings.webhookHost ?? "127.0.0.1", resolve);
			});
			await this.hydrateBotIdentity();
			this.connected = true;
			return true;
		}

		this.wsClient = new lark.WSClient({
			appId: this.settings.appId,
			appSecret: this.settings.appSecret,
			loggerLevel: lark.LoggerLevel.warn,
			domain,
		});

		await this.wsClient.start({ eventDispatcher: dispatcher });

		// Hydrate bot identity (open_id) for @-mention matching.
		await this.hydrateBotIdentity();

		this.connected = true;
		return true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		if (this.webhookServer) {
			await new Promise<void>((resolve) => this.webhookServer?.close(() => resolve()));
			this.webhookServer = undefined;
		}
		// The official SDK does not expose a stop() for WSClient in this version;
		// process exit will close the socket. For graceful shutdown within a
		// long-running host, we drop references and let the process handle it.
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
			console.warn(`[beemax] rejected Feishu message ${msg.message_id}: ${reason}`);
			return;
		}

		const source = this.buildSource(data);
		const text = await this.extractText(msg);
		if (!text && msg.message_type !== "image") return;

		const inbound: InboundMessage = {
			text,
			messageType: this.mapMessageType(msg.message_type),
			source,
			mediaPaths: [],
			mediaTypes: [],
			replyToMessageId: msg.root_id ?? msg.parent_id ?? undefined,
			timestamp: Number.parseInt(msg.create_time, 10) * 1000 || Date.now(),
			raw: data,
		};

		await this.handler?.(inbound);
	}

	// --- access policy ---------------------------------------------------

	private admit(sender: FeishuSender, msg: FeishuMessage): string | null {
		if (sender.sender_type === "app") return "bot/app senders are not allowed";

		const ids = sender.sender_id
			? [sender.sender_id.union_id, sender.sender_id.user_id, sender.sender_id.open_id].filter(
					(value): value is string => Boolean(value),
				)
			: [];
		if (!this.settings.allowAllUsers && !ids.some((id) => this.settings.allowedUsers.includes(id))) {
			return "sender is not in FEISHU_ALLOWED_USERS";
		}
		if (this.settings.allowedChats.length > 0 && !this.settings.allowedChats.includes(msg.chat_id)) {
			return "chat is not in FEISHU_ALLOWED_CHATS";
		}

		const chatType = msg.chat_type ?? "p2p";
		if (chatType !== "p2p" && this.settings.requireMention && !this.isBotMentioned(msg)) {
			return "group message without bot mention";
		}
		return null;
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

	async send(chatId: string, content: string, opts?: { asCard?: boolean }): Promise<SendResult> {
		const chunks = chunkText(content, MAX_TEXT_LENGTH);
		let lastId: string | undefined;
		for (const chunk of chunks) {
			const payload = opts?.asCard
				? buildCardPayload(chunk)
				: { msg_type: "text", content: JSON.stringify({ text: chunk }) };
			try {
				const res = await this.client.im.v1.message.create({
					params: { receive_id_type: "chat_id" },
					data: { receive_id: chatId, ...payload },
				});
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
			const uploaded = await this.client.im.v1.image.create({
				data: { image_type: "message", image: createReadStream(imagePath) },
			});
			if (!uploaded?.image_key) return { success: false, error: "Feishu image upload returned no image_key" };
			const sent = await this.client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "image",
					content: JSON.stringify({ image_key: uploaded.image_key }),
				},
			});
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
			const res = await this.client.im.v1.message.patch({
				data: { content: JSON.stringify(buildCardContent(content)) },
				path: { message_id: messageId },
			});
			if (res.code !== 0) {
				// If patch fails (e.g. was a text message, not a card), fall back to a new send.
				return await this.send(chatId, content);
			}
			return { success: true, messageId };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async sendTyping(_chatId: string): Promise<void> {
		// Feishu has no typing indicator API; the in-progress card edit serves as the indicator.
	}

	async stopTyping(_chatId: string): Promise<void> {
		// No-op; see sendTyping.
	}

	/** Send an interactive card. Returns the Feishu message_id for later updates. */
	async sendCard(chatId: string, card: Record<string, unknown>, replyTo?: string): Promise<SendResult> {
		try {
			const res = await this.client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "interactive",
					content: JSON.stringify(card),
				},
			});
			if (res.code !== 0) return { success: false, error: res.msg ?? `feishu code ${res.code}` };
			void replyTo;
			return { success: true, messageId: res.data?.message_id };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Update a previously-sent interactive card in place (streaming). */
	async updateCard(messageId: string, card: Record<string, unknown>): Promise<SendResult> {
		try {
			const res = await this.client.im.v1.message.patch({
				data: { content: JSON.stringify(card) },
				path: { message_id: messageId },
			});
			if (res.code !== 0) return { success: false, error: res.msg ?? `feishu code ${res.code}` };
			return { success: true, messageId };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
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

import { basename, join } from "node:path";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GroupActivationController, type GroupActivationDecision, type GroupActivationMode, type GroupActivationSignal, type InboundMessage, type MessageHandler, type ObservationHandler, type PlatformAdapter, type SendOptions, type SendResult } from "@beemax/channel-runtime";

export interface TelegramSettings {
	allowedUsers: string[];
	allowedChats: string[];
	allowAllUsers: boolean;
	pollingTimeoutSeconds?: number;
	retryBaseDelayMs?: number;
	apiBaseUrl?: string;
	mediaMaxBytes?: number;
	activation?: { mode?: GroupActivationMode; respondTo?: GroupActivationSignal[]; ambientObservation?: boolean; activeThreadTtlMs?: number; maxActiveThreads?: number };
}
export interface TelegramCredentials { botToken: string; }
export type TelegramCredentialConsumer = <T>(consumer: (credentials: Readonly<TelegramCredentials>) => T) => T | undefined;

export interface TelegramAdapterDependencies {
	fetch?: typeof globalThis.fetch;
}

interface TelegramEnvelope<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramUser { id: number; username?: string; first_name?: string; last_name?: string; }
interface TelegramChat { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string; }
interface TelegramMessage {
	message_id: number;
	date: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	message_thread_id?: number;
	entities?: TelegramMessageEntity[];
	caption_entities?: TelegramMessageEntity[];
	reply_to_message?: { message_id: number; text?: string; caption?: string; from?: TelegramUser };
	photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
	document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
	audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
	voice?: { file_id: string; mime_type?: string; file_size?: number };
}
interface TelegramMessageEntity { type: string; offset: number; length: number; }
interface TelegramUpdate { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage; channel_post?: TelegramMessage; }

/** Telegram Bot API Adapter using bounded long polling and no channel-specific Agent runtime. */
export class TelegramAdapter implements PlatformAdapter {
	readonly name = "telegram" as const;
	readonly capabilities = { mediaDelivery: "files", messageEditing: true, interactiveActions: false, richPresentation: false } as const;
	private readonly settings: Required<Pick<TelegramSettings, "pollingTimeoutSeconds" | "retryBaseDelayMs" | "apiBaseUrl" | "mediaMaxBytes" | "activation">> & TelegramSettings;
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly consumeCredentials: TelegramCredentialConsumer;
	private readonly activationController: GroupActivationController;
	private handler?: MessageHandler;
	private observationHandler?: ObservationHandler;
	private abortController?: AbortController;
	private pollTask?: Promise<void>;
	private connected = false;
	private offset = 0;
	private botId?: number;
	private botUsername?: string;

	constructor(settings: TelegramSettings, consumeCredentials: TelegramCredentialConsumer, dependencies: TelegramAdapterDependencies = {}) {
		if (consumeCredentials((credentials) => Boolean(credentials.botToken.trim())) !== true) throw new Error("Telegram bot token is required");
		this.settings = {
			...settings,
			allowedUsers: normalizeIds(settings.allowedUsers),
			allowedChats: normalizeIds(settings.allowedChats),
			pollingTimeoutSeconds: boundedInteger(settings.pollingTimeoutSeconds, 25, 1, 50),
			retryBaseDelayMs: boundedInteger(settings.retryBaseDelayMs, 1_000, 0, 30_000),
			apiBaseUrl: (settings.apiBaseUrl ?? "https://api.telegram.org").replace(/\/$/, ""),
			mediaMaxBytes: boundedInteger(settings.mediaMaxBytes, 25 * 1024 * 1024, 1_024, 100 * 1024 * 1024),
			activation: {
				mode: settings.activation?.mode ?? "explicit",
				respondTo: settings.activation?.respondTo ?? ["mention", "reply", "command"],
				ambientObservation: settings.activation?.ambientObservation ?? false,
				activeThreadTtlMs: settings.activation?.activeThreadTtlMs,
				maxActiveThreads: settings.activation?.maxActiveThreads,
			},
		};
		this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
		this.consumeCredentials = consumeCredentials;
		this.activationController = new GroupActivationController({ activeThreadTtlMs: this.settings.activation.activeThreadTtlMs, maxActiveThreads: this.settings.activation.maxActiveThreads });
	}

	get isConnected(): boolean { return this.connected; }

	onMessage(handler: MessageHandler): void { this.handler = handler; }
	onObservation(handler: ObservationHandler): void { this.observationHandler = handler; }

	admit(source: { chatId: string; userId?: string; chatType?: "dm" | "group" | "channel" | "thread"; threadId?: string; signals?: Partial<Record<GroupActivationSignal, boolean>> }): string | null {
		if (this.settings.allowedChats.length && !this.settings.allowedChats.includes(source.chatId)) return "chat is not authorized";
		const actorAuthorized = this.settings.allowAllUsers || Boolean(source.userId && this.settings.allowedUsers.includes(source.userId));
		if (source.chatType && source.chatType !== "dm") {
			const decision = this.decideGroup(source, actorAuthorized);
			return decision.admitted ? null : decision.reason === "actor_not_allowed" ? "user is not authorized" : decision.reason;
		}
		if (!actorAuthorized) return "user is not authorized";
		return null;
	}

	private decideGroup(source: { chatId: string; userId?: string; threadId?: string; signals?: Partial<Record<GroupActivationSignal, boolean>> }, actorAuthorized: boolean): GroupActivationDecision {
		return this.activationController.decide(`${source.chatId}:${source.threadId ?? "root"}`, {
			policy: this.settings.allowAllUsers ? "open" : "allowlist",
			actorIds: source.userId ? [source.userId] : [], actorAuthorized, actorIsAdmin: false, allowlist: this.settings.allowedUsers,
			mode: this.settings.activation.mode ?? "explicit", respondTo: this.settings.activation.respondTo ?? [], signals: source.signals ?? {},
			ambientObservation: this.settings.activation.ambientObservation,
		});
	}

	async connect(): Promise<boolean> {
		if (this.connected) return true;
		const controller = new AbortController();
		this.abortController = controller;
		try {
			const bot = await this.api<TelegramUser>("getMe", {}, controller.signal);
			this.botId = bot.id;
			this.botUsername = bot.username;
		}
		catch (error) { if (this.abortController === controller) this.abortController = undefined; throw error; }
		if (controller.signal.aborted) return false;
		this.connected = true;
		this.pollTask = this.pollLoop(controller.signal).catch((error) => {
			if (!controller.signal.aborted) console.error(`[beemax] Telegram polling stopped: ${safeError(error)}`);
		}).finally(() => { this.connected = false; });
		return true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.abortController?.abort(new Error("Telegram adapter stopped"));
		const task = this.pollTask;
		this.abortController = undefined;
		this.pollTask = undefined;
		if (task) await settleWithin(task.catch(() => undefined), 2_000);
	}

	async send(chatId: string, content: string, opts: SendOptions = {}): Promise<SendResult> {
		let messageId: string | undefined;
		for (const chunk of splitText(content, 4_000)) {
			const result = await this.api<{ message_id: number }>("sendMessage", {
				chat_id: chatId,
				text: chunk,
				...(opts.replyTo && Number.isSafeInteger(Number(opts.replyTo)) ? { reply_parameters: { message_id: Number(opts.replyTo) } } : {}),
			});
			messageId = String(result.message_id);
		}
		return { success: true, messageId };
	}

	async editMessage(chatId: string, messageId: string, content: string): Promise<SendResult> {
		const result = await this.api<{ message_id: number }>("editMessageText", { chat_id: chatId, message_id: Number(messageId), text: content.slice(0, 4_000) });
		return { success: true, messageId: String(result.message_id) };
	}

	async sendTyping(chatId: string): Promise<void> {
		await this.api("sendChatAction", { chat_id: chatId, action: "typing" });
	}

	async stopTyping(): Promise<void> {
		// Telegram typing actions expire automatically after a few seconds.
	}

	async sendImage(chatId: string, imagePath: string): Promise<SendResult> {
		return this.sendMultipart("sendPhoto", chatId, "photo", imagePath);
	}

	async sendMedia(chatId: string, mediaPath: string, mimeType?: string, name?: string): Promise<SendResult> {
		if (mimeType?.startsWith("image/")) return this.sendImage(chatId, mediaPath);
		return this.sendMultipart("sendDocument", chatId, "document", mediaPath, mimeType, name);
	}

	private async pollLoop(signal: AbortSignal): Promise<void> {
		let failures = 0;
		while (!signal.aborted) {
			try {
				const updates = await this.api<TelegramUpdate[]>("getUpdates", {
					offset: this.offset,
					timeout: this.settings.pollingTimeoutSeconds,
					allowed_updates: ["message", "edited_message", "channel_post"],
				}, signal);
				failures = 0;
				for (const update of updates) {
					this.offset = Math.max(this.offset, update.update_id + 1);
					await this.dispatchUpdate(update);
				}
			} catch (error) {
				if (signal.aborted) return;
				failures++;
				const delay = Math.min(30_000, this.settings.retryBaseDelayMs * 2 ** Math.min(failures - 1, 5));
				console.warn(`[beemax] Telegram polling retry ${failures}: ${safeError(error)}`);
				if (delay) await wait(delay, signal);
			}
		}
	}

	private async dispatchUpdate(update: TelegramUpdate): Promise<void> {
		const message = update.message ?? update.edited_message ?? update.channel_post;
		if (!message || (!this.handler && !this.observationHandler)) return;
		const chatId = String(message.chat.id);
		const userId = message.from ? String(message.from.id) : undefined;
		const chatType = telegramChatType(message.chat.type);
		const threadId = message.message_thread_id !== undefined ? String(message.message_thread_id) : undefined;
		const signals = telegramActivationSignals(message, this.botId, this.botUsername);
		const media = telegramMedia(message);
		const text = (message.text ?? message.caption ?? (media ? `[Telegram ${media.messageType}]` : "")).trim();
		if (!text && !media) return;
		if (this.settings.allowedChats.length && !this.settings.allowedChats.includes(chatId)) return;
		const actorAuthorized = this.settings.allowAllUsers || Boolean(userId && this.settings.allowedUsers.includes(userId));
		const groupDecision = chatType === "dm" ? undefined : this.decideGroup({ chatId, userId, threadId, signals }, actorAuthorized);
		if (groupDecision && !groupDecision.admitted) return;
		if (!groupDecision && !actorAuthorized) return;
		const source = {
			platform: "telegram", chatId, chatType,
			...(message.chat.title ? { chatName: message.chat.title } : {}),
			...(threadId ? { threadId } : {}),
			...(userId ? { userId } : {}),
			...(message.from ? { userName: telegramUserName(message.from) } : {}),
			messageId: String(message.message_id),
		};
		if (groupDecision?.admitted && groupDecision.action === "observe") {
			if (text && this.observationHandler) await this.observationHandler({ text, source, timestamp: message.date * 1_000 });
			return;
		}
		if (!this.handler) return;
		const downloaded = media ? await this.downloadMedia(media) : undefined;
		const inbound: InboundMessage = {
			text,
			messageType: media?.messageType ?? (signals.command ? "command" : "text"),
			source,
			mediaPaths: downloaded ? [downloaded.path] : [],
			mediaTypes: downloaded ? [downloaded.mimeType] : [],
			releaseMedia: downloaded ? () => rm(downloaded.directory, { recursive: true, force: true }) : undefined,
			replyToMessageId: message.reply_to_message ? String(message.reply_to_message.message_id) : undefined,
			replyToText: message.reply_to_message?.text ?? message.reply_to_message?.caption,
			raw: update,
			timestamp: message.date * 1_000,
		};
		try { await this.handler(inbound); }
		catch (error) {
			await inbound.releaseMedia?.().catch(() => undefined);
			throw error;
		}
	}

	private async downloadMedia(media: TelegramMedia): Promise<{ path: string; mimeType: string; directory: string }> {
		if (media.fileSize && media.fileSize > this.settings.mediaMaxBytes) throw new Error(`Telegram media exceeds ${this.settings.mediaMaxBytes} byte limit`);
		const descriptor = await this.api<{ file_path: string; file_size?: number }>("getFile", { file_id: media.fileId });
		if (descriptor.file_size && descriptor.file_size > this.settings.mediaMaxBytes) throw new Error(`Telegram media exceeds ${this.settings.mediaMaxBytes} byte limit`);
		const response = await this.consumeCredentials((credentials) => this.fetchImpl(`${this.settings.apiBaseUrl}/file/bot${credentials.botToken}/${descriptor.file_path}`));
		if (!response) throw new Error("Telegram credentials are unavailable");
		if (!response.ok || !response.body) throw new Error(`Telegram media download failed: HTTP ${response.status}`);
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > this.settings.mediaMaxBytes) throw new Error(`Telegram media exceeds ${this.settings.mediaMaxBytes} byte limit`);
		const directory = await mkdtemp(join(tmpdir(), "beemax-telegram-"));
		const fileName = safeFileName(media.fileName ?? (basename(descriptor.file_path) || "attachment.bin"));
		const path = join(directory, fileName);
		let bytes = 0;
		const limiter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
			bytes += chunk.byteLength;
			callback(bytes > this.settings.mediaMaxBytes ? new Error(`Telegram media exceeds ${this.settings.mediaMaxBytes} byte limit`) : null, chunk);
		} });
		try {
			await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(path, { mode: 0o600 }));
			return { path, mimeType: media.mimeType ?? response.headers.get("content-type") ?? "application/octet-stream", directory };
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}

	private async api<T = unknown>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		const response = await this.consumeCredentials((credentials) => this.fetchImpl(`${this.settings.apiBaseUrl}/bot${credentials.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		}));
		if (!response) throw new Error("Telegram credentials are unavailable");
		const envelope = await response.json() as TelegramEnvelope<T>;
		if (!response.ok || !envelope.ok || envelope.result === undefined) {
			throw new Error(`Telegram ${method} failed${envelope.error_code ? ` (${envelope.error_code})` : ""}: ${envelope.description ?? `HTTP ${response.status}`}`);
		}
		return envelope.result;
	}

	private async sendMultipart(method: string, chatId: string, field: string, path: string, mimeType?: string, name?: string): Promise<SendResult> {
		const form = new FormData();
		form.set("chat_id", chatId);
		form.set(field, new Blob([await readFile(path)], { type: mimeType ?? "application/octet-stream" }), name ?? basename(path));
		const response = await this.consumeCredentials((credentials) => this.fetchImpl(`${this.settings.apiBaseUrl}/bot${credentials.botToken}/${method}`, { method: "POST", body: form }));
		if (!response) throw new Error("Telegram credentials are unavailable");
		const envelope = await response.json() as TelegramEnvelope<{ message_id: number }>;
		if (!response.ok || !envelope.ok || !envelope.result) throw new Error(`Telegram ${method} failed: ${envelope.description ?? `HTTP ${response.status}`}`);
		return { success: true, messageId: String(envelope.result.message_id) };
	}
}

function normalizeIds(values: string[]): string[] { return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))]; }
function telegramActivationSignals(message: TelegramMessage, botId?: number, botUsername?: string): Partial<Record<GroupActivationSignal, boolean>> {
	const text = message.text ?? message.caption ?? "";
	const entities = message.entities ?? message.caption_entities ?? [];
	const entityText = (entity: TelegramMessageEntity) => text.slice(entity.offset, entity.offset + entity.length);
	const normalizedBot = botUsername?.toLowerCase();
	const mention = Boolean(normalizedBot && entities.some((entity) => entity.type === "mention" && entityText(entity).toLowerCase() === `@${normalizedBot}`));
	const command = entities.some((entity) => {
		if (entity.type !== "bot_command" || entity.offset !== 0) return false;
		const target = entityText(entity).split("@")[1]?.toLowerCase();
		return !target || target === normalizedBot;
	});
	const reply = botId !== undefined && message.reply_to_message?.from?.id === botId;
	return { mention, command, reply };
}
interface TelegramMedia { fileId: string; fileSize?: number; fileName?: string; mimeType?: string; messageType: "image" | "audio" | "file"; }
function telegramMedia(message: TelegramMessage): TelegramMedia | undefined {
	if (message.photo?.length) {
		const photo = [...message.photo].sort((left, right) => (right.file_size ?? right.width * right.height) - (left.file_size ?? left.width * left.height))[0]!;
		return { fileId: photo.file_id, fileSize: photo.file_size, fileName: "image.jpg", mimeType: "image/jpeg", messageType: "image" };
	}
	if (message.document) return { fileId: message.document.file_id, fileSize: message.document.file_size, fileName: message.document.file_name, mimeType: message.document.mime_type, messageType: message.document.mime_type?.startsWith("image/") ? "image" : "file" };
	if (message.audio) return { fileId: message.audio.file_id, fileSize: message.audio.file_size, fileName: message.audio.file_name, mimeType: message.audio.mime_type ?? "audio/mpeg", messageType: "audio" };
	if (message.voice) return { fileId: message.voice.file_id, fileSize: message.voice.file_size, fileName: "voice.ogg", mimeType: message.voice.mime_type ?? "audio/ogg", messageType: "audio" };
	return undefined;
}
function safeFileName(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(-180) || "attachment.bin"; }
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value!))) : fallback;
}
function telegramChatType(type: TelegramChat["type"]): "dm" | "group" | "channel" { return type === "private" ? "dm" : type === "channel" ? "channel" : "group"; }
function telegramUserName(user: TelegramUser): string { return user.username ?? ([user.first_name, user.last_name].filter(Boolean).join(" ") || String(user.id)); }
function splitText(text: string, maxChars: number): string[] {
	const value = text || " ";
	const chunks: string[] = [];
	for (let offset = 0; offset < value.length; offset += maxChars) chunks.push(value.slice(offset, offset + maxChars));
	return chunks;
}
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }
function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}
async function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
	} finally { if (timer) clearTimeout(timer); }
}

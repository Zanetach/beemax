/**
 * Normalized platform-agnostic message types.
 *
 * Mirrors Hermes' MessageEvent / SessionSource / SendResult design but in
 * TypeScript for the BeeMax gateway. All platform adapters convert their
 * native events into these shapes so the dispatcher and session-router stay
 * platform-agnostic.
 */

/** A supported platform. Add entries here as new adapters land. */
export type PlatformName = "feishu" | "cli";

/** Where a message originated - used for routing and session keying. */
export interface SessionSource {
	platform: PlatformName;
	/** Chat / conversation id on the platform (Feishu chat_id, etc.) */
	chatId: string;
	chatName?: string;
	/** "dm" | "group" | "channel" | "thread" */
	chatType: "dm" | "group" | "channel" | "thread";
	/** The sender's stable user id (prefer union_id for Feishu, see adapter). */
	userId?: string;
	userName?: string;
	/** Optional secondary stable id (e.g. Feishu union_id alongside open_id). */
	userIdAlt?: string;
	/** For forum topics / Discord threads / etc. */
	threadId?: string;
	/** Original triggering message id (for reply / react / pin). */
	messageId?: string;
	/** True when the author is a bot/webhook. */
	isBot?: boolean;
}

export type MessageType = "text" | "image" | "audio" | "file" | "command";

/** A normalized inbound message produced by an adapter. */
export interface InboundMessage {
	/** Plaintext body. For Feishu rich posts this is the rendered text. */
	text: string;
	messageType: MessageType;
	source: SessionSource;
	/** Local file paths for media (downloaded by the adapter for tool/vision use). */
	mediaPaths: string[];
	mediaTypes: string[];
	/** Release adapter-owned temporary media after dispatch completes. */
	releaseMedia?: () => Promise<void>;
	/** Message id the reply should anchor to, if any. */
	replyToMessageId?: string;
	replyToText?: string;
	/** Original platform payload, kept for adapter-specific needs. */
	raw: unknown;
	/** Received timestamp (ms epoch). */
	timestamp: number;
}

/** Result of an outbound send. */
export interface SendResult {
	success: boolean;
	/** Platform message id of the sent message (for later edit). */
	messageId?: string;
	error?: string;
}

/** What a platform adapter must implement. */
export interface PlatformAdapter {
	readonly name: PlatformName;
	readonly isConnected: boolean;

	/** Establish connection (WS / webhook / etc.). Resolves true on success. */
	connect(): Promise<boolean>;

	/** Tear down all connections and background tasks. */
	disconnect(): Promise<void>;

	/**
	 * Register the handler that receives every normalized inbound message.
	 * Adapters must call this exactly once per inbound event.
	 */
	onMessage(handler: MessageHandler): void;

	/** Send a text/markdown message to a chat. Chunks as needed. */
	send(chatId: string, content: string, opts?: SendOptions): Promise<SendResult>;

	/** Send a local image as a native platform image message when supported. */
	sendImage?(chatId: string, imagePath: string): Promise<SendResult>;

	/** Edit a previously sent message (for streaming updates). */
	editMessage(chatId: string, messageId: string, content: string): Promise<SendResult>;

	/** Send an interactive card. Returns the message_id for later updates. */
	sendCard(chatId: string, card: Record<string, unknown>, replyTo?: string): Promise<SendResult>;

	/** Update a previously-sent interactive card in place (streaming). */
	updateCard(messageId: string, card: Record<string, unknown>): Promise<SendResult>;

	/** Send a "typing" / working indicator. */
	sendTyping(chatId: string): Promise<void>;

	/** Clear the "typing" indicator. */
	stopTyping(chatId: string): Promise<void>;
}

export type MessageHandler = (message: InboundMessage) => void | Promise<void>;

export interface SendOptions {
	replyTo?: string;
	/** If true, attempt to send as an interactive card (platform-specific). */
	asCard?: boolean;
}

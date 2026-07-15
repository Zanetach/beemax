/**
 * Normalized platform-agnostic Channel Runtime message types.
 *
 * Mirrors Hermes' MessageEvent / SessionSource / SendResult design but in
 * TypeScript for the BeeMax gateway. All platform adapters convert their
 * native events into these shapes so the dispatcher stays
 * platform-agnostic.
 */

import type { AgentScope } from "@beemax/core";
import type { InteractionPresenter } from "./presentation.ts";

/** Registry-validated adapter id. Core never enumerates transport platforms. */
export type PlatformName = string;

/** Where a message originated - used for routing and session keying. */
export interface SessionSource extends AgentScope {
	platform: PlatformName;
	/** Chat / conversation id on the platform (Feishu chat_id, etc.) */
	/** Original triggering message id (for reply / react / pin). */
	messageId?: string;
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

/** Content-only observe path. It cannot carry media, raw transport payloads, or execution grants. */
export interface InboundObservation {
	text: string;
	source: SessionSource;
	timestamp: number;
}

/** Result of an outbound send. */
export interface SendResult {
	success: boolean;
	/** Platform message id of the sent message (for later edit). */
	messageId?: string;
	error?: string;
}

/** A semantic action emitted by an interactive channel card. */
export interface PlatformCardAction {
	messageId: string;
	chatId: string;
	userId?: string;
	userIdAlt?: string;
	actionId: string;
	value: Record<string, unknown>;
}

export type CardActionHandler = (action: PlatformCardAction) => void | Promise<void>;

export interface PlatformCapabilities {
	mediaDelivery: "none" | "images" | "files";
	messageEditing: boolean;
	interactiveActions: boolean;
	richPresentation: boolean;
}

/** What a platform adapter must implement. */
export interface PlatformAdapter {
	readonly name: PlatformName;
	readonly isConnected: boolean;
	/** Explicit capability declaration; production callers never infer provider features from method names. */
	readonly capabilities: PlatformCapabilities;
	/** Optional rich presentation owned by this Adapter. Gateway provides text fallback when absent. */
	readonly presentation?: InteractionPresenter;

	/** Establish connection (WS / webhook / etc.). Resolves true on success. */
	connect(): Promise<boolean>;

	/** Tear down all connections and background tasks. */
	disconnect(): Promise<void>;

	/**
	 * Register the handler that receives every normalized inbound message.
	 * Adapters must call this exactly once per inbound event.
	 */
	onMessage(handler: MessageHandler): void;
	/** Optional isolated path for configured observe-only group content. */
	onObservation?(handler: ObservationHandler): void;
	/** Register interactive-card actions when the platform supports them. */
	onCardAction?(handler: CardActionHandler): void;

	/** Send a text/markdown message to a chat. Chunks as needed. */
	send(chatId: string, content: string, opts?: SendOptions): Promise<SendResult>;

	/** Send a local image as a native platform image message when supported. */
	sendImage?(chatId: string, imagePath: string): Promise<SendResult>;
	/** Send a local media/file artifact using the platform's native message type. */
	sendMedia?(chatId: string, mediaPath: string, mimeType?: string, name?: string): Promise<SendResult>;

	/** Edit a previously sent message (for streaming updates). */
	editMessage(chatId: string, messageId: string, content: string): Promise<SendResult>;

	/** Send a "typing" / working indicator for the triggering message. */
	sendTyping(chatId: string, messageId?: string): Promise<void>;

	/** Clear the working indicator and optionally mark the triggering message failed. */
	stopTyping(chatId: string, messageId?: string, failed?: boolean): Promise<void>;
}

export type MessageHandler = (message: InboundMessage) => void | Promise<void>;
export type ObservationHandler = (observation: InboundObservation) => void | Promise<void>;

export interface SendOptions {
	replyTo?: string;
	replyInThread?: boolean;
	idempotencyKey?: string;
}

/** A channel-neutral target. Core never imports a channel adapter or SDK. */
export interface DeliveryTarget {
	platform: string;
	/** Selects a concrete account/connection when a platform has multiple active instances. */
	channelInstanceId?: string;
	chatId: string;
	/** Trusted Conversation type captured at ingress. Missing only on legacy routes. */
	chatType?: "dm" | "group" | "channel" | "thread";
	userId?: string;
	threadId?: string;
}

export interface DeliveryOptions {
	idempotencyKey?: string;
	deliveryClass?: "interactive" | "proactive" | "control";
	deliveryAttempt?: number;
}

export class DeliveryDeferredError extends Error {
	readonly reason: "quiet_hours" | "reply_budget" | "unknown_conversation_type";
	readonly retryAt: number;
	constructor(reason: "quiet_hours" | "reply_budget" | "unknown_conversation_type", retryAt: number) {
		super(`Channel delivery deferred by ${reason}`);
		this.name = "DeliveryDeferredError";
		this.reason = reason;
		this.retryAt = retryAt;
	}
}

export interface MediaArtifact {
	path: string;
	mimeType?: string;
	name?: string;
}

/** Gateway-owned adapter for all outbound artifacts requested by Core. */
export interface DeliveryPort {
	sendText(target: DeliveryTarget, text: string, options?: DeliveryOptions): Promise<void>;
	sendMedia(target: DeliveryTarget, media: MediaArtifact, options?: DeliveryOptions): Promise<void>;
}

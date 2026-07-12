/** A channel-neutral target. Core never imports a channel adapter or SDK. */
export interface DeliveryTarget {
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
}

export interface MediaArtifact {
	path: string;
	mimeType?: string;
	name?: string;
}

/** Gateway-owned adapter for all outbound artifacts requested by Core. */
export interface DeliveryPort {
	sendText(target: DeliveryTarget, text: string, options?: { idempotencyKey?: string }): Promise<void>;
	sendMedia(target: DeliveryTarget, media: MediaArtifact): Promise<void>;
}

import type { DeliveryOptions, DeliveryPort, DeliveryReceipt, DeliveryTarget, MediaArtifact } from "@thruvera/core";
import { extname } from "node:path";
import type { ChannelAdapterResolver, PlatformAdapter } from "@thruvera/channel-runtime";

/** Concrete channel delivery adapter. It is the only layer that knows how a
 * Core artifact becomes a Feishu (or future channel) message. */
export class GatewayDeliveryPort implements DeliveryPort {
	private readonly resolver: ChannelAdapterResolver;

	constructor(platform: PlatformAdapter | ChannelAdapterResolver) {
		this.resolver = "resolveAdapter" in platform
			? platform
			: { resolveAdapter: (name) => {
				if (name !== platform.name) throw new Error(`Cannot deliver ${name} artifact through ${platform.name}`);
				return platform;
			} };
	}

	async sendText(target: DeliveryTarget, text: string, options?: DeliveryOptions): Promise<DeliveryReceipt> {
		const platform = this.resolver.resolveAdapter(target.platform, target.channelInstanceId);
		const result = await platform.send(target.chatId, text, {
			...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
			...(target.replyToMessageId ? { replyTo: target.replyToMessageId, replyInThread: Boolean(target.threadId) } : {}),
		});
		if (!result.success) throw new Error(result.error ?? "Channel text delivery failed");
		return { idempotencyKey: options?.idempotencyKey ?? `channel:${crypto.randomUUID()}`, deliveredAt: Date.now(), ...(result.messageId ? { providerMessageId: result.messageId } : {}) };
	}

	async sendMedia(target: DeliveryTarget, media: MediaArtifact, options?: DeliveryOptions): Promise<DeliveryReceipt> {
		const platform = this.resolver.resolveAdapter(target.platform, target.channelInstanceId);
		const declared = platform.capabilities.mediaDelivery;
		const result = declared === "files" && platform.sendMedia
			? await platform.sendMedia(target.chatId, media.path, media.mimeType, media.name)
			: declared === "images" && platform.sendImage && isImageArtifact(media)
				? await platform.sendImage(target.chatId, media.path)
				: undefined;
		if (!result) throw new Error(`${platform.name} does not support media delivery`);
		if (!result.success) throw new Error(result.error ?? "Channel media delivery failed");
		return { idempotencyKey: options?.idempotencyKey ?? `channel:${crypto.randomUUID()}`, deliveredAt: Date.now(), ...(result.messageId ? { providerMessageId: result.messageId } : {}) };
	}
}

function isImageArtifact(media: MediaArtifact): boolean {
	if (media.mimeType?.toLowerCase().startsWith("image/")) return true;
	return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".bmp", ".ico"].includes(extname(media.path).toLowerCase());
}

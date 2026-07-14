import type { DeliveryOptions, DeliveryPort, DeliveryTarget, MediaArtifact } from "@beemax/core";
import { extname } from "node:path";
import type { ChannelAdapterResolver, PlatformAdapter } from "@beemax/channel-runtime";

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

	async sendText(target: DeliveryTarget, text: string, options?: DeliveryOptions): Promise<void> {
		const platform = this.resolver.resolveAdapter(target.platform, target.channelInstanceId);
		const result = await platform.send(target.chatId, text, { idempotencyKey: options?.idempotencyKey });
		if (!result.success) throw new Error(result.error ?? "Channel text delivery failed");
	}

	async sendMedia(target: DeliveryTarget, media: MediaArtifact, _options?: DeliveryOptions): Promise<void> {
		const platform = this.resolver.resolveAdapter(target.platform, target.channelInstanceId);
		const declared = platform.capabilities?.mediaDelivery;
		const result = (declared === "files" || declared === undefined) && platform.sendMedia
			? await platform.sendMedia(target.chatId, media.path, media.mimeType, media.name)
			: (declared === "images" || declared === undefined) && platform.sendImage && isImageArtifact(media)
				? await platform.sendImage(target.chatId, media.path)
				: undefined;
		if (!result) throw new Error(`${platform.name} does not support media delivery`);
		if (!result.success) throw new Error(result.error ?? "Channel media delivery failed");
	}
}

function isImageArtifact(media: MediaArtifact): boolean {
	if (media.mimeType?.toLowerCase().startsWith("image/")) return true;
	return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".bmp", ".ico"].includes(extname(media.path).toLowerCase());
}

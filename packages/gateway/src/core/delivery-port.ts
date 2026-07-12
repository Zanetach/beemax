import type { DeliveryPort, DeliveryTarget, MediaArtifact } from "@beemax/core";
import { extname } from "node:path";
import type { PlatformAdapter } from "./types.ts";

/** Concrete channel delivery adapter. It is the only layer that knows how a
 * Core artifact becomes a Feishu (or future channel) message. */
export class GatewayDeliveryPort implements DeliveryPort {
	private readonly platform: PlatformAdapter;

	constructor(platform: PlatformAdapter) { this.platform = platform; }

	async sendText(target: DeliveryTarget, text: string, options?: { idempotencyKey?: string }): Promise<void> {
		this.assertPlatform(target);
		const result = await this.platform.send(target.chatId, text, { idempotencyKey: options?.idempotencyKey });
		if (!result.success) throw new Error(result.error ?? "Channel text delivery failed");
	}

	async sendMedia(target: DeliveryTarget, media: MediaArtifact): Promise<void> {
		this.assertPlatform(target);
		const result = this.platform.sendMedia
			? await this.platform.sendMedia(target.chatId, media.path, media.mimeType, media.name)
			: this.platform.sendImage && isImageArtifact(media)
				? await this.platform.sendImage(target.chatId, media.path)
				: undefined;
		if (!result) throw new Error(`${this.platform.name} does not support media delivery`);
		if (!result.success) throw new Error(result.error ?? "Channel media delivery failed");
	}

	private assertPlatform(target: DeliveryTarget): void {
		if (target.platform !== this.platform.name) throw new Error(`Cannot deliver ${target.platform} artifact through ${this.platform.name}`);
	}
}

function isImageArtifact(media: MediaArtifact): boolean {
	if (media.mimeType?.toLowerCase().startsWith("image/")) return true;
	return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".bmp", ".ico"].includes(extname(media.path).toLowerCase());
}

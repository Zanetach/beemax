import type { DeliveryPort, DeliveryTarget, MediaArtifact } from "@beemax/core";
import type { PlatformAdapter } from "./types.ts";

/** Concrete channel delivery adapter. It is the only layer that knows how a
 * Core artifact becomes a Feishu (or future channel) message. */
export class GatewayDeliveryPort implements DeliveryPort {
	private readonly platform: PlatformAdapter;

	constructor(platform: PlatformAdapter) { this.platform = platform; }

	async sendText(target: DeliveryTarget, text: string): Promise<void> {
		this.assertPlatform(target);
		const result = await this.platform.send(target.chatId, text);
		if (!result.success) throw new Error(result.error ?? "Channel text delivery failed");
	}

	async sendMedia(target: DeliveryTarget, media: MediaArtifact): Promise<void> {
		this.assertPlatform(target);
		if (!this.platform.sendImage) throw new Error(`${this.platform.name} does not support image delivery`);
		const result = await this.platform.sendImage(target.chatId, media.path);
		if (!result.success) throw new Error(result.error ?? "Channel media delivery failed");
	}

	private assertPlatform(target: DeliveryTarget): void {
		if (target.platform !== this.platform.name) throw new Error(`Cannot deliver ${target.platform} artifact through ${this.platform.name}`);
	}
}

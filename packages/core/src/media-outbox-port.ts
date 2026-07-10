import type { BeeMaxRuntimeSource } from "./runtime.ts";

/**
 * Core-owned port for durable outbound media work. Capability adapters may
 * enqueue artifacts here, while a Gateway implementation performs channel
 * upload and acknowledgement separately.
 */
export interface MediaOutboxPort {
	enqueueMedia(owner: BeeMaxRuntimeSource, media: { path: string; mimeType?: string }): Promise<void>;
}

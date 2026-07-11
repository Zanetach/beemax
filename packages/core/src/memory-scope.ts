import type { BeeMaxRuntimeSource } from "./runtime.ts";

/** Canonical ownership boundary for all personal-memory operations. */
export interface MemoryScope {
	platform: string;
	chatId: string;
	userId?: string;
}

export function memoryScopeForSource(source: BeeMaxRuntimeSource): MemoryScope {
	return { platform: source.platform, chatId: source.chatId, userId: source.userIdAlt ?? source.userId };
}

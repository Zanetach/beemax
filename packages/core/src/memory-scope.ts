import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { conversationIdentity } from "./agent-scope.ts";

/** Canonical ownership boundary for all personal-memory operations. */
export interface MemoryScope {
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
}

export function memoryScopeForSource(source: BeeMaxRuntimeSource): MemoryScope {
	const { platform, chatId, userId, threadId } = conversationIdentity(source);
	return { platform, chatId, userId, threadId };
}

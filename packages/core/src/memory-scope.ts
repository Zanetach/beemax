import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { conversationIdentity } from "./agent-scope.ts";

/** Canonical ownership boundary for all personal-memory operations. */
export interface MemoryScope {
	profileId?: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	projectId?: string;
	organizationId?: string;
}

export function memoryScopeForSource(source: BeeMaxRuntimeSource, trusted: Pick<MemoryScope, "profileId" | "projectId" | "organizationId"> = {}): MemoryScope {
	const { platform, chatId, userId, threadId } = conversationIdentity(source);
	return { ...trusted, platform, chatId, userId, threadId };
}

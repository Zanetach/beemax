import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { conversationIdentity } from "./agent-scope.ts";

/**
 * Core Memory ownership scope. Legacy subject/object selectors remain private
 * to the Memory Store migration interface and never enter Agent execution.
 */
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

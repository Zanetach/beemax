import type { ThruveraRuntimeSource } from "./runtime.ts";
import { conversationIdentity } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";

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
	/** Disclosure surface. Private claims are eligible only in direct messages. */
	chatType?: AgentScope["chatType"];
	projectId?: string;
	organizationId?: string;
}

export function memoryScopeForSource(source: ThruveraRuntimeSource, trusted: Pick<MemoryScope, "profileId" | "projectId" | "organizationId"> = {}): MemoryScope {
	const { platform, channelInstanceId, chatId, userId, threadId } = conversationIdentity(source);
	const memoryPlatform = channelInstanceId ? `${platform}@${channelInstanceId}` : platform;
	return {
		...trusted,
		platform: memoryPlatform,
		chatId,
		...(source.chatType === "dm" && userId ? { userId } : {}),
		...(threadId ? { threadId } : {}),
		chatType: source.chatType,
	};
}

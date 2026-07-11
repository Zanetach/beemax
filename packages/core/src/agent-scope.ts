/** Channel-independent source identity understood by the Agent runtime. */
export interface AgentScope {
	platform: string;
	chatId: string;
	chatType: "dm" | "group" | "channel" | "thread";
	chatName?: string;
	userId?: string;
	/** Cross-application identity, preferred when a channel exposes one. */
	userIdAlt?: string;
	userName?: string;
	threadId?: string;
	isBot?: boolean;
	/** Internal execution binding for a delegated Task; never accepted from a transport payload. */
	delegatedTask?: { id: string; ownerKey: string };
}

/** Canonical, transport-free identity used to derive scoped runtime views. */
export interface ConversationIdentity {
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
}

export function canonicalUserId(source: Pick<AgentScope, "userId" | "userIdAlt">): string | undefined {
	return source.userIdAlt ?? source.userId;
}

export function conversationIdentity(source: AgentScope): ConversationIdentity {
	return {
		platform: source.platform,
		chatId: source.chatId,
		userId: canonicalUserId(source),
		threadId: source.threadId,
	};
}

/** Stable identity for a channel conversation, excluding a particular thread. */
export function conversationOwnerKey(source: AgentScope): string {
	return `${source.platform}:${source.chatId}:${canonicalUserId(source) ?? "anon"}`;
}

/** Stable per-conversation identity including an optional thread. */
export function conversationKey(source: AgentScope): string {
	const chat = source.threadId ? `${source.chatId}#${source.threadId}` : source.chatId;
	return `${source.platform}:${chat}:${canonicalUserId(source) ?? "anon"}`;
}

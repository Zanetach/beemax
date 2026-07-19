/** Channel-independent source identity understood by the Agent runtime. */
export interface AgentScope {
	platform: string;
	/** Stable configured channel account/connection. Required when one platform has multiple active instances. */
	channelInstanceId?: string;
	chatId: string;
	chatType: "dm" | "group" | "channel" | "thread";
	chatName?: string;
	userId?: string;
	/** Cross-application identity, preferred when a channel exposes one. */
	userIdAlt?: string;
	userName?: string;
	threadId?: string;
	/** Trusted ingress message anchor retained for idempotent interactive completion and thread replies. */
	originMessageId?: string;
	/** Adapter-selected provider message anchor for an exact thread reply. */
	replyToMessageId?: string;
	isBot?: boolean;
	/** Internal execution binding for a delegated Task; never accepted from a transport payload. */
	delegatedTask?: { id: string; ownerKey: string };
}

/** Canonical, transport-free identity used to derive scoped runtime views. */
export interface ConversationIdentity {
	platform: string;
	channelInstanceId?: string;
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
		...(source.channelInstanceId ? { channelInstanceId: source.channelInstanceId } : {}),
		chatId: source.chatId,
		userId: canonicalUserId(source),
		threadId: source.threadId,
	};
}

/** Stable identity for a channel conversation, excluding a particular thread. */
export function conversationOwnerKey(source: AgentScope): string {
	const conversation = `${channelAddress(source)}:${source.chatId}`;
	return source.chatType === "dm" ? `${conversation}:${canonicalUserId(source) ?? "anon"}` : conversation;
}

/** Stable per-conversation identity including an optional thread. */
export function conversationKey(source: AgentScope): string {
	const chat = source.threadId ? `${source.chatId}#${source.threadId}` : source.chatId;
	const conversation = `${channelAddress(source)}:${chat}`;
	return source.chatType === "dm" ? `${conversation}:${canonicalUserId(source) ?? "anon"}` : conversation;
}

/** Durable responsibility follows only an explicitly trusted cross-application identity. */
export function responsibilityOwnerKey(source: AgentScope): string {
	if (source.userIdAlt) return `user:${source.userIdAlt}`;
	if (source.userId) return `${channelAddress(source)}:${source.chatId}:${source.userId}`;
	return conversationOwnerKey(source);
}

/** Current responsibility identity followed by legacy channel identities for additive migration reads. */
export function responsibilityOwnerKeys(source: AgentScope): string[] {
	const legacyActor = canonicalUserId(source) ?? "anon";
	const legacyChat = source.threadId ? `${source.chatId}#${source.threadId}` : source.chatId;
	return [...new Set([
		responsibilityOwnerKey(source),
		conversationKey(source),
		conversationOwnerKey(source),
		...(source.channelInstanceId ? [
			source.userIdAlt ? `user:${source.userIdAlt}` : `${source.platform}:${source.chatId}:${legacyActor}`,
			`${source.platform}:${legacyChat}:${legacyActor}`,
			...(source.chatType === "dm" ? [] : [`${source.platform}:${legacyChat}`, `${source.platform}:${source.chatId}`]),
		] : []),
	])];
}

function channelAddress(source: Pick<AgentScope, "platform" | "channelInstanceId">): string {
	return source.channelInstanceId ? `${source.platform}@${source.channelInstanceId}` : source.platform;
}

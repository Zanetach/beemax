/**
 * Maps a platform source to a stable Pi session id.
 *
 * Identity isolation:
 * - chat id separates different DMs/groups
 * - thread id separates Feishu topic threads
 * - stable user identity separates participants inside the same group
 * - Feishu union_id is preferred over app-scoped open_id
 */

import { createHash, randomUUID } from "node:crypto";
import type { SessionSource } from "./types.ts";

/** Composite routing key used by both the in-memory dispatcher and JSONL ids. */
export function sessionKeyForSource(source: SessionSource): string {
	const userPart = source.userIdAlt ?? source.userId ?? "anon";
	const chatPart = source.threadId ? `${source.chatId}#${source.threadId}` : source.chatId;
	return `${source.platform}:${chatPart}:${userPart}`;
}

/**
 * Derive a deterministic, Pi-valid session id from the routing key.
 * SHA-256 is truncated to 128 bits and formatted as a UUID-shaped identifier.
 */
export function sessionIdForSource(source: SessionSource): string {
	const hex = createHash("sha256").update(sessionKeyForSource(source)).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function ephemeralSessionId(): string {
	return randomUUID();
}

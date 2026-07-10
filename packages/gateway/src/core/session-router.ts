/**
 * Maps a platform source to a stable Pi session id.
 *
 * Identity isolation:
 * - chat id separates different DMs/groups
 * - thread id separates Feishu topic threads
 * - stable user identity separates participants inside the same group
 * - Feishu union_id is preferred over app-scoped open_id
 */

import { randomUUID } from "node:crypto";
export { sessionIdForSource, sessionKeyForSource } from "@beemax/core";

export function ephemeralSessionId(): string {
	return randomUUID();
}

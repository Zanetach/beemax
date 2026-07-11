import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Returns only newly streamed assistant text.
 *
 * `message_update.message.content` is a cumulative snapshot, so writing it on
 * every update repeats the response in a terminal. Pi supplies the append-only
 * `text_delta` event specifically for streaming renderers.
 */
export function localChatTextDelta(event: AgentSessionEvent): string | undefined {
	if (event.type !== "message_update" || event.message.role !== "assistant") return undefined;
	return event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta : undefined;
}

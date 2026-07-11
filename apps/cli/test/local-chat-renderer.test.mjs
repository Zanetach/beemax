import assert from "node:assert/strict";
import test from "node:test";
import { localChatTextDelta } from "../dist/local-chat-renderer.js";

test("local chat writes append-only text deltas instead of cumulative message snapshots", () => {
	const event = (delta, text) => ({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text }] },
		assistantMessageEvent: { type: "text_delta", delta },
	});

	assert.equal(localChatTextDelta(event("Hello", "Hello")), "Hello");
	assert.equal(localChatTextDelta(event(" world", "Hello world")), " world");
	assert.equal(localChatTextDelta({
		type: "message_update",
		message: { role: "assistant", content: [] },
		assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
	}), undefined);
});

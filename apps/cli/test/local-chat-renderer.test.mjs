import assert from "node:assert/strict";
import test from "node:test";
import { LocalReasoningPresenter, localChatTextDelta, localChatThinkingDelta, parseReasoningCommand } from "../dist/local-chat-renderer.js";

test("local chat writes append-only text deltas instead of cumulative message snapshots", () => {
	const event = (delta, text) => ({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text }] },
		assistantMessageEvent: { type: "text_delta", delta },
	});

	assert.equal(localChatTextDelta(event("Hello", "Hello")), "Hello");
	assert.equal(localChatTextDelta(event(" world", "Hello world")), " world");
	const thinkingEvent = {
		type: "message_update",
		message: { role: "assistant", content: [] },
		assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
	};
	assert.equal(localChatTextDelta(thinkingEvent), undefined);
	assert.equal(localChatThinkingDelta(thinkingEvent), "reasoning");
});

test("reasoning visibility keeps raw thought separate and makes summaries opt-in", () => {
	const off = new LocalReasoningPresenter("off");
	assert.equal(off.thinking("hidden"), "");
	assert.equal(off.beforeAnswer(), "");

	const summary = new LocalReasoningPresenter("summary");
	assert.equal(summary.thinking("first"), "\n思考中…");
	assert.equal(summary.thinking("second"), "");
	assert.equal(summary.beforeAnswer(), "\r\x1b[2K");

	const pipedSummary = new LocalReasoningPresenter("summary", false);
	assert.equal(pipedSummary.thinking("hidden"), "");
	assert.equal(pipedSummary.beforeAnswer(), "");

	const raw = new LocalReasoningPresenter("raw");
	assert.equal(raw.thinking("first"), "\n思考：\nfirst");
	assert.equal(raw.thinking("second"), "second");
	assert.equal(raw.beforeAnswer(), "\n\n");
	assert.equal(raw.thinking("late reasoning"), "");
});

test("reasoning commands follow the session visibility pattern", () => {
	assert.deepEqual(parseReasoningCommand("/reasoning"), { kind: "status" });
	assert.deepEqual(parseReasoningCommand("/reason raw"), { kind: "set", display: "raw" });
	assert.deepEqual(parseReasoningCommand("/reasoning hidden"), { kind: "invalid" });
	assert.equal(parseReasoningCommand("hello"), undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import { InteractionRuntime, reduceInteractionEvent } from "../dist/index.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("interaction runtime translates a turn into presenter-safe semantic events", async () => {
	const runtime = {
		async run(_input, sink) {
			await sink({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read" });
			await sink({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hello" } });
			return { answer: "hello", model: "test/model", durationMs: 1, usage: {} };
		},
		async cancel() { return true; },
		async modelStatus() { return { model: "test/model", thinkingLevel: "off", supportedThinkingLevels: ["off"] }; },
		async usage() { return undefined; },
	};
	const interaction = new InteractionRuntime(runtime);
	const events = [];
	await interaction.dispatch({ type: "message.send", source, text: "hi", input: { timeoutMs: 1_000 } }, (event) => { events.push(event); });
	assert.deepEqual(events.map((event) => event.type), ["turn.started", "tool.changed", "answer.delta", "turn.finished"]);
	assert.equal((await interaction.snapshot(source)).phase, "completed");
});

test("interaction reducer preserves a cancelled turn state", () => {
	const snapshot = reduceInteractionEvent({ phase: "running", turnId: "turn-1", updatedAt: 1 }, { type: "turn.cancelled", turnId: "turn-1", at: 2 });
	assert.equal(snapshot.phase, "cancelled");
});

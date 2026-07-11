import test from "node:test";
import assert from "node:assert/strict";
import { InteractionEventAdapter, reduceInteractionEvent } from "../dist/index.js";

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
	const interaction = new InteractionEventAdapter(runtime);
	const events = [];
	await interaction.dispatch({ type: "message.send", source, text: "hi", input: { timeoutMs: 1_000 } }, (event) => { events.push(event); });
	assert.deepEqual(events.map((event) => event.type), ["turn.started", "tool.changed", "answer.delta", "turn.finished"]);
	assert.equal((await interaction.snapshot(source)).phase, "completed");
});

test("interaction reducer preserves a cancelled turn state", () => {
	const snapshot = reduceInteractionEvent({ phase: "running", turnId: "turn-1", updatedAt: 1 }, { type: "turn.cancelled", turnId: "turn-1", at: 2 });
	assert.equal(snapshot.phase, "cancelled");
});

test("cancelling a running turn produces a semantic cancellation instead of a failure", async () => {
	let rejectTurn;
	const runtime = {
		run() { return new Promise((_resolve, reject) => { rejectTurn = reject; }); },
		async cancel() { rejectTurn(new Error("aborted")); return true; },
		async modelStatus() { return undefined; },
		async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const events = [];
	const turn = interaction.dispatch({ type: "message.send", source, text: "hi", input: { timeoutMs: 1_000 } }, (event) => { events.push(event); });
	await new Promise((resolve) => setImmediate(resolve));
	await interaction.dispatch({ type: "turn.cancel", source });
	await assert.rejects(turn, /aborted/);
	assert.deepEqual(events.map((event) => event.type), ["turn.started", "turn.cancelled"]);
	assert.equal((await interaction.snapshot(source)).phase, "cancelled");
});

test("approval lifecycle is available to presentation without exposing broker internals", async () => {
	let resolveTurn;
	const runtime = {
		run() { return new Promise((resolve) => { resolveTurn = resolve; }); },
		async cancel() { return false; },
		async modelStatus() { return undefined; },
		async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const events = [];
	const turn = interaction.dispatch({ type: "message.send", source, text: "hi", input: { timeoutMs: 1_000 } }, (event) => { events.push(event); });
	await new Promise((resolve) => setImmediate(resolve));
	await interaction.approvalRequested(source, "write");
	assert.equal((await interaction.snapshot(source)).phase, "awaiting_approval");
	await interaction.approvalResolved(source, "write", true);
	resolveTurn({ answer: "ok", model: "test/model", durationMs: 1, usage: {} });
	await turn;
	assert.deepEqual(events.map((event) => event.type), ["turn.started", "approval.requested", "approval.resolved", "turn.finished"]);
});

test("asynchronous presentation events stay ordered and surface a renderer failure", async () => {
	let releaseFirst;
	const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
	const runtime = {
		async run(_input, sink) {
			void sink({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "first" } });
			void sink({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "second" } });
			return { answer: "firstsecond", model: "test/model", durationMs: 1, usage: {} };
		},
		async cancel() { return false; },
		async modelStatus() { return undefined; },
		async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const order = [];
	const turn = interaction.dispatch({ type: "message.send", source, text: "hi", input: { timeoutMs: 1_000 } }, async (event) => {
		if (event.type !== "answer.delta") return;
		order.push(`${event.text}:start`);
		if (event.text === "first") await firstGate;
		order.push(`${event.text}:end`);
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(order, ["first:start"]);
	releaseFirst();
	await turn;
	assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);

	const failed = new InteractionEventAdapter(runtime);
	await assert.rejects(
		failed.dispatch({ type: "message.send", source: { ...source, threadId: "broken" }, text: "hi", input: { timeoutMs: 1_000 } }, async (event) => {
			if (event.type === "answer.delta") throw new Error("renderer failed");
		}),
		/renderer failed/,
	);
});

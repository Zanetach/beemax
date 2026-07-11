import test from "node:test";
import assert from "node:assert/strict";
import { InteractionEventAdapter, reduceInteractionEvent } from "../dist/index.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("interaction runtime translates a turn into presenter-safe semantic events", async () => {
	const runtime = {
		async run(_input, sink) {
			await sink({ type: "model_fallback", from: "primary", to: "fallback", attempt: 1 });
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
	assert.deepEqual(events.map((event) => event.type), ["turn.started", "model.fallback", "tool.changed", "answer.delta", "turn.finished"]);
	assert.deepEqual({ type: events[1].type, from: events[1].from, to: events[1].to, attempt: events[1].attempt }, { type: "model.fallback", from: "primary", to: "fallback", attempt: 1 });
	assert.equal(events.every((event) => event.sessionId && event.scope.platform === "cli" && event.turnId && event.at > 0 && event.sequence > 0), true);
	assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
	assert.deepEqual(interaction.events(source, 2).map((event) => event.type), ["tool.changed", "answer.delta", "turn.finished"]);
	assert.equal((await interaction.snapshot(source)).phase, "completed");
});

test("interaction runtime supports a reconnecting presenter subscription", async () => {
	const runtime = {
		async run(_input, sink) { await sink({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hello" } }); return { answer: "hello", model: "test/model", durationMs: 1, usage: {} }; },
		async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const received = [];
	const unsubscribe = interaction.subscribe(source, (event) => { received.push(event.type); });
	await interaction.dispatch({ type: "message.send", source, text: "hi", input: { timeoutMs: 1_000 } });
	unsubscribe();
	assert.deepEqual(received, ["turn.started", "answer.delta", "turn.finished"]);
});

test("action IDs make retried controls and concurrent requests idempotent per session", async () => {
	let runs = 0;
	const runtime = {
		async run() { runs++; return { answer: "ok", model: "test/model", durationMs: 1, usage: {} }; },
		async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const action = { type: "message.send", source, text: "hi", input: { timeoutMs: 1_000 }, actionId: "retry-safe-1" };
	const [first, retry] = await Promise.all([interaction.dispatch(action), interaction.dispatch(action)]);
	assert.equal(runs, 1);
	assert.deepEqual(first, retry);
	await interaction.dispatch({ ...action, actionId: "retry-safe-2" });
	assert.equal(runs, 2);
});

test("session opening is a Core interaction action for every presenter", async () => {
	let opens = 0;
	const runtime = {
		async run() { return { answer: "ok", model: "test/model", durationMs: 1, usage: {} }; },
		async open() { opens++; return true; }, async listSavedSessions() { return []; }, async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	assert.deepEqual(await interaction.dispatch({ type: "session.open", source, actionId: "open-1" }), { opened: true });
	assert.deepEqual(await interaction.dispatch({ type: "session.open", source, actionId: "open-1" }), { opened: true });
	assert.equal(opens, 1);
});

test("session reset is likewise a Core action and remains retry-safe", async () => {
	let resets = 0;
	const runtime = {
		async run() { return { answer: "ok", model: "test/model", durationMs: 1, usage: {} }; },
		reset() { resets++; return true; }, async open() { return true; }, async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	assert.deepEqual(await interaction.dispatch({ type: "session.reset", source, actionId: "reset-1" }), { reset: true });
	assert.deepEqual(await interaction.dispatch({ type: "session.reset", source, actionId: "reset-1" }), { reset: true });
	assert.equal(resets, 1);
});

test("session compaction is a Core action for all presenters", async () => {
	let compactions = 0;
	const runtime = {
		async run() { return { answer: "ok", model: "test/model", durationMs: 1, usage: {} }; },
		async compact() { compactions++; return true; }, async open() { return true; }, reset() { return false; }, async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	assert.deepEqual(await interaction.dispatch({ type: "session.compact", source, actionId: "compact-1" }), { compacted: true });
	assert.equal(compactions, 1);
});

test("interaction telemetry is operational-only and does not contain model content", async () => {
	const telemetry = [];
	const runtime = {
		async run(_input, sink) { await sink({ type: "model_fallback", from: "primary", to: "fallback", attempt: 1 }); await sink({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "private answer" } }); return { answer: "private answer", model: "test/model", durationMs: 1, usage: {} }; },
		async cancel() { return false; }, async modelStatus() { return { model: "test/model", thinkingLevel: "off", supportedThinkingLevels: ["off"] }; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime, { telemetry: (event) => telemetry.push(event) });
	await interaction.dispatch({ type: "message.send", source, text: "private prompt", input: { timeoutMs: 1_000 } });
	interaction.events(source, 1);
	assert.deepEqual(telemetry, [
		{ type: "interaction.turn_started", surface: "cli", model: "test/model", session: telemetry[0].session },
		{ type: "interaction.model_fallback", surface: "cli", from: "primary", to: "fallback", attempt: 1 },
		{ type: "interaction.presenter_reconnected", surface: "cli", gapEvents: 3 },
	]);
	assert.match(telemetry[0].session, /^default:/);
	assert.doesNotMatch(JSON.stringify(telemetry), /private/);
});

test("approval and queue telemetry includes required latency fields without content", async () => {
	let rejectTurn;
	const telemetry = [];
	const runtime = {
		run() { return new Promise((_resolve, reject) => { rejectTurn = reject; }); },
		async cancel() { rejectTurn(new Error("aborted")); return true; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime, { telemetry: (event) => telemetry.push(event) });
	const turn = interaction.dispatch({ type: "message.send", source, text: "private prompt", input: { timeoutMs: 1_000 } });
	await new Promise((resolve) => setImmediate(resolve));
	await interaction.approvalRequested(source, "write", { target: "secret.txt", risk: "高", impact: "private", reversibility: "private", argsSummary: "private" });
	await interaction.approvalResolved(source, "write", false);
	await interaction.dispatch({ type: "turn.queue", source, text: "private queued text" });
	await interaction.dispatch({ type: "turn.cancel", source });
	await assert.rejects(turn, /aborted/);
	const resolved = telemetry.find((event) => event.type === "interaction.approval_resolved");
	const queued = telemetry.find((event) => event.type === "interaction.input_queued");
	assert.equal(typeof resolved.latency, "number");
	assert.equal(typeof queued.waitMs, "number");
	assert.doesNotMatch(JSON.stringify(telemetry), /secret|private/);
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
	let approvalCancelled = 0;
	let childCancelled = 0;
	const interaction = new InteractionEventAdapter(runtime, {
		approvalBroker: { cancel: () => (approvalCancelled++, true) },
		cancelSubagents: () => (childCancelled++, 2),
	});
	const events = [];
	const turn = interaction.dispatch({ type: "message.send", source, text: "hi", input: { timeoutMs: 1_000 } }, (event) => { events.push(event); });
	await new Promise((resolve) => setImmediate(resolve));
	const cancellation = await interaction.dispatch({ type: "turn.cancel", source });
	assert.deepEqual(cancellation, { cancelled: true, approvalCancelled: true, subagentsCancelled: 2, errors: [], queuedCancelled: false });
	assert.equal(approvalCancelled, 1);
	assert.equal(childCancelled, 1);
	await assert.rejects(turn, /aborted/);
	assert.deepEqual(events.map((event) => event.type), ["turn.started", "turn.cancelled"]);
	assert.equal((await interaction.snapshot(source)).phase, "cancelled");
});

test("interaction runtime owns a one-entry queue and clears it on cancellation", async () => {
	let rejectTurn;
	const runtime = {
		run() { return new Promise((_resolve, reject) => { rejectTurn = reject; }); },
		async cancel() { rejectTurn(new Error("aborted")); return true; },
		async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const turn = interaction.dispatch({ type: "message.send", source, text: "first", input: { timeoutMs: 1_000 } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(await interaction.dispatch({ type: "turn.queue", source, text: "second" }), { queued: true, position: 1, replaced: false, mode: "queue" });
	assert.equal((await interaction.snapshot(source)).phase, "queued");
	assert.deepEqual(await interaction.dispatch({ type: "turn.queue", source, text: "replacement" }), { queued: true, position: 1, replaced: true, mode: "queue" });
	assert.equal((await interaction.snapshot(source)).queueDepth, 1);
	const cancelled = await interaction.dispatch({ type: "turn.cancel", source });
	assert.equal(cancelled.queuedCancelled, true);
	assert.equal(interaction.takeQueuedInput(source), undefined);
	await assert.rejects(turn, /aborted/);
});

test("steer and follow-up use native runtime delivery when available", async () => {
	let rejectTurn;
	const delivered = [];
	const runtime = {
		run() { return new Promise((_resolve, reject) => { rejectTurn = reject; }); },
		async steer(_source, text) { delivered.push(["steer", text]); return true; },
		async followUp(_source, text) { delivered.push(["follow_up", text]); return true; },
		async cancel() { rejectTurn(new Error("aborted")); return true; },
		async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const turn = interaction.dispatch({ type: "message.send", source, text: "first", input: { timeoutMs: 1_000 } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(await interaction.dispatch({ type: "turn.steer", source, text: "focus on tests" }), { queued: true, position: 1, replaced: false, mode: "steer" });
	assert.equal((await interaction.snapshot(source)).phase, "running");
	assert.deepEqual(await interaction.dispatch({ type: "turn.queue", source, text: "then summarize" }), { queued: true, position: 1, replaced: false, mode: "follow_up" });
	assert.equal((await interaction.snapshot(source)).queueDepth, 1);
	assert.deepEqual(delivered, [["steer", "focus on tests"], ["follow_up", "then summarize"]]);
	assert.equal(interaction.takeQueuedInput(source), undefined, "native Pi queues must not be replayed by the presenter");
	assert.equal((await interaction.dispatch({ type: "turn.cancel", source })).queuedCancelled, true);
	await assert.rejects(turn, /aborted/);
});

test("steer is an explicit, honest queue fallback for legacy runtimes", async () => {
	let rejectTurn;
	const runtime = {
		run() { return new Promise((_resolve, reject) => { rejectTurn = reject; }); },
		async cancel() { rejectTurn(new Error("aborted")); return true; },
		async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const turn = interaction.dispatch({ type: "message.send", source, text: "first", input: { timeoutMs: 1_000 } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(await interaction.dispatch({ type: "turn.steer", source, text: "focus on tests" }), { queued: true, position: 1, replaced: false, mode: "steer_fallback" });
	assert.equal(interaction.events(source).at(-1).mode, "steer_fallback");
	await interaction.dispatch({ type: "turn.cancel", source });
	await assert.rejects(turn, /aborted/);
});

test("native delivery failures surface instead of being misreported as unsupported", async () => {
	let rejectTurn;
	const runtime = {
		run() { return new Promise((_resolve, reject) => { rejectTurn = reject; }); },
		async steer() { throw new Error("native steer failed"); },
		async cancel() { rejectTurn(new Error("aborted")); return true; },
		async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const turn = interaction.dispatch({ type: "message.send", source, text: "first", input: { timeoutMs: 1_000 } });
	await new Promise((resolve) => setImmediate(resolve));
	await assert.rejects(interaction.dispatch({ type: "turn.steer", source, text: "focus" }), /native steer failed/);
	assert.equal(interaction.takeQueuedInput(source), undefined);
	await interaction.dispatch({ type: "turn.cancel", source });
	await assert.rejects(turn, /aborted/);
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

test("approval decisions are Core actions, not presenter-specific reply parsing", async () => {
	let resolveTurn;
	const runtime = {
		run() { return new Promise((resolve) => { resolveTurn = resolve; }); },
		async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	let decision;
	const interaction = new InteractionEventAdapter(runtime, { approvalBroker: { decide: async (_source, choice) => (decision = choice, true) } });
	const turn = interaction.dispatch({ type: "message.send", source, text: "hi", input: { timeoutMs: 1_000 } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(await interaction.dispatch({ type: "approval.decide", source, choice: "session" }), { handled: true });
	assert.equal(decision, "session");
	resolveTurn({ answer: "ok", model: "test/model", durationMs: 1, usage: {} });
	await turn;
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

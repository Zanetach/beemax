import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileInteractionInputQueueStore, InteractionEventAdapter, reduceInteractionEvent } from "../dist/index.js";

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

test("interaction runtime settles a rejected Agent turn instead of remaining running", async () => {
	const runtime = {
		async run() { throw new Error("Task Plan quality rejected"); },
		async cancel() { return false; },
		async modelStatus() { return undefined; },
		async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	await assert.rejects(interaction.dispatch({ type: "message.send", source, text: "plan work", input: { timeoutMs: 1_000 } }), /Task Plan quality rejected/);
	assert.equal((await interaction.snapshot(source)).phase, "failed");
});

test("interaction runtime bounds execution grants to one turn", async () => {
	const lifecycle = [];
	const approvalBroker = {
		beginTask(_source, taskId) { lifecycle.push(["begin", taskId]); },
		endTask(_source, taskId) { lifecycle.push(["end", taskId]); return true; },
		subscribe() { return () => undefined; },
	};
	const runtime = {
		async run() { return { answer: "ok", model: "test/model", durationMs: 1, usage: {} }; },
		async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime, { approvalBroker });
	await interaction.dispatch({ type: "message.send", source, text: "first", input: { timeoutMs: 1_000 } });
	await interaction.dispatch({ type: "message.send", source, text: "second", input: { timeoutMs: 1_000 } });
	assert.deepEqual(lifecycle.map(([phase]) => phase), ["begin", "end", "begin", "end"]);
	assert.notEqual(lifecycle[0][1], lifecycle[2][1]);
	assert.equal(lifecycle[0][1], lifecycle[1][1]);
	assert.equal(lifecycle[2][1], lifecycle[3][1]);
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

test("interaction runtime evicts inactive conversation state at a global bound", async () => {
	const runtime = {
		async run() { return { answer: "ok", model: "test/model", durationMs: 1, usage: {} }; },
		async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime, { maxTrackedInteractions: 2, eventHistoryLimit: 20 });
	const sources = ["one", "two", "three"].map((chatId) => ({ platform: "cli", chatId, chatType: "dm", userId: "user" }));
	for (const item of sources) await interaction.dispatch({ type: "message.send", source: item, text: "hi", input: { timeoutMs: 1_000 } });
	assert.deepEqual(interaction.events(sources[0]), []);
	assert.equal((await interaction.snapshot(sources[0])).phase, "idle");
	assert.equal((await interaction.snapshot(sources[2])).phase, "completed");
});

test("interaction runtime emits channel-neutral progress for Sub-Agents and asynchronous Task Plans", async () => {
	const runtime = {
		async run(_input, sink) {
			await sink({ type: "tool_execution_start", toolCallId: "sub-1", toolName: "task_spawn" });
			await sink({ type: "tool_execution_end", toolCallId: "sub-1", toolName: "task_spawn", isError: false, result: { details: { id: "task-1" } } });
			await sink({ type: "tool_execution_start", toolCallId: "plan-1", toolName: "task_plan_execute" });
			await sink({ type: "tool_execution_end", toolCallId: "plan-1", toolName: "task_plan_execute", isError: false, result: { details: { planId: "plan-42", status: "running" } } });
			return { answer: "accepted", model: "test/model", durationMs: 1, usage: {} };
		},
		async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const events = [];
	await interaction.dispatch({ type: "message.send", source, text: "parallel work", input: { timeoutMs: 1_000 } }, (event) => { if (event.type === "work.changed") events.push(event); });
	assert.deepEqual(events.map(({ kind, state, summary }) => ({ kind, state, summary })), [
		{ kind: "subagent", state: "running", summary: "task-1 · 后台运行中" },
		{ kind: "task_plan", state: "running", summary: "plan-42 · 后台运行中" },
	]);
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

test("planning telemetry records only operational routing fields", async () => {
	const telemetry = [];
	const runtime = {
		async run(_input, sink) {
			await sink({ type: "planning_decision", mode: "dag", concurrency: 3, maxSubagents: 4, requiredTools: ["task_plan_execute"] });
			await sink({ type: "planning_outcome", mode: "dag", compliant: true, corrected: true });
			return { answer: "private answer", model: "test/model", durationMs: 1, usage: {} };
		},
		async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const adapter = new InteractionEventAdapter(runtime, { telemetry: (event) => telemetry.push(event) });
	await adapter.dispatch({ type: "message.send", source, text: "private prompt", input: { timeoutMs: 1_000 } });
	assert.deepEqual(telemetry.filter((event) => event.type === "interaction.planning_selected"), [{ type: "interaction.planning_selected", surface: "cli", mode: "dag", concurrency: 3, maxSubagents: 4, requiredToolCount: 1 }]);
	assert.deepEqual(telemetry.filter((event) => event.type === "interaction.planning_completed"), [{ type: "interaction.planning_completed", surface: "cli", mode: "dag", compliant: true, corrected: true }]);
	assert.doesNotMatch(JSON.stringify(telemetry), /private prompt|private answer/);
});

test("capability ranking crosses the Interaction boundary as content-free metadata", async () => {
	const telemetry = [];
	const runtime = {
		async run(_input, sink) { await sink({ type: "capability_ranked", candidates: [{ kind: "mcp", name: "mcp_calendar_find", score: 60, confidence: 0.6, reason: "trigger" }], activatedTools: ["mcp_calendar_find"] }); return { answer: "done", model: "test/model", durationMs: 1, usage: {} }; },
		async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const adapter = new InteractionEventAdapter(runtime, { telemetry: (event) => telemetry.push(event) });
	await adapter.dispatch({ type: "message.send", source, text: "private prompt", input: { timeoutMs: 1_000 } });
	assert.equal(adapter.events(source).some((event) => event.type === "capability.ranked" && event.candidates[0]?.name === "mcp_calendar_find"), true);
	assert.deepEqual(telemetry.filter((event) => event.type === "interaction.capability_ranked"), [{ type: "interaction.capability_ranked", surface: "cli", candidateCount: 1, activatedToolCount: 1, toolCandidateCount: 0, mcpCandidateCount: 1, skillCandidateCount: 0 }]);
	assert.doesNotMatch(JSON.stringify(telemetry), /private prompt/);
});

test("media understanding crosses the Interaction seam without image bytes or extracted content", async () => {
	const telemetry = [];
	const runtime = {
		async run(_input, sink) { await sink({ type: "media_understood", route: "adapter", adapterIds: ["local-ocr:tesseract"], receiptCount: 1, failureCount: 0, durationMs: 12 }); return { answer: "done", model: "test/model", durationMs: 13, usage: {} }; },
		async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const adapter = new InteractionEventAdapter(runtime, { telemetry: (event) => telemetry.push(event) });
	await adapter.dispatch({ type: "message.send", source, text: "private prompt", input: { timeoutMs: 1_000 } });
	assert.equal(adapter.events(source).some((event) => event.type === "media.understood" && event.adapterIds[0] === "local-ocr:tesseract"), true);
	assert.deepEqual(telemetry.filter((event) => event.type === "interaction.media_understood"), [{ type: "interaction.media_understood", surface: "cli", route: "adapter", adapterCount: 1, receiptCount: 1, failureCount: 0, durationMs: 12 }]);
	assert.doesNotMatch(JSON.stringify(telemetry), /private prompt|image.data|extracted/);
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
	let plansCancelled = 0;
	const interaction = new InteractionEventAdapter(runtime, {
		approvalBroker: { cancel: () => (approvalCancelled++, true) },
		cancelSubagents: () => (childCancelled++, 2),
		cancelTaskPlans: () => (plansCancelled++, 1),
	});
	const events = [];
	const turn = interaction.dispatch({ type: "message.send", source, text: "hi", input: { timeoutMs: 1_000 } }, (event) => { events.push(event); });
	await new Promise((resolve) => setImmediate(resolve));
	const cancellation = await interaction.dispatch({ type: "turn.cancel", source });
	assert.deepEqual(cancellation, { cancelled: true, approvalCancelled: true, subagentsCancelled: 2, taskPlansCancelled: 1, errors: [], queuedCancelled: false });
	assert.equal(approvalCancelled, 1);
	assert.equal(childCancelled, 1);
	assert.equal(plansCancelled, 1);
	await assert.rejects(turn, /aborted/);
	assert.deepEqual(events.map((event) => event.type), ["turn.started", "turn.cancelled"]);
	assert.equal((await interaction.snapshot(source)).phase, "cancelled");
});

test("interaction runtime preserves an ordered bounded queue and clears it on cancellation", async () => {
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
	assert.deepEqual(await interaction.dispatch({ type: "turn.queue", source, text: "third" }), { queued: true, position: 2, replaced: false, mode: "queue" });
	assert.equal((await interaction.snapshot(source)).queueDepth, 2);
	const cancelled = await interaction.dispatch({ type: "turn.cancel", source });
	assert.equal(cancelled.queuedCancelled, true);
	assert.equal(interaction.takeQueuedInput(source), undefined);
	await assert.rejects(turn, /aborted/);
});

test("fallback conversation inputs survive an Agent process restart in FIFO order", async () => {
	const directory = await mkdtemp(join(tmpdir(), "beemax-input-queue-"));
	try {
		const path = join(directory, "queue.json");
		const runtime = {
			run() { return new Promise(() => undefined); },
			async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
		};
		const first = new InteractionEventAdapter(runtime, { inputQueueStore: new FileInteractionInputQueueStore(path) });
		void first.dispatch({ type: "message.send", source, text: "first", input: { timeoutMs: 1_000 } });
		await new Promise((resolve) => setImmediate(resolve));
		await first.dispatch({ type: "turn.queue", source, text: "second" });
		await first.dispatch({ type: "turn.queue", source, text: "third" });

		const restarted = new InteractionEventAdapter(runtime, { inputQueueStore: new FileInteractionInputQueueStore(path) });
		assert.equal(restarted.takeQueuedInput(source), "second");
		assert.equal(restarted.takeQueuedInput(source), "third");
		assert.equal(restarted.takeQueuedInput(source), undefined);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("native follow-up is acknowledged on success but survives a process crash before turn completion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "beemax-native-queue-"));
	try {
		const path = join(directory, "queue.json");
		const pendingRuntime = {
			run() { return new Promise(() => undefined); }, async followUp() { return true; },
			async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
		};
		const crashed = new InteractionEventAdapter(pendingRuntime, { inputQueueStore: new FileInteractionInputQueueStore(path) });
		void crashed.dispatch({ type: "message.send", source, text: "first", input: { timeoutMs: 1_000 } });
		await new Promise((resolve) => setImmediate(resolve));
		await crashed.dispatch({ type: "turn.queue", source, text: "native follow-up" });
		const restarted = new InteractionEventAdapter(pendingRuntime, { inputQueueStore: new FileInteractionInputQueueStore(path) });
		assert.equal(restarted.takeQueuedInput(source), "native follow-up");

		let finish;
		const completingRuntime = { ...pendingRuntime, run: () => new Promise((resolve) => { finish = resolve; }) };
		const completed = new InteractionEventAdapter(completingRuntime, { inputQueueStore: new FileInteractionInputQueueStore(path) });
		const turn = completed.dispatch({ type: "message.send", source, text: "next", input: { timeoutMs: 1_000 } });
		await new Promise((resolve) => setImmediate(resolve));
		await completed.dispatch({ type: "turn.queue", source, text: "processed natively" });
		finish({ answer: "ok", model: "test", durationMs: 1, usage: {} });
		await turn;
		assert.equal(new FileInteractionInputQueueStore(path).all().length, 0);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("primary input is atomically leased before admission and acknowledged on terminal completion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "beemax-primary-queue-"));
	try {
		const path = join(directory, "queue.json");
		let finish;
		const runtime = {
			run: () => new Promise((resolve) => { finish = resolve; }), async cancel() { return false; },
			async modelStatus() { return undefined; }, async usage() { return undefined; },
		};
		const interaction = new InteractionEventAdapter(runtime, { inputQueueStore: new FileInteractionInputQueueStore(path) });
		const primary = interaction.reservePrimaryInput(source, "primary");
		assert.ok(primary?.claimToken);
		assert.equal(new FileInteractionInputQueueStore(path).claim("cli").length, 0, "another process cannot claim an admitted primary");
		const turn = interaction.dispatch({ type: "message.send", source, text: "primary", input: { timeoutMs: 1_000 } });
		await new Promise((resolve) => setImmediate(resolve));
		finish({ answer: "ok", model: "test", durationMs: 1, usage: {} });
		await turn;
		assert.equal(new FileInteractionInputQueueStore(path).all().length, 0);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("file input queue merges independent process views and fails closed on corruption", async () => {
	const directory = await mkdtemp(join(tmpdir(), "beemax-queue-lock-"));
	try {
		const path = join(directory, "queue.json");
		const first = new FileInteractionInputQueueStore(path);
		const second = new FileInteractionInputQueueStore(path);
		assert.equal(first.enqueue({ id: "one", key: "a", text: "first", source, createdAt: 1 }), 1);
		assert.equal(second.enqueue({ id: "two", key: "b", text: "second", source, createdAt: 2 }), 1);
		assert.equal(second.enqueue({ id: "three", key: "a", text: "third", source, createdAt: 3 }), 2);
		assert.deepEqual(first.all().map((input) => input.id), ["one", "two", "three"]);
		const claims = first.claim("cli");
		assert.deepEqual(claims.map((input) => input.id), ["one", "two"]);
		assert.equal(second.claim("cli").length, 0);
		assert.equal(second.claimKey("a"), undefined, "an active head lease blocks later inputs in the same conversation");
		assert.equal(second.acknowledge(claims[0].key, claims[0].id, "wrong"), false);
		assert.equal(second.acknowledge(claims[0].key, claims[0].id, claims[0].claimToken), true);
		assert.equal(second.claimKey("a")?.id, "three");
		await writeFile(path, JSON.stringify({ "cli:local:local": ["legacy"] }), "utf8");
		assert.equal(new FileInteractionInputQueueStore(path).all()[0].text, "legacy");
		await writeFile(path, "not-json", "utf8");
		assert.throws(() => new FileInteractionInputQueueStore(path), /queue is corrupt|JSON/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("fallback conversation queue applies explicit backpressure after 100 inputs", async () => {
	let rejectTurn;
	const runtime = {
		run() { return new Promise((_resolve, reject) => { rejectTurn = reject; }); },
		async cancel() { rejectTurn(new Error("aborted")); return true; },
		async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const turn = interaction.dispatch({ type: "message.send", source, text: "first", input: { timeoutMs: 1_000 } });
	await new Promise((resolve) => setImmediate(resolve));
	for (let index = 0; index < 100; index++) {
		assert.deepEqual(await interaction.dispatch({ type: "turn.queue", source, text: `queued-${index}` }), { queued: true, position: index + 1, replaced: false, mode: "queue" });
	}
	assert.deepEqual(await interaction.dispatch({ type: "turn.queue", source, text: "overflow" }), { queued: false, position: 100, replaced: false, mode: "queue" });
	assert.equal((await interaction.snapshot(source)).queueDepth, 100);
	await interaction.dispatch({ type: "turn.cancel", source });
	await assert.rejects(turn, /aborted/);
});

test("file conversation queue bounds total Profile records and serialized bytes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "beemax-input-queue-bounds-"));
	const path = join(directory, "queue.json");
	try {
		const store = new FileInteractionInputQueueStore(path, { maxRecords: 2, maxBytes: 1_000 });
		assert.equal(store.enqueue({ id: "one", key: "a", text: "first", source, createdAt: 1 }), 1);
		assert.equal(store.enqueue({ id: "two", key: "b", text: "second", source, createdAt: 2 }), 1);
		assert.equal(store.enqueue({ id: "three", key: "c", text: "third", source, createdAt: 3 }), 0);
		assert.equal(store.all().length, 2);
		assert.throws(() => new FileInteractionInputQueueStore(path, { maxRecords: 1 }), /record limit/);
		const bytesPath = join(directory, "bytes.json");
		const byteBounded = new FileInteractionInputQueueStore(bytesPath, { maxRecords: 10, maxBytes: 300 });
		assert.throws(() => byteBounded.enqueue({ id: "large", key: "large", text: "x".repeat(1_000), source, createdAt: 1 }), /byte limit/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("steer and follow-up use native runtime delivery when available", async () => {
	let rejectTurn;
	const delivered = [];
	const runtime = {
		run() { return new Promise((_resolve, reject) => { rejectTurn = reject; }); },
		async steer(_source, text, images) { delivered.push(["steer", text, images]); return true; },
		async followUp(_source, text, images) { delivered.push(["follow_up", text, images]); return true; },
		async cancel() { rejectTurn(new Error("aborted")); return true; },
		async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const interaction = new InteractionEventAdapter(runtime);
	const turn = interaction.dispatch({ type: "message.send", source, text: "first", input: { timeoutMs: 1_000 } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(await interaction.dispatch({ type: "turn.steer", source, text: "focus on tests" }), { queued: true, position: 1, replaced: false, mode: "steer" });
	assert.equal((await interaction.snapshot(source)).phase, "running");
	const images = [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
	assert.deepEqual(await interaction.dispatch({ type: "turn.queue", source, text: "then summarize", images }), { queued: true, position: 2, replaced: false, mode: "follow_up" });
	assert.equal((await interaction.snapshot(source)).queueDepth, 2);
	assert.deepEqual(delivered, [["steer", "focus on tests", undefined], ["follow_up", "then summarize", images]]);
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
	assert.equal(interaction.takeQueuedInput(source), "focus", "a native delivery failure remains recoverable instead of losing input");
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

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentFactory } from "../../../apps/cli/dist/agent-factory.js";
import { Dispatcher } from "../dist/core/dispatcher.js";
import { GatewayIngressController, MessageDeduplicator, ProfileBindingResolver } from "../dist/index.js";
import { createArtifactManifest, createSubagentTools, ProfileTaskScheduler, SubagentManager } from "@beemax/core";
import { FeishuInteractionPresenter } from "@beemax/channel-feishu";

const source = { platform: "feishu", chatId: "chat-1", chatType: "dm", userId: "user-1" };

function enableFeishuPresentation(platform) {
	platform.presentation = new FeishuInteractionPresenter(platform);
	return platform;
}

test("Dispatcher binds inbound interactions to the configured channel instance", async () => {
	let inbound;
	let receivedSource;
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const runtime = {
		run: async ({ source }) => { receivedSource = source; return { answer: "ok", model: "test", durationMs: 1, usage: {} }; },
		cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined,
	};
	const dispatcher = new Dispatcher({ runtime, channelInstanceId: "company-a", flushIntervalMs: 0 }, platform);
	await inbound({ text: "hello", messageType: "text", source: { ...source, messageId: "instance-bound" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	for (let attempt = 0; !receivedSource && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.equal(receivedSource.channelInstanceId, "company-a");
	await dispatcher.dispose();
});

test("Dispatcher fails closed when Profile Binding selects another Profile", async () => {
	let inbound; let runs = 0; let released = 0;
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const runtime = { run: async () => { runs++; return { answer: "wrong", model: "test", durationMs: 1, usage: {} }; }, cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined };
	const bindingResolver = new ProfileBindingResolver([{ id: "finance", profileId: "finance", channelInstanceId: "company-a" }]);
	const dispatcher = new Dispatcher({ runtime, profileId: "sales", channelInstanceId: "company-a", bindingResolver, flushIntervalMs: 0 }, platform);
	await inbound({ text: "hello", messageType: "text", source: { ...source, messageId: "wrong-profile" }, mediaPaths: [], mediaTypes: [], releaseMedia: async () => { released++; }, raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(runs, 0);
	assert.equal(released, 1);
	await dispatcher.dispose();
});

test("Dispatcher rejects new work at the Profile ingress high-water mark but always admits emergency stop", async () => {
	let inbound; let finish; let runs = 0; let cancels = 0; const texts = [];
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async (_chatId, text) => { texts.push(text); return { success: true }; }, editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const runtime = { run: async () => { runs++; return new Promise((resolve) => { finish = () => resolve({ answer: "done", model: "test", durationMs: 1, usage: {} }); }); }, cancel: async () => { cancels++; return true; }, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined };
	const ingress = new GatewayIngressController({ maxActive: 1, maxActivePerConversation: 1 });
	const dispatcher = new Dispatcher({ runtime, ingress, flushIntervalMs: 0 }, platform);
	await inbound({ text: "first", messageType: "text", source: { ...source, messageId: "capacity-1" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	for (let attempt = 0; runs === 0 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
	await inbound({ text: "second", messageType: "text", source: { ...source, chatId: "chat-2", messageId: "capacity-2" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	assert.equal(runs, 1);
	assert.ok(texts.some((text) => /容量已满/.test(text)));
	await inbound({ text: "/stop", messageType: "command", source: { ...source, messageId: "capacity-stop" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	assert.equal(cancels, 1);
	finish(); await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(ingress.snapshot().active, 0);
	await dispatcher.dispose();
});

test("Dispatcher applies per-conversation ingress limits independently to group threads", async () => {
	let inbound; const conversationKeys = [];
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const runtime = { run: async () => ({ answer: "done", model: "test", durationMs: 1, usage: {} }), cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined };
	const ingress = { tryAcquire: (key) => { conversationKeys.push(key); return () => undefined; } };
	const dispatcher = new Dispatcher({ runtime, ingress, flushIntervalMs: 0 }, platform);
	const groupSource = { ...source, chatType: "group", userId: "member-1" };
	await inbound({ text: "first", messageType: "text", source: { ...groupSource, threadId: "topic-1", messageId: "thread-1" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await inbound({ text: "second", messageType: "text", source: { ...groupSource, threadId: "topic-2", messageId: "thread-2" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	assert.deepEqual(conversationKeys, ["feishu:chat-1#topic-1", "feishu:chat-1#topic-2"]);
	await dispatcher.dispose();
});

test("Dispatcher publishes the initial progress card before starting a slow Agent Turn", async () => {
	let inbound; let finish; const order = [];
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		sendCard: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); order.push("card"); return { success: true, messageId: "progress-card" }; }, updateCard: async () => ({ success: true }),
	};
	enableFeishuPresentation(platform);
	const runtime = {
		run: async () => { order.push("runtime"); return new Promise((resolve) => { finish = resolve; }); },
		cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined,
	};
	const dispatcher = new Dispatcher({ runtime, flushIntervalMs: 800 }, platform);
	const turn = inbound({ text: "slow request", messageType: "text", source: { ...source, messageId: "slow-request" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	for (let attempt = 0; order.length < 2 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(order.slice(0, 2), ["card", "runtime"]);
	finish({ answer: "done", model: "test", durationMs: 1, usage: {} }); await turn; dispatcher.dispose();
});

test("Dispatcher starts the Agent Turn when initial card delivery hangs", async () => {
	let inbound; let runtimeStarted = false;
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		sendCard: async () => new Promise(() => undefined), updateCard: async () => ({ success: true }),
	};
	enableFeishuPresentation(platform);
	const runtime = { run: async () => { runtimeStarted = true; return { answer: "done", model: "test", durationMs: 1, usage: {} }; }, cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined };
	const dispatcher = new Dispatcher({ runtime, flushIntervalMs: 0, presentationTimeoutMs: 20 }, platform);
	const turn = inbound({ text: "request", messageType: "text", source: { ...source, messageId: "hung-card" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setTimeout(resolve, 60)); assert.equal(runtimeStarted, true);
	await Promise.race([turn, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Turn remained blocked behind hung card delivery")), 500))]);
	dispatcher.dispose();
});

test("Dispatcher adopts a late initial card result instead of creating duplicate cards", async () => {
	let inbound; let sends = 0; let updates = 0;
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		sendCard: async () => { sends++; await new Promise((resolve) => setTimeout(resolve, 60)); return { success: true, messageId: "late-card" }; },
		updateCard: async (id) => { assert.equal(id, "late-card"); updates++; return { success: true }; },
	};
	enableFeishuPresentation(platform);
	const runtime = { run: async () => { await new Promise((resolve) => setTimeout(resolve, 90)); return { answer: "done", model: "test", durationMs: 90, usage: {} }; }, cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined };
	const dispatcher = new Dispatcher({ runtime, flushIntervalMs: 0, presentationTimeoutMs: 20 }, platform);
	await inbound({ text: "request", messageType: "text", source: { ...source, messageId: "late-card-request" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setTimeout(resolve, 180));
	assert.equal(sends, 1); assert.ok(updates >= 1); dispatcher.dispose();
});

test("Dispatcher coalesces the terminal card snapshot without a redundant repaint", async () => {
	let inbound; const updates = [];
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		sendCard: async () => ({ success: true, messageId: "card" }),
		updateCard: async (_id, card) => { if (!updates.length) await new Promise((resolve) => setTimeout(resolve, 60)); updates.push(JSON.stringify(card)); return { success: true }; },
	};
	enableFeishuPresentation(platform);
	const runtime = { run: async () => ({ answer: "latest final answer", model: "test", durationMs: 1, usage: {} }), cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined };
	const dispatcher = new Dispatcher({ runtime, flushIntervalMs: 0, presentationTimeoutMs: 20 }, platform);
	await inbound({ text: "request", messageType: "text", source: { ...source, messageId: "late-update" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setTimeout(resolve, 160));
	assert.equal(updates.length, 1); assert.match(updates[0], /latest final answer/); dispatcher.dispose();
});

test("Dispatcher falls back to final text when card updates remain unavailable", async () => {
	let inbound; const texts = [];
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async (_chatId, text) => { texts.push(text); return { success: true }; }, editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		sendCard: async () => ({ success: true, messageId: "card" }), updateCard: async () => new Promise(() => undefined),
	};
	enableFeishuPresentation(platform);
	const runtime = { run: async () => ({ answer: "recoverable final answer", model: "test", durationMs: 1, usage: {} }), cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined };
	const dispatcher = new Dispatcher({ runtime, flushIntervalMs: 0, presentationTimeoutMs: 20 }, platform);
	await inbound({ text: "request", messageType: "text", source: { ...source, messageId: "hung-update" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(texts.includes("recoverable final answer")); dispatcher.dispose();
});

test("Dispatcher degrades cleanly to final text when a channel has no card capability", async () => {
	let inbound; const texts = [];
	const platform = {
		name: "telegram", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async (_chatId, text) => { texts.push(text); return { success: true }; }, editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const runtime = { run: async () => ({ answer: "portable final answer", model: "test", durationMs: 1, usage: {} }), cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined };
	const dispatcher = new Dispatcher({ runtime, flushIntervalMs: 0 }, platform);
	await inbound({ text: "request", messageType: "text", source: { ...source, platform: "telegram", messageId: "plain-text" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	for (let attempt = 0; !texts.includes("portable final answer") && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.ok(texts.includes("portable final answer"));
	await dispatcher.dispose();
});

test("Dispatcher ignores legacy approval events on text-only channels", async () => {
	let inbound; let finishTurn; const texts = [];
	const telegramSource = { ...source, platform: "telegram", messageId: "approval-text" };
	const platform = {
		name: "telegram", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async (_chatId, text) => { texts.push(text); return { success: true }; }, editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const interaction = {
		dispatch: async (_action, sink) => {
			await sink({ type: "approval.requested", sessionId: "session", scope: telegramSource, turnId: "turn", at: 1, sequence: 1, toolName: "browser_submit", details: { target: "example.com", risk: "中", impact: "提交表单", reversibility: "不可逆" } });
			return new Promise((resolve) => { finishTurn = async () => {
				const result = { answer: "done", model: "test", durationMs: 1, usage: {} };
				await sink({ type: "turn.finished", sessionId: "session", scope: telegramSource, turnId: "turn", at: 2, sequence: 2, result });
				resolve(result);
			}; });
		},
		snapshot: async () => ({ phase: "idle", updatedAt: Date.now() }),
		reservePrimaryInput: (source, text) => ({ id: "primary", key: "key", source, text, createdAt: 1 }), peekQueuedInput: () => undefined, claimQueuedInput: () => undefined,
	};
	const dispatcher = new Dispatcher({ runtime: { isBusy: () => false, handleControl: async () => undefined }, interaction, flushIntervalMs: 0 }, platform);
	const turn = inbound({ text: "submit", messageType: "text", source: telegramSource, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(texts.some((text) => /等待审批|回复 1|browser_submit/.test(text)), false);
	await finishTurn();
	await turn;
	await dispatcher.dispose();
});

test("Dispatcher falls back to error text when a failed Turn cannot update its card", async () => {
	let inbound; const texts = [];
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async (_chatId, text) => { texts.push(text); return { success: true }; }, editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		sendCard: async () => ({ success: true, messageId: "card" }), updateCard: async () => new Promise(() => undefined),
	};
	enableFeishuPresentation(platform);
	const runtime = { run: async () => { throw new Error("model unavailable"); }, cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined };
	const dispatcher = new Dispatcher({ runtime, flushIntervalMs: 0, presentationTimeoutMs: 20 }, platform);
	await inbound({ text: "request", messageType: "text", source: { ...source, messageId: "hung-error-update" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(texts.includes("❌ model unavailable")); dispatcher.dispose();
});

test("Gateway idempotency is profile-scoped, bounded, and expires", () => {
	const guard = new MessageDeduplicator({ ttlMs: 1_000, maxEntries: 100 });
	assert.equal(guard.accept("sales", "feishu", "event-1", 0), true);
	assert.equal(guard.accept("sales", "feishu", "event-1", 1), false);
	assert.equal(guard.accept("support", "feishu", "event-1", 1), true);
	guard.rollback("support", "feishu", "event-1");
	assert.equal(guard.accept("support", "feishu", "event-1", 2), true);
	assert.equal(guard.accept("sales", "feishu", "event-1", 1_001), true);
	assert.equal(guard.accept("sales", "feishu", undefined, 1_001), true);
});

test("Sub-Agent manager queues above concurrency, preserves ownership, and returns results", async () => {
	let running = 0;
	let maxRunning = 0;
	const releases = [];
	const manager = new SubagentManager({
		maxConcurrent: 2,
		maxChildrenPerOwner: 5,
		execute: async (task) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((resolve) => releases.push(resolve));
			running--;
			return `done:${task.goal}`;
		},
	});
	const tasks = ["one", "two", "three"].map((goal) => manager.spawn(source, { goal }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(manager.get(source, tasks[0].id).status, "running");
	assert.equal(manager.get(source, tasks[1].id).status, "running");
	assert.equal(manager.get(source, tasks[2].id).status, "queued");
	assert.equal(maxRunning, 2);

	releases.shift()();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(manager.get(source, tasks[2].id).status, "running");
	while (releases.length) releases.shift()();
	const result = await manager.wait(source, tasks[2].id, 1000);
	assert.equal(result.status, "completed");
	assert.equal(result.result, "done:three");
	assert.equal(manager.list(source).find((task) => task.id === tasks[2].id).result, undefined);
	assert.throws(() => manager.get({ ...source, chatId: "other" }, tasks[0].id), /not found/);
	await manager.dispose();
});

test("Sub-Agent manager leaves Profile admission to the fair shared scheduler", async () => {
	const scheduler = new ProfileTaskScheduler({ maxConcurrent: 1 });
	const starts = [];
	const releases = [];
	const manager = new SubagentManager({
		maxConcurrent: 1,
		maxChildrenPerOwner: 5,
		admit: (ownerKey, work, signal) => scheduler.run(ownerKey, work, signal),
		execute: async (task) => {
			starts.push(task.goal);
			await new Promise((resolve) => releases.push(resolve));
			return `done:${task.goal}`;
		},
	});
	const sourceB = { ...source, chatId: "chat-2" };
	const a1 = manager.spawn(source, { goal: "a1" });
	const a2 = manager.spawn(source, { goal: "a2" });
	const b1 = manager.spawn(sourceB, { goal: "b1" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(starts, ["a1"]);
	assert.equal(manager.get(source, a2.id).status, "queued");
	releases.shift()();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(starts, ["a1", "b1"]);
	assert.equal(manager.get(sourceB, b1.id).status, "running");
	releases.shift()();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(starts, ["a1", "b1", "a2"]);
	releases.shift()();
	await Promise.all([manager.wait(source, a1.id), manager.wait(source, a2.id), manager.wait(sourceB, b1.id)]);
	await manager.dispose();
});

test("Sub-Agent cancellation removes work waiting for Profile admission", async () => {
	const scheduler = new ProfileTaskScheduler({ maxConcurrent: 1 });
	let release;
	const manager = new SubagentManager({
		admit: (ownerKey, work, signal) => scheduler.run(ownerKey, work, signal),
		execute: async (task) => task.goal === "active" ? new Promise((resolve) => { release = () => resolve("done"); }) : "must-not-run",
	});
	const active = manager.spawn(source, { goal: "active" });
	const queued = manager.spawn({ ...source, chatId: "chat-2" }, { goal: "queued" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(scheduler.snapshot().queued, 1);
	assert.equal(manager.cancel({ ...source, chatId: "chat-2" }, queued.id).status, "cancelled");
	assert.equal(scheduler.snapshot().queued, 0);
	release();
	assert.equal((await manager.wait(source, active.id)).status, "completed");
	await manager.dispose();
});

test("Sub-Agent cancellation handles queued and running work and cascades by owner", async () => {
	const manager = new SubagentManager({
		maxConcurrent: 1,
		execute: async (_task, signal) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}),
	});
	const running = manager.spawn(source, { goal: "running" });
	const queued = manager.spawn(source, { goal: "queued" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(manager.cancel(source, queued.id).status, "cancelled");
	assert.equal(manager.cancelOwner(source), 1);
	assert.equal((await manager.wait(source, running.id, 1000)).status, "cancelled");
	await manager.dispose();
});

test("Sub-Agent manager waits for running work to stop during disposal", { timeout: 1000 }, async () => {
	let observeAbort;
	let finishCleanup;
	const abortObserved = new Promise((resolve) => { observeAbort = resolve; });
	const cleanupFinished = new Promise((resolve) => { finishCleanup = resolve; });
	const manager = new SubagentManager({
		execute: async (_task, signal) => {
			await new Promise((resolve) => signal.addEventListener("abort", () => {
				observeAbort();
				resolve();
			}, { once: true }));
			await cleanupFinished;
			return "done";
		},
	});
	manager.spawn(source, { goal: "running" });
	await new Promise((resolve) => setImmediate(resolve));

	let disposed = false;
	const disposal = Promise.resolve(manager.dispose()).then(() => { disposed = true; });
	await abortObserved;
	await new Promise((resolve) => setImmediate(resolve));
	try {
		assert.equal(disposed, false);
	} finally {
		finishCleanup();
		await disposal;
	}
	assert.equal(disposed, true);
});

test("Sub-Agent manager enforces the active-child limit", async () => {
	const manager = new SubagentManager({ maxConcurrent: 1, maxChildrenPerOwner: 2, execute: async () => "done" });
	manager.spawn(source, { goal: "one" });
	manager.spawn(source, { goal: "two" });
	assert.throws(() => manager.spawn(source, { goal: "three" }), /2 active/);
	await manager.dispose();
});

test("Sub-Agent manager evicts terminal work across inactive owners", async () => {
	const manager = new SubagentManager({ maxRetainedTerminalTasks: 2, execute: async () => "done" });
	const sources = ["one", "two", "three"].map((chatId) => ({ platform: "cli", chatId, chatType: "dm", userId: "user" }));
	const tasks = [];
	for (const item of sources) {
		const task = manager.spawn(item, { goal: `work-${item.chatId}` });
		tasks.push(task);
		await manager.wait(item, task.id, 1_000);
	}
	assert.throws(() => manager.get(sources[0], tasks[0].id), /not found/i);
	assert.equal(manager.get(sources[2], tasks[2].id).status, "completed");
	await manager.dispose();
});

test("Sub-Agent shutdown is bounded when an executor ignores cancellation", async () => {
	const manager = new SubagentManager({ shutdownGraceMs: 20, execute: async () => new Promise(() => undefined) });
	const task = manager.spawn(source, { goal: "stuck" });
	await new Promise((resolve) => setImmediate(resolve));
	const started = Date.now();
	await manager.dispose();
	assert.ok(Date.now() - started < 200);
	assert.equal(manager.get(source, task.id).status, "cancelled");
});

test("parent sessions expose orchestration tools while child sessions stay read-only and cannot recurse", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-subagent-tools-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const memoryStore = { remember: () => "id", recall: () => [], list: () => [], forget: () => true };
	const manager = new SubagentManager({ execute: async () => "done" });
	const parentFactory = buildAgentFactory({
		profileId: "profile:test",
		provider: "anthropic", model: "claude-sonnet-4-5", cwd, agentDir,
		getApiKey: () => "test", memoryStore,
		sessionTools: (sessionSource) => createSubagentTools(manager, sessionSource),
	});
	const childFactory = buildAgentFactory({
		profileId: "profile:test",
		provider: "anthropic", model: "claude-sonnet-4-5", cwd, agentDir,
		getApiKey: () => "test", memoryStore,
		tools: ["read", "grep", "find", "ls", "web_search", "web_extract", "memory_recall", "memory_list"],
	});
	const parent = await parentFactory("parent", source);
	const child = await childFactory("child", source);
	try {
		const parentTools = new Set(parent.agent.state.tools.map((tool) => tool.name));
		assert.equal(parentTools.has("task_spawn"), true);
		assert.equal(parentTools.has("task_cancel"), true);
		const childTools = new Set(child.agent.state.tools.map((tool) => tool.name));
		for (const allowed of ["read", "grep", "find", "ls", "web_search", "web_extract", "memory_recall", "memory_list"]) {
			assert.equal(childTools.has(allowed), true, `missing ${allowed}`);
		}
		for (const denied of ["bash", "edit", "write", "memory_remember", "memory_forget", "skill_create", "task_spawn"]) {
			assert.equal(childTools.has(denied), false, `unexpected ${denied}`);
		}
	} finally {
		parent.dispose();
		child.dispose();
		await manager.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("/stop bypasses the conversation turn lock and cascades Sub-Agent cancellation", async () => {
	let inbound;
	const sent = [];
	const platform = {
		name: "feishu", isConnected: true,
		onMessage: (handler) => { inbound = handler; },
		connect: async () => true,
		disconnect: async () => undefined,
		send: async (_chatId, text) => { sent.push(text); return { success: true }; },
		editMessage: async () => ({ success: true }),
		sendCard: async () => ({ success: true, messageId: "card" }),
		updateCard: async () => ({ success: true }),
		sendTyping: async () => undefined,
		stopTyping: async () => undefined,
	};
	let cancelled = 0;
	let aborted = 0;
	const dispatcher = new Dispatcher({
		runtime: { run: async () => { throw new Error("should not run for /stop"); }, cancel: async () => (aborted++, true), handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined },
		cancelTasks: () => { cancelled++; return 2; },
	}, platform);
	await inbound({
		text: "/stop", messageType: "command", source,
		mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now(),
	});
	assert.equal(cancelled, 1);
	assert.equal(aborted, 1);
	assert.match(sent[0], /取消 2 个子任务/);
	dispatcher.dispose();
});

test("Dispatcher delegates turns to an injected Agent Runtime", async () => {
	let inbound;
	const runs = [];
	const platform = {
		name: "feishu", isConnected: true,
		onMessage: (handler) => { inbound = handler; },
		connect: async () => true,
		disconnect: async () => undefined,
		send: async () => ({ success: true }),
		editMessage: async () => ({ success: true }),
		sendCard: async () => ({ success: true, messageId: "card" }),
		updateCard: async () => ({ success: true }),
		sendTyping: async () => undefined,
		stopTyping: async () => undefined,
	};
	let disposed = 0;
	const dispatcher = new Dispatcher({
		runtime: {
			run: async (input) => { runs.push(input); return { answer: "ok", model: "test", durationMs: 1, usage: {} }; },
			cancel: async () => false,
			handleControl: async () => undefined,
			isBusy: () => false,
			dispose: () => { disposed++; },
		},
	}, platform);
	await inbound({ text: "hello", messageType: "text", source, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(runs.length, 1);
	assert.equal(runs[0].text, "hello");
	dispatcher.dispose();
	assert.equal(disposed, 0);
});

test("Dispatcher acknowledges a durable Objective only after interactive channel delivery succeeds", async () => {
	let inbound;
	const order = [];
	const completionId = "objective-completion:objective-1";
	const deliveryIdempotencyKey = "objective-interaction:delivery-1";
	const unboundedAnswer = "x".repeat(50_001);
	const canonicalResult = unboundedAnswer.slice(0, 50_000);
	const platform = {
		name: "feishu", isConnected: true,
		onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async (_chatId, text, options) => { order.push({ kind: "send", text, options }); return { success: true, messageId: "om-1" }; },
		editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const acknowledgements = [];
	let runtimeSource;
	const dispatcher = new Dispatcher({
		runtime: { run: async (input) => { runtimeSource = input.source; return { answer: unboundedAnswer, model: "test", durationMs: 1, usage: {}, completionId }; }, cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined },
		completionAcknowledger: {
			getObjectiveCompletion: () => ({ id: completionId, objectiveId: "objective-1", ownerKey: "owner", target: { platform: "feishu", chatId: "chat-1" }, deliveryIdempotencyKey, title: "work", result: canonicalResult, status: "queued", attempts: 0, nextAttemptAt: 0, createdAt: 0 }),
			acknowledgeObjectiveCompletion: (id, receipt) => { order.push({ kind: "ack" }); acknowledgements.push({ id, receipt }); return true; },
		},
		beforeCompletionAcknowledged: () => { order.push({ kind: "publish" }); },
	}, platform);
	await inbound({ text: "do work", messageType: "text", source: { ...source, messageId: "completion-turn" }, replyToMessageId: "thread-root", mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	for (let attempt = 0; acknowledgements.length === 0 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.deepEqual(order.map(({ kind }) => kind), ["send", "publish", "ack"]);
	assert.equal(order[0].text, canonicalResult, "interactive and Outbox delivery must use the same canonical payload");
	assert.equal(order[0].options.idempotencyKey, deliveryIdempotencyKey);
	assert.equal(order[0].options.replyTo, "thread-root");
	assert.equal(order[0].options.replyInThread, false);
	assert.equal(acknowledgements[0].id, completionId);
	assert.equal(acknowledgements[0].receipt.idempotencyKey, deliveryIdempotencyKey);
	assert.equal(acknowledgements[0].receipt.providerMessageId, "om-1");
	assert.equal(runtimeSource.originMessageId, "completion-turn");
	assert.equal(runtimeSource.replyToMessageId, "thread-root");
	await dispatcher.dispose();
});

test("Dispatcher leaves a delivered Completion queued when Memory publication fails without replaying Pi", async () => {
	let inbound, runs = 0, sends = 0, acknowledgements = 0;
	const completionId = "objective-completion:publication-retry";
	const dispatcher = new Dispatcher({
		runtime: { run: async () => { runs++; return { answer: "verified result", model: "test", durationMs: 1, usage: {}, completionId }; }, cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined },
		completionAcknowledger: {
			getObjectiveCompletion: () => ({ id: completionId, objectiveId: "publication-retry", ownerKey: "owner", target: { platform: "feishu", chatId: "chat-1" }, deliveryIdempotencyKey: "delivery:publication-retry", title: "work", result: "verified result", status: "queued", attempts: 0, nextAttemptAt: 0, createdAt: 0 }),
			acknowledgeObjectiveCompletion: () => { acknowledgements++; return true; },
		},
		beforeCompletionAcknowledged: async () => { throw new Error("memory unavailable"); },
	}, {
		name: "feishu", isConnected: true,
		onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => { sends++; return { success: true, messageId: "om-1" }; },
		editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	});
	await inbound({ text: "do work", messageType: "text", source: { ...source, messageId: "publication-turn" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	for (let attempt = 0; sends === 0 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.deepEqual({ runs, sends, acknowledgements }, { runs: 1, sends: 1, acknowledgements: 0 });
	await dispatcher.dispose();
});

test("Dispatcher defers Completion delivery failure without marking the accepted turn failed or replaying Pi", async () => {
	let inbound, runs = 0, acknowledgements = 0;
	const closed = [];
	const completionId = "objective-completion:delivery-retry";
	const message = { text: "do work", messageType: "text", source: { ...source, messageId: "delivery-retry-turn" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() };
	const platform = {
		name: "feishu", isConnected: true,
		onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }),
		sendTyping: async () => undefined, stopTyping: async () => undefined,
		presentation: {
			open: () => ({
				start: async () => undefined,
				onEvent: async () => undefined,
				finish: async () => { throw new Error("provider unavailable"); },
				fail: async () => undefined,
				close: async (failed) => { closed.push(failed); },
			}),
		},
	};
	const dispatcher = new Dispatcher({
		runtime: { run: async () => { runs++; return { answer: "verified result", model: "test", durationMs: 1, usage: {}, completionId }; }, cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined },
		completionAcknowledger: {
			getObjectiveCompletion: () => ({ id: completionId, objectiveId: "delivery-retry", ownerKey: "owner", target: { platform: "feishu", chatId: "chat-1" }, deliveryIdempotencyKey: "delivery:retry", title: "work", result: "verified result", status: "queued", attempts: 0, nextAttemptAt: 0, createdAt: 0 }),
			acknowledgeObjectiveCompletion: () => { acknowledgements++; return true; },
		},
	}, platform);
	await inbound(message);
	for (let attempt = 0; closed.length === 0 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
	await inbound(message);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual({ runs, acknowledgements, closed }, { runs: 1, acknowledgements: 0, closed: [false] });
	await dispatcher.dispose();
});

test("Dispatcher ignores legacy card approval actions", async () => {
	let inbound;
	let cardAction;
	let finishTurn;
	const actions = [];
	const platform = {
		name: "feishu", isConnected: true,
		onMessage: (handler) => { inbound = handler; },
		onCardAction: (handler) => { cardAction = handler; },
		connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }),
		sendCard: async () => ({ success: true, messageId: "card-1" }), updateCard: async () => ({ success: true }),
		sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	enableFeishuPresentation(platform);
	const interaction = {
		dispatch: async (action, sink) => {
			actions.push(action);
			if (action.type === "message.send") {
				await sink({ type: "approval.requested", turnId: "turn", toolName: "bash", details: undefined });
				return new Promise((resolve) => { finishTurn = async () => {
					await sink({ type: "approval.resolved", turnId: "turn", toolName: "bash", allowed: true });
					const result = { answer: "ok", model: "test", durationMs: 1, usage: {} };
					await sink({ type: "turn.finished", turnId: "turn", result });
					resolve(result);
				}; });
			}
			return { handled: true };
		},
		snapshot: async () => ({ phase: "idle", updatedAt: Date.now() }),
		reservePrimaryInput: (source, text) => ({ id: "primary", key: "key", source, text, createdAt: 1 }),
		peekQueuedInput: () => undefined, claimQueuedInput: () => undefined,
	};
	const dispatcher = new Dispatcher({ runtime: { isBusy: () => false, handleControl: async () => undefined }, interaction, flushIntervalMs: 0 }, platform);
	assert.equal(cardAction, undefined, "Dispatcher must not register a tool-approval card action handler");
	const turn = inbound({ text: "do it", messageType: "text", source: { ...source, messageId: "request-1" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(actions.filter((action) => action.type === "approval.decide").length, 0);
	await finishTurn();
	await turn;
	dispatcher.dispose();
});

test("Dispatcher delivers a second inbound message as a native follow-up to the active turn", async () => {
	let inbound;
	let finish;
	const followUps = [];
	const sent = [];
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async (_chatId, text) => { sent.push(text); return { success: true }; }, editMessage: async () => ({ success: true }),
		sendCard: async () => ({ success: true, messageId: "card" }), updateCard: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const runtime = {
		run: async () => new Promise((resolve) => { finish = resolve; }),
		followUp: async (_source, text) => { followUps.push(text); return true; },
		cancel: async () => false, handleControl: async () => undefined, modelStatus: async () => undefined, usage: async () => undefined,
		isBusy: () => true, dispose: () => undefined,
	};
	const dispatcher = new Dispatcher({ runtime }, platform);
	const first = inbound({ text: "first", messageType: "text", source: { ...source, messageId: "first" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setImmediate(resolve));
	await inbound({ text: "second", messageType: "text", source: { ...source, messageId: "second" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	assert.deepEqual(followUps, ["second"]);
	assert.match(sent.at(-1), /已收到补充消息/);
	finish({ answer: "ok", model: "test", durationMs: 1, usage: {} });
	await first;
	dispatcher.dispose();
});

test("Dispatcher atomically reserves a session so concurrent inbound messages cannot start two turns", async () => {
	let inbound;
	let finish;
	let runs = 0;
	const followUps = [];
	const active = new Promise((resolve) => { finish = resolve; });
	let releaseModel;
	const modelGate = new Promise((resolve) => { releaseModel = resolve; });
	let markRun;
	let markFollowUp;
	const runSeen = new Promise((resolve) => { markRun = resolve; });
	const followUpSeen = new Promise((resolve) => { markFollowUp = resolve; });
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }),
		sendCard: async () => ({ success: true, messageId: "card" }), updateCard: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const runtime = {
		run: async () => { runs++; markRun(); return active; },
		followUp: async (_source, text) => { followUps.push(text); markFollowUp(); return true; },
		cancel: async () => false, handleControl: async () => undefined,
		modelStatus: async () => { await modelGate; return undefined; }, usage: async () => undefined,
		isBusy: () => true, dispose: () => undefined,
	};
	const dispatcher = new Dispatcher({ runtime, flushIntervalMs: 0 }, platform);
	const first = inbound({ text: "first", messageType: "text", source: { ...source, messageId: "race-first" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	const second = inbound({ text: "second", messageType: "text", source: { ...source, messageId: "race-second" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	releaseModel();
	const admitted = await Promise.race([Promise.all([runSeen, followUpSeen]).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 3_000))]);
	const observed = { runs, followUps: [...followUps] };
	finish({ answer: "ok", model: "test", durationMs: 1, usage: {} });
	await Promise.all([first, second]);
	dispatcher.dispose();
	assert.equal(admitted, true);
	assert.equal(observed.runs, 1);
	assert.deepEqual(observed.followUps, ["second"]);
});

test("Dispatcher drains a legacy runtime fallback queue after the active turn completes", async () => {
	let inbound;
	const runs = [];
	const resolvers = [];
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		sendCard: async () => ({ success: true, messageId: `card-${runs.length}` }), updateCard: async () => ({ success: true }),
	};
	const runtime = {
		run: async ({ text }) => { runs.push(text); return new Promise((resolve) => { resolvers.push(resolve); }); },
		cancel: async () => false, handleControl: async () => undefined, modelStatus: async () => undefined, usage: async () => undefined,
		isBusy: () => true, dispose: () => undefined,
	};
	const dispatcher = new Dispatcher({ runtime, flushIntervalMs: 0 }, platform);
	await inbound({ text: "first", messageType: "text", source: { ...source, messageId: "legacy-first" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await inbound({ text: "second", messageType: "text", source: { ...source, messageId: "legacy-second" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	resolvers[0]({ answer: "one", model: "test", durationMs: 1, usage: {} });
	for (let attempt = 0; runs.length < 2 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(runs, ["first", "second"]);
	resolvers[1]({ answer: "two", model: "test", durationMs: 1, usage: {} });
	dispatcher.dispose();
});

test("Dispatcher sends explicit /steer guidance to the active turn", async () => {
	let inbound;
	let finish;
	const guidance = [];
	const sent = [];
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async (_chatId, text) => { sent.push(text); return { success: true }; }, editMessage: async () => ({ success: true }),
		sendCard: async () => ({ success: true, messageId: "card" }), updateCard: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const runtime = {
		run: async () => new Promise((resolve) => { finish = resolve; }),
		steer: async (_source, text) => { guidance.push(text); return true; },
		cancel: async () => false, handleControl: async () => undefined, modelStatus: async () => undefined, usage: async () => undefined,
		isBusy: () => true, dispose: () => undefined,
	};
	const dispatcher = new Dispatcher({ runtime }, platform);
	const first = inbound({ text: "first", messageType: "text", source: { ...source, messageId: "first-steer" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await new Promise((resolve) => setImmediate(resolve));
	await inbound({ text: "/steer 改成中文报告", messageType: "command", source: { ...source, messageId: "steer" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	assert.deepEqual(guidance, ["改成中文报告"]);
	assert.match(sent.at(-1), /已更新当前任务要求/);
	finish({ answer: "ok", model: "test", durationMs: 1, usage: {} });
	await first;
	dispatcher.dispose();
});

test("Dispatcher delegates opaque control handling to the Agent Runtime", async () => {
	let inbound;
	const sent = [];
	const platform = {
		name: "feishu", isConnected: true,
		onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async (_chatId, text) => { sent.push(text); return { success: true }; }, editMessage: async () => ({ success: true }),
		sendCard: async () => ({ success: true, messageId: "card" }), updateCard: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const dispatcher = new Dispatcher({
		runtime: {
			run: async () => { throw new Error("control must not become an Agent prompt"); }, cancel: async () => false,
			handleControl: async ({ text }) => text === "/anything" ? { handled: true, message: "handled by Core" } : undefined,
			isBusy: () => false, dispose: () => undefined,
		},
	}, platform);
	await inbound({ text: "/anything", messageType: "command", source, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	assert.deepEqual(sent, ["handled by Core"]);
	dispatcher.dispose();
});

test("Dispatcher publishes trusted HTML, PDF, and Word links before native channel delivery", async () => {
	const profileRoot = mkdtempSync(join(tmpdir(), "beemax-interactive-artifacts-"));
	const workspace = join(profileRoot, "workspace");
	const snapshotRoot = join(profileRoot, "state", "artifact-delivery");
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
	try {
		let inbound;
		let markFinalDeliveryStarted;
		let finishFinalDelivery;
		const finalDeliveryStarted = new Promise((resolve) => { markFinalDeliveryStarted = resolve; });
		const finalDeliveryMayFinish = new Promise((resolve) => { finishFinalDelivery = resolve; });
		const deliveredMedia = [];
		const publishedMedia = [];
		const sent = [];
		const artifact = (name, mimeType, contents, producer) => {
			const bytes = Buffer.from(contents);
			writeFileSync(join(workspace, name), bytes);
			const manifest = createArtifactManifest({
				locator: { kind: "workspace", uri: `workspace:${name}` },
				mediaType: mimeType,
				byteLength: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				producer: { providerId: producer, providerVersion: "1.0.0", operation: producer === "beemax.write" ? "write" : "render" },
				sourceRefs: ["source-receipt:test:gold"],
				createdAt: 1_721_000_000_000,
			});
			return { type: "file", uri: manifest.locator.uri, label: mimeType, manifest };
		};
		const artifacts = [
			artifact("gold-report.html", "text/html", "<html>verified gold report</html>", "beemax.write"),
			artifact("gold-report.pdf", "application/pdf", "%PDF-verified-gold-report", "beemax.chrome-pdf"),
			artifact("gold-report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK-verified-gold-report", "beemax.write"),
		];
		const platform = {
			name: "feishu", isConnected: true, capabilities: { mediaDelivery: "files" },
			onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
			send: async (_chatId, text) => { sent.push(text); return { success: true, messageId: "answer" }; },
			sendMedia: async (...args) => {
				if (args[3] === "gold-report.docx") {
					markFinalDeliveryStarted(args[1]);
					await finalDeliveryMayFinish;
				}
				const delivered = [...args];
				delivered.snapshotBytes = readFileSync(args[1]);
				deliveredMedia.push(delivered);
				return { success: true, messageId: `file-${deliveredMedia.length}` };
			},
			editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		};
		const runtime = {
			run: async () => ({ answer: "报告已生成", model: "test", durationMs: 1, usage: {}, artifacts, outcome: { status: "answered" } }),
			cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined,
		};
		const artifactPublisher = {
			publish: async (_artifact, media) => {
				publishedMedia.push({ ...media, snapshotBytes: readFileSync(media.path) });
				return {
					url: `https://reports.example.test/artifacts/${encodeURIComponent(media.name)}`,
					name: media.name,
					mediaType: media.mimeType,
					disposition: media.name.endsWith(".docx") ? "attachment" : "inline",
				};
			},
		};
		const dispatcher = new Dispatcher({ runtime, artifactWorkspace: workspace, artifactSnapshotRoot: snapshotRoot, artifactPublisher, flushIntervalMs: 0 }, platform);
		await inbound({ text: "生成黄金报告", messageType: "text", source: { ...source, messageId: "artifact-delivery" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
		const disposal = dispatcher.dispose();
		const pendingDelivery = await Promise.race([
			finalDeliveryStarted.then((path) => ({ state: "started", path })),
			disposal.then(() => ({ state: "settled" })),
		]);
		try {
			assert.equal(pendingDelivery.state, "started");
			assert.deepEqual(readFileSync(pendingDelivery.path), Buffer.from("PK-verified-gold-report"));
		} finally {
			finishFinalDelivery();
		}
		await disposal;
		assert.deepEqual(deliveredMedia.map(([, , mimeType, name]) => ({ mimeType, name })), [
			{ mimeType: "text/html", name: "gold-report.html" },
			{ mimeType: "application/pdf", name: "gold-report.pdf" },
			{ mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "gold-report.docx" },
		]);
		assert.ok(deliveredMedia.every(([, path], index) => path !== publishedMedia[index].path));
		assert.deepEqual(deliveredMedia.map(({ snapshotBytes }) => snapshotBytes), publishedMedia.map(({ snapshotBytes }) => snapshotBytes));
		assert.ok(deliveredMedia.every(([, path, , name]) => path !== realpathSync(join(workspace, name))));
		assert.equal(publishedMedia.length, 3);
		assert.match(sent.at(-1), /报告已生成/u);
		assert.match(sent.at(-1), /\[gold-report\.html\]\(https:\/\/reports\.example\.test\/artifacts\/gold-report\.html\)/u);
		assert.match(sent.at(-1), /\[gold-report\.pdf\]\(https:\/\/reports\.example\.test\/artifacts\/gold-report\.pdf\)/u);
		assert.match(sent.at(-1), /\[gold-report\.docx\]\(https:\/\/reports\.example\.test\/artifacts\/gold-report\.docx\).*下载/u);
		assert.deepEqual(readdirSync(snapshotRoot), []);
	} finally {
		rmSync(profileRoot, { recursive: true, force: true });
	}
});

test("Dispatcher preserves native artifact delivery when online publication fails", async () => {
	const profileRoot = mkdtempSync(join(tmpdir(), "beemax-interactive-publish-failure-"));
	const workspace = join(profileRoot, "workspace");
	const snapshotRoot = join(profileRoot, "state", "artifact-delivery");
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
	const previousWarn = console.warn;
	try {
		let inbound;
		let delivered = 0;
		const warnings = [];
		console.warn = (message) => warnings.push(message);
		const bytes = Buffer.from("%PDF-still-delivered");
		writeFileSync(join(workspace, "fallback.pdf"), bytes);
		const manifest = createArtifactManifest({
			locator: { kind: "workspace", uri: "workspace:fallback.pdf" },
			mediaType: "application/pdf",
			byteLength: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			producer: { providerId: "beemax.chrome-pdf", providerVersion: "1.0.0", operation: "render" },
			sourceRefs: ["source-receipt:test:fallback"],
			createdAt: 1_721_000_000_000,
		});
		const platform = {
			name: "feishu", isConnected: true, capabilities: { mediaDelivery: "files" },
			onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
			send: async () => ({ success: true, messageId: "answer" }),
			sendMedia: async () => { delivered += 1; return { success: true, messageId: "file" }; },
			editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		};
		const runtime = {
			run: async () => ({ answer: "报告已生成", model: "test", durationMs: 1, usage: {}, artifacts: [{ type: "file", uri: manifest.locator.uri, manifest }], outcome: { status: "answered" } }),
			cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined,
		};
		const dispatcher = new Dispatcher({
			runtime,
			artifactWorkspace: workspace,
			artifactSnapshotRoot: snapshotRoot,
			artifactPublisher: { publish: async () => { throw new Error("publisher unavailable"); } },
			flushIntervalMs: 0,
		}, platform);
		await inbound({ text: "生成报告", messageType: "text", source: { ...source, messageId: "publish-failure" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
		for (let attempt = 0; delivered < 1 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(delivered, 1);
		assert.ok(warnings.some((warning) => /publisher unavailable/u.test(warning)));
		await dispatcher.dispose();
	} finally {
		console.warn = previousWarn;
		rmSync(profileRoot, { recursive: true, force: true });
	}
});

test("Dispatcher delivers the verified Artifact Manifest bytes after the workspace file changes", async () => {
	const profileRoot = mkdtempSync(join(tmpdir(), "beemax-interactive-artifact-snapshot-"));
	const workspace = join(profileRoot, "workspace");
	const snapshotRoot = join(profileRoot, "state", "artifact-delivery");
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
	try {
		let inbound;
		let delivered;
		let publisherPath;
		const original = Buffer.from("%PDF-verified-manifest-bytes");
		const workspacePath = join(workspace, "report.pdf");
		writeFileSync(workspacePath, original);
		const manifest = createArtifactManifest({
			locator: { kind: "workspace", uri: "workspace:report.pdf" },
			mediaType: "application/pdf",
			byteLength: original.byteLength,
			sha256: createHash("sha256").update(original).digest("hex"),
			producer: { providerId: "beemax.chrome-pdf", providerVersion: "1.0.0", operation: "render" },
			sourceRefs: ["source-receipt:test:snapshot"],
			createdAt: 1_721_000_000_000,
		});
		const platform = {
			name: "feishu", isConnected: true, capabilities: { mediaDelivery: "files" },
			onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
			send: async () => ({ success: true, messageId: "answer" }),
			sendMedia: async (_chatId, path, mimeType, name) => {
				delivered = { path, mimeType, name, bytes: readFileSync(path) };
				return { success: true, messageId: "file" };
			},
			editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		};
		const runtime = {
			run: async () => ({ answer: "报告已生成", model: "test", durationMs: 1, usage: {}, artifacts: [{ type: "file", uri: manifest.locator.uri, manifest }], outcome: { status: "answered" } }),
			cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined,
		};
		const dispatcher = new Dispatcher({
			runtime,
			artifactWorkspace: workspace,
			artifactSnapshotRoot: snapshotRoot,
			artifactPublisher: {
				publish: async (_artifact, media) => {
					publisherPath = media.path;
					writeFileSync(workspacePath, "%PDF-replaced-after-verification");
					return { url: "https://reports.example.test/report.pdf", name: media.name, mediaType: media.mimeType, disposition: "inline" };
				},
			},
			flushIntervalMs: 0,
		}, platform);

		await inbound({ text: "生成报告", messageType: "text", source: { ...source, messageId: "artifact-snapshot" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
		for (let attempt = 0; !delivered && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(delivered?.bytes, original);
		assert.notEqual(delivered?.path, realpathSync(workspacePath));
		assert.notEqual(delivered?.path, publisherPath);
		assert.ok(delivered?.path.startsWith(`${realpathSync(snapshotRoot)}/`));
		assert.equal(delivered?.mimeType, "application/pdf");
		assert.equal(delivered?.name, "report.pdf");
		await dispatcher.dispose();
		assert.throws(() => readFileSync(delivered.path), /ENOENT/u);
		assert.deepEqual(readdirSync(snapshotRoot), []);
	} finally {
		rmSync(profileRoot, { recursive: true, force: true });
	}
});

test("Dispatcher rejects a Publisher that rewrites its known snapshot after Manifest verification", async () => {
	const profileRoot = mkdtempSync(join(tmpdir(), "beemax-interactive-artifact-snapshot-rewrite-"));
	const workspace = join(profileRoot, "workspace");
	const snapshotRoot = join(profileRoot, "state", "artifact-delivery");
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
	const previousError = console.error;
	try {
		let inbound;
		let delivered;
		const original = Buffer.from("%PDF-manifest-original");
		const tampered = Buffer.alloc(original.byteLength, 0x58);
		const workspacePath = join(workspace, "report.pdf");
		writeFileSync(workspacePath, original);
		const manifest = createArtifactManifest({
			locator: { kind: "workspace", uri: "workspace:report.pdf" },
			mediaType: "application/pdf",
			byteLength: original.byteLength,
			sha256: createHash("sha256").update(original).digest("hex"),
			producer: { providerId: "beemax.chrome-pdf", providerVersion: "1.0.0", operation: "render" },
			sourceRefs: ["source-receipt:test:snapshot-rewrite"],
			createdAt: 1_721_000_000_000,
		});
		const platform = {
			name: "feishu", isConnected: true, capabilities: { mediaDelivery: "files" },
			onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
			send: async () => ({ success: true, messageId: "answer" }),
			sendMedia: async (_chatId, path) => { delivered = readFileSync(path); return { success: true, messageId: "file" }; },
			editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		};
		const runtime = {
			run: async () => ({ answer: "报告已生成", model: "test", durationMs: 1, usage: {}, artifacts: [{ type: "file", uri: manifest.locator.uri, manifest }], outcome: { status: "answered" } }),
			cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined,
		};
		console.error = () => undefined;
		const dispatcher = new Dispatcher({
			runtime,
			artifactWorkspace: workspace,
			artifactSnapshotRoot: snapshotRoot,
			artifactPublisher: {
				publish: async (_artifact, media) => {
					chmodSync(media.path, 0o600);
					writeFileSync(media.path, tampered);
					return { url: "https://reports.example.test/report.pdf", name: media.name, mediaType: media.mimeType, disposition: "inline" };
				},
			},
			flushIntervalMs: 0,
		}, platform);

		await inbound({ text: "生成报告", messageType: "text", source: { ...source, messageId: "artifact-snapshot-rewrite" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
		await dispatcher.dispose();
		assert.equal(delivered, undefined);
		assert.deepEqual(readdirSync(snapshotRoot), []);
	} finally {
		console.error = previousError;
		rmSync(profileRoot, { recursive: true, force: true });
	}
});

test("Dispatcher rejects a Publisher that replaces its known snapshot path after Manifest verification", async () => {
	const profileRoot = mkdtempSync(join(tmpdir(), "beemax-interactive-artifact-snapshot-replace-"));
	const workspace = join(profileRoot, "workspace");
	const snapshotRoot = join(profileRoot, "state", "artifact-delivery");
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
	const previousError = console.error;
	try {
		let inbound;
		let delivered;
		const original = Buffer.from("%PDF-manifest-original");
		const tampered = Buffer.alloc(original.byteLength, 0x58);
		const workspacePath = join(workspace, "report.pdf");
		writeFileSync(workspacePath, original);
		const manifest = createArtifactManifest({
			locator: { kind: "workspace", uri: "workspace:report.pdf" },
			mediaType: "application/pdf",
			byteLength: original.byteLength,
			sha256: createHash("sha256").update(original).digest("hex"),
			producer: { providerId: "beemax.chrome-pdf", providerVersion: "1.0.0", operation: "render" },
			sourceRefs: ["source-receipt:test:snapshot-replace"],
			createdAt: 1_721_000_000_000,
		});
		const platform = {
			name: "feishu", isConnected: true, capabilities: { mediaDelivery: "files" },
			onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
			send: async () => ({ success: true, messageId: "answer" }),
			sendMedia: async (_chatId, path) => { delivered = readFileSync(path); return { success: true, messageId: "file" }; },
			editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		};
		const runtime = {
			run: async () => ({ answer: "报告已生成", model: "test", durationMs: 1, usage: {}, artifacts: [{ type: "file", uri: manifest.locator.uri, manifest }], outcome: { status: "answered" } }),
			cancel: async () => false, handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined,
		};
		console.error = () => undefined;
		const dispatcher = new Dispatcher({
			runtime,
			artifactWorkspace: workspace,
			artifactSnapshotRoot: snapshotRoot,
			artifactPublisher: {
				publish: async (_artifact, media) => {
					const replacement = `${media.path}.replacement`;
					writeFileSync(replacement, tampered, { mode: 0o400 });
					renameSync(replacement, media.path);
					return { url: "https://reports.example.test/report.pdf", name: media.name, mediaType: media.mimeType, disposition: "inline" };
				},
			},
			flushIntervalMs: 0,
		}, platform);

		await inbound({ text: "生成报告", messageType: "text", source: { ...source, messageId: "artifact-snapshot-replace" }, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
		await dispatcher.dispose();
		assert.equal(delivered, undefined);
		assert.deepEqual(readdirSync(snapshotRoot), []);
	} finally {
		console.error = previousError;
		rmSync(profileRoot, { recursive: true, force: true });
	}
});

test("Dispatcher replays and acknowledges crash-surviving queued inputs on Gateway startup", async () => {
	let inbound;
	const acknowledged = [];
	const runs = [];
	const cards = [];
	let recoveredClaimed = false;
	const recoveredSource = { ...source, messageId: "om_original_recovered" };
	const replyAnchors = [];
	const platform = {
		name: "feishu", isConnected: true, onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
		sendCard: async (_chatId, card, replyTo) => { cards.push(card); replyAnchors.push(replyTo); return { success: true, messageId: "recovered-card" }; }, updateCard: async (_id, card) => { cards.push(card); return { success: true }; },
	};
	enableFeishuPresentation(platform);
	const interaction = {
		claimRecoveredInputs: () => {
			if (recoveredClaimed) return [];
			recoveredClaimed = true;
			return [{ id: "queued-1", key: "key", text: "resume this", source: recoveredSource, createdAt: 1, claimToken: "claim" }];
		},
		acknowledgeQueuedInput: (_source, id) => { acknowledged.push(id); return true; },
			dispatch: async (action, sink) => {
			runs.push(action.text);
			await sink({ type: "turn.started", turnId: "recovered", sessionId: "session", scope: recoveredSource, at: 1, sequence: 1 });
			await sink({ type: "work.changed", turnId: "recovered", sessionId: "session", scope: recoveredSource, at: 2, sequence: 2, workId: "plan-call", kind: "task_plan", state: "running", summary: "plan-42 · 后台运行中" });
			const result = { answer: "done", model: "test", durationMs: 1, usage: {} };
			await sink({ type: "turn.finished", turnId: "recovered", sessionId: "session", scope: recoveredSource, at: 3, sequence: 3, result });
			return result;
		},
		snapshot: async () => ({ phase: "idle", updatedAt: Date.now() }),
	};
	const dispatcher = new Dispatcher({ runtime: { isBusy: () => false, handleControl: async () => undefined }, interaction, flushIntervalMs: 0 }, platform);
	assert.equal(typeof inbound, "function");
	assert.equal(await dispatcher.recoverQueuedInputs(), 1);
	assert.deepEqual(runs, ["resume this"]);
	assert.deepEqual(acknowledged, ["queued-1"]);
	assert.equal(replyAnchors[0], "om_original_recovered", "recovery must reply to the real Feishu message rather than a synthetic queue id");
	assert.match(JSON.stringify(cards), /异步任务计划/);
	assert.match(JSON.stringify(cards), /plan-42/);
	dispatcher.dispose();
});

test("Dispatcher retains a Core-selected conversation identity after a control command", async () => {
	let inbound;
	const runs = [];
	const platform = {
		name: "feishu", isConnected: true,
		onMessage: (handler) => { inbound = handler; }, connect: async () => true, disconnect: async () => undefined,
		send: async () => ({ success: true }), editMessage: async () => ({ success: true }), sendCard: async () => ({ success: true, messageId: "card" }), updateCard: async () => ({ success: true }), sendTyping: async () => undefined, stopTyping: async () => undefined,
	};
	const nextSource = { ...source, platform: "untrusted", chatId: "other-chat", userId: "other-user", threadId: "conversation-new" };
	const dispatcher = new Dispatcher({
		runtime: {
			run: async (input) => { runs.push(input); return { answer: "ok", model: "test", durationMs: 1, usage: {} }; }, cancel: async () => false,
			handleControl: async ({ text }) => text === "/new" ? { handled: true, message: "new", nextSource } : undefined,
			isBusy: () => false, dispose: () => undefined,
		},
	}, platform);
	await inbound({ text: "/new", messageType: "command", source, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	await inbound({ text: "continue", messageType: "text", source, mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now() });
	for (let attempt = 0; !runs.length && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(runs[0].source.threadId, "conversation-new");
	assert.equal(runs[0].source.platform, source.platform);
	assert.equal(runs[0].source.chatId, source.chatId);
	assert.equal(runs[0].source.userId, source.userId);
	dispatcher.dispose();
});

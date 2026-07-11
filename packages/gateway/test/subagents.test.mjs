import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentFactory } from "../../../apps/cli/dist/agent-factory.js";
import { Dispatcher } from "../dist/core/dispatcher.js";
import { MessageDeduplicator } from "../dist/index.js";
import { createSubagentTools, ProfileTaskScheduler, SubagentManager } from "@beemax/core";

const source = { platform: "feishu", chatId: "chat-1", chatType: "dm", userId: "user-1" };

test("Gateway idempotency is profile-scoped, bounded, and expires", () => {
	const guard = new MessageDeduplicator({ ttlMs: 1_000, maxEntries: 100 });
	assert.equal(guard.accept("sales", "feishu", "event-1", 0), true);
	assert.equal(guard.accept("sales", "feishu", "event-1", 1), false);
	assert.equal(guard.accept("support", "feishu", "event-1", 1), true);
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

test("parent sessions expose orchestration tools while child sessions stay read-only and cannot recurse", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-subagent-tools-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const memoryStore = { remember: () => "id", recall: () => [], list: () => [], forget: () => true };
	const manager = new SubagentManager({ execute: async () => "done" });
	const parentFactory = buildAgentFactory({
		provider: "anthropic", model: "claude-sonnet-4-5", cwd, agentDir,
		getApiKey: () => "test", memoryStore,
		sessionTools: (sessionSource) => createSubagentTools(manager, sessionSource),
	});
	const childFactory = buildAgentFactory({
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
	let approvalReplies = 0;
	const dispatcher = new Dispatcher({
		runtime: { run: async () => { throw new Error("should not run for /stop"); }, cancel: async () => (aborted++, true), handleControl: async () => undefined, isBusy: () => false, dispose: () => undefined },
		cancelTasks: () => { cancelled++; return 2; },
		approvalBroker: { handleReply: async () => { approvalReplies++; return true; }, dispose: () => undefined },
	}, platform);
	await inbound({
		text: "/stop", messageType: "command", source,
		mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now(),
	});
	assert.equal(cancelled, 1);
	assert.equal(aborted, 1);
	assert.equal(approvalReplies, 0, "/stop must not be consumed as an approval reply");
	assert.match(sent[0], /cancelled 2 Sub-Agent/);
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
	assert.equal(runs.length, 1);
	assert.equal(runs[0].text, "hello");
	dispatcher.dispose();
	assert.equal(disposed, 0);
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
	assert.match(sent.at(-1), /Follow-up delivered/);
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
	assert.equal(runs[0].source.threadId, "conversation-new");
	assert.equal(runs[0].source.platform, source.platform);
	assert.equal(runs[0].source.chatId, source.chatId);
	assert.equal(runs[0].source.userId, source.userId);
	dispatcher.dispose();
});

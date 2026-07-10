import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentFactory } from "../dist/core/agent-factory.js";
import { Dispatcher } from "../dist/core/dispatcher.js";
import { createSubagentTools, SubagentManager } from "../dist/core/subagent-tools.js";

const source = { platform: "feishu", chatId: "chat-1", chatType: "dm", userId: "user-1" };

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
	const dispatcher = new Dispatcher({
		createAgent: async () => { throw new Error("should not create a session for /stop"); },
		cancelTasks: () => { cancelled++; return 2; },
	}, platform);
	await inbound({
		text: "/stop", messageType: "command", source,
		mediaPaths: [], mediaTypes: [], raw: {}, timestamp: Date.now(),
	});
	assert.equal(cancelled, 1);
	assert.match(sent[0], /cancelled 2 Sub-Agent/);
	dispatcher.dispose();
});

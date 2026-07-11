import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "@beemax/memory";
import { AuthStorage, BeeMaxAgentRuntime, buildBeeMaxRuntimeFactory, ConversationContext, defineTool, getBuiltinModel, SessionCoordinator, sessionIdForSource } from "../dist/index.js";

test("BeeMax Core owns the runtime primitive boundary", () => {
	assert.equal(typeof AuthStorage.create, "function");
	assert.equal(typeof defineTool, "function");
	assert.equal(typeof getBuiltinModel, "function");
	assert.equal(typeof buildBeeMaxRuntimeFactory, "function");
});

test("Conversation context owns curated recall and candidate capture", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-core-context-"));
	const memory = new MemoryStore(join(root, "memory.db"));
	const routes = [];
	try {
		memory.remember({ platform: "feishu", chatId: "chat", userId: "user", role: "memory", content: "User prefers concise reports" });
		const context = new ConversationContext(memory, { recordDirectRoute: (route) => routes.push(route) });
		const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };
		assert.match(context.enrich(source, "Please prepare a concise report"), /Relevant curated memory/);
		context.record(source, { user: "Need a report", assistant: "I will prepare it" });
		assert.equal(routes.length, 1);
		assert.equal(memory.listCandidates({ platform: "feishu", chatId: "chat", userId: "user" }).length, 2);
	} finally {
		memory.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Conversation context gives supplied volatile facts precedence over restored chat context", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-core-facts-"));
	const memory = new MemoryStore(join(root, "memory.db"));
	try {
		const context = new ConversationContext(memory, { runtimeFacts: () => "[Task ledger]\n- release: done\n[/Task ledger]" });
		const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
		const enriched = context.enrich(source, "Is the release still pending?");
		assert.match(enriched, /\[Task ledger\]/);
		assert.match(enriched, /Current user request/);
	} finally {
		memory.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Session coordinator owns serial execution, cancellation, and bounded lifecycle", async () => {
	const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };
	const source2 = { ...source, chatId: "other" };
	const disposed = [];
	let concurrent = 0;
	let peak = 0;
	const coordinator = new SessionCoordinator({ maxSessions: 1 });
	const factory = async (id) => ({
		agent: { state: { messages: [] } },
		abort: async () => { disposed.push(`abort:${id}`); },
		dispose: () => { disposed.push(`dispose:${id}`); },
	});
	const run = () => coordinator.run(source, factory, async () => {
		concurrent++;
		peak = Math.max(peak, concurrent);
		await new Promise((resolve) => setTimeout(resolve, 10));
		concurrent--;
	});
	await Promise.all([run(), run()]);
	assert.equal(peak, 1);
	assert.equal(await coordinator.abort(source), true);
	assert.equal(disposed.includes(`abort:${sessionIdForSource(source)}`), true);
	await coordinator.run(source2, factory, async () => undefined);
	assert.equal(disposed.some((item) => item === `dispose:${sessionIdForSource(source)}`), true);
	coordinator.dispose();
});

test("BeeMax Agent Runtime executes a turn and records context without a Gateway", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-runtime-test-"));
	const memory = new MemoryStore(join(root, "memory.db"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	try {
		const runtime = new BeeMaxAgentRuntime({
			context: new ConversationContext(memory),
			createAgent: async () => {
				const agent = { state: { model: { id: "test-model" }, messages: [] } };
				return {
					agent,
					subscribe: () => () => undefined,
					prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 3, output: 1 } }]; },
					abort: async () => undefined,
					dispose: () => undefined,
				};
			},
		});
		const result = await runtime.run({ source, text: "write a report", timeoutMs: 1_000, mode: "interactive" });
		assert.deepEqual(result, { answer: "done", model: "test-model", durationMs: result.durationMs, usage: { input_tokens: 3, output_tokens: 1 } });
		assert.equal(memory.listCandidates({ platform: "cli", chatId: "terminal", userId: "user" }).length, 2);
		runtime.dispose();
	} finally {
		memory.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("BeeMax Agent Runtime propagates an external abort signal to the active turn", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const controller = new AbortController();
	let aborts = 0;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => ({
			agent: { state: { model: { id: "test" }, messages: [] } },
			subscribe: () => () => undefined,
			prompt: async () => { throw new Error("cancelled turn must not start a prompt"); },
			abort: async () => { aborts++; },
			dispose: () => undefined,
		}),
	});
	controller.abort();
	await assert.rejects(runtime.run({ source, text: "work", timeoutMs: 10_000, signal: controller.signal }), /cancelled/);
	assert.equal(aborts, 1);
	runtime.dispose();
});

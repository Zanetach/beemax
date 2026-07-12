import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "@beemax/memory";
import { AgentRunError, AuthStorage, BeeMaxAgentRuntime, buildBeeMaxRuntimeFactory, ConversationContext, defineTool, getBuiltinModel, isRecoverableModelFailure, SessionCoordinator, sessionIdForSource } from "../dist/index.js";

test("BeeMax Core owns the runtime primitive boundary", () => {
	assert.equal(typeof AuthStorage.create, "function");
	assert.equal(typeof defineTool, "function");
	assert.equal(typeof getBuiltinModel, "function");
	assert.equal(typeof buildBeeMaxRuntimeFactory, "function");
	assert.equal(isRecoverableModelFailure({ status: 429 }), true);
	assert.equal(isRecoverableModelFailure({ statusCode: 503 }), true);
	assert.equal(isRecoverableModelFailure(new Error("upstream returned 503")), true);
	assert.equal(isRecoverableModelFailure(new Error("fetch failed")), true);
	assert.equal(isRecoverableModelFailure({ status: 401 }), false);
	assert.equal(isRecoverableModelFailure(new Error("invalid API key")), false);
});

test("BeeMax Agent Runtime lists only Task Plans visible to the conversation owners", () => {
	let query;
	let taskQuery;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => { throw new Error("unused"); },
		taskLedger: {
			queryTaskPlans(input) { query = input; return [{ id: "plan", ownerKey: input.ownerKeys[0], title: "Plan", status: "running", taskCount: 2, succeeded: 1, failed: 0, cancelled: 0, verified: 1, correctiveAttempts: 0, createdAt: 1 }]; },
			queryTasks(input) { taskQuery = input; return []; },
		},
	});
	const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };
	const plans = runtime.taskPlans(source, { id: "plan", status: "running", limit: 10 });
	runtime.tasks(source, { planId: "plan", limit: 100 });
	assert.equal(query.id, "plan");
	assert.deepEqual(query.statuses, ["running"]);
	assert.equal(query.limit, 10);
	assert.ok(query.ownerKeys.includes("feishu:chat:user"));
	assert.ok(query.ownerKeys.includes("profile"));
	assert.equal(plans[0].id, "plan");
	assert.deepEqual(taskQuery.planIds, ["plan"]);
	assert.ok(taskQuery.ownerKeys.includes("feishu:chat:user"));
	runtime.dispose();
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

test("Conversation context recalls pending evidence but labels it as unconfirmed", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-core-candidate-context-"));
	const memory = new MemoryStore(join(root, "memory.db"));
	try {
		const source = { platform: "feishu", chatId: "sales", threadId: "customer-a", chatType: "group", userId: "seller" };
		memory.recordCandidate({ platform: "feishu", chatId: "sales", threadId: "customer-a", userId: "seller", role: "user", content: "客户希望封面使用深蓝色" });
		const enriched = new ConversationContext(memory).enrich(source, "按客户要求制作封面");
		assert.match(enriched, /Unconfirmed conversation evidence/);
		assert.match(enriched, /客户希望封面使用深蓝色/);
		assert.match(enriched, /must not be treated as a confirmed fact/);
	} finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
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

test("BeeMax Agent Runtime injects one structured Work Context into the model turn", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let received = "";
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "test-model" }, messages: [] } };
			return { agent, subscribe: () => () => undefined, prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
		},
	});
	try {
		await runtime.run({ source, text: "生成中文PDF，不要包含报价", timeoutMs: 1_000, mode: "interactive" });
		assert.match(received, /<beemax-work-context>/);
		assert.match(received, /不要包含报价/);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime binds continuation understanding to the active Objective", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let received = "";
	const runtime = new BeeMaxAgentRuntime({
		taskLedger: { queryTasks: () => [{ id: "objective-1", ownerKey: "cli:terminal:user", kind: "objective", title: "制作华东客户周报", status: "running", createdAt: 1 }] },
		createAgent: async () => {
			const agent = { state: { model: { id: "test-model" }, messages: [] } };
			return { agent, subscribe: () => () => undefined, prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
		},
	});
	try {
		await runtime.run({ source, text: "继续完成刚才的任务", timeoutMs: 1_000, mode: "interactive", objectiveTaskId: "objective-1" });
		assert.match(received, /"action":"continue"/);
		assert.match(received, /"goal":"制作华东客户周报"/);
	} finally { runtime.dispose(); }
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

test("BeeMax Agent Runtime passes native image attachments to Pi without prompt serialization", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const images = [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
	let received;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "vision-test" }, messages: [] } };
			return {
				agent,
				subscribe: () => () => undefined,
				prompt: async (text, options) => { received = { text, options }; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "seen" }], usage: { input: 1, output: 1 } }]; },
				abort: async () => undefined,
				dispose: () => undefined,
			};
		},
	});
	await runtime.run({ source, text: "describe this", images, timeoutMs: 1_000 });
	assert.equal(received.text, "describe this");
	assert.deepEqual(received.options.images, images);
	assert.doesNotMatch(received.text, /aW1hZ2U/);
	runtime.dispose();
});

test("BeeMax Agent Runtime exposes Pi native steer and follow-up only during an active run", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let release;
	const delivered = [];
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "test" }, messages: [] } };
			return {
				agent, isStreaming: true,
				subscribe: () => () => undefined,
				prompt: async () => { await new Promise((resolve) => { release = resolve; }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
				steer: async (text) => { delivered.push(["steer", text]); },
				followUp: async (text) => { delivered.push(["follow_up", text]); },
				abort: async () => undefined, dispose: () => undefined,
			};
		},
	});
	assert.equal(await runtime.steer(source, "too early"), false);
	const turn = runtime.run({ source, text: "start", timeoutMs: 1_000 });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(await runtime.steer(source, "focus"), true);
	assert.equal(await runtime.followUp(source, "summarize"), true);
	assert.deepEqual(delivered, [["steer", "focus"], ["follow_up", "summarize"]]);
	release();
	await turn;
	runtime.dispose();
});

test("BeeMax Agent Runtime automatically continues a safe transient failure on a configured fallback model", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const fallback = { provider: "test", id: "fallback", input: ["text"], reasoning: false };
	const events = [];
	let retriedWith;
	const runtime = new BeeMaxAgentRuntime({
		fallbackModels: [fallback],
		createAgent: async () => {
			const agent = { state: { model: { provider: "test", id: "primary" }, messages: [] } };
			return {
				agent, subscribe: () => () => undefined,
				prompt: async () => { agent.state.messages = [{ role: "user", content: "work" }, { role: "assistant", stopReason: "error", errorMessage: "429 rate limit", content: [], usage: { input: 1, output: 0 } }]; },
				retryWithModel: async (model) => { retriedWith = model.id; agent.state.model = model; agent.state.messages = [{ role: "user", content: "work" }, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }], usage: { input: 2, output: 1 } }]; return true; },
				abort: async () => undefined, dispose: () => undefined,
			};
		},
	});
	const result = await runtime.run({ source, text: "work", timeoutMs: 1_000 }, (event) => { events.push(event); });
	assert.equal(retriedWith, "fallback");
	assert.equal(result.answer, "recovered");
	assert.deepEqual(events.filter((event) => event.type === "model_fallback"), [{ type: "model_fallback", from: "primary", to: "fallback", attempt: 1 }]);
	runtime.dispose();
});

test("BeeMax Agent Runtime refuses automatic model replay after observable output or tool execution", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let listener;
	let retries = 0;
	const runtime = new BeeMaxAgentRuntime({
		fallbackModels: [{ provider: "test", id: "fallback", input: ["text"], reasoning: false }],
		createAgent: async () => {
			const agent = { state: { model: { provider: "test", id: "primary" }, messages: [] } };
			return {
				agent, subscribe: (next) => { listener = next; return () => undefined; },
				prompt: async () => { listener({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write" }); agent.state.messages = [{ role: "assistant", stopReason: "error", errorMessage: "503 overloaded", content: [], usage: { input: 1, output: 0 } }]; },
				retryWithModel: async () => { retries++; return true; }, abort: async () => undefined, dispose: () => undefined,
			};
		},
	});
	await assert.rejects(runtime.run({ source, text: "work", timeoutMs: 1_000 }), (error) => error instanceof AgentRunError && error.recoverable);
	assert.equal(retries, 0);
	runtime.dispose();
});

test("BeeMax Agent Runtime exposes explicit context compaction only for an idle session", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let compactions = 0;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => ({
			agent: { state: { model: { id: "test" }, messages: [] } },
			subscribe: () => () => undefined,
			prompt: async () => undefined,
			abort: async () => undefined,
			compact: async () => { compactions++; return { summary: "compacted" }; },
			dispose: () => undefined,
		}),
	});
	assert.equal(await runtime.compact(source), false);
	await runtime.run({ source, text: "hello", timeoutMs: 1_000 });
	assert.equal(await runtime.compact(source), true);
	assert.equal(compactions, 1);
	runtime.dispose();
});

test("context compaction preserves active Objective and Acceptance Criteria", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let compactInstructions = "";
	const runtime = new BeeMaxAgentRuntime({
		taskLedger: { queryTasks: () => [{ id: "objective-1", ownerKey: "cli:terminal:user", kind: "objective", title: "生成客户报告", description: "必须使用中文", acceptanceCriteria: "输出PDF并发送给王总", status: "running", createdAt: 1, effectReceipts: [{ id: "effect-1", tool: "feishu_send", operation: "send report", sideEffect: "mutation", status: "committed", externalRef: "message-42", occurredAt: 2 }] }] },
		createAgent: async () => ({ agent: { state: { model: { id: "test" }, messages: [] } }, subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, compact: async (instructions) => { compactInstructions = instructions; }, dispose: () => undefined }),
	});
	try {
		await runtime.open(source);
		assert.equal(await runtime.compact(source), true);
		assert.match(compactInstructions, /生成客户报告/);
		assert.match(compactInstructions, /输出PDF并发送给王总/);
		assert.match(compactInstructions, /message-42/);
		assert.match(compactInstructions, /task-preservation-envelope/);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime exposes session history, snapshots, and idle reset through Core", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user", threadId: "thread-1" };
	let disposed = 0;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "test" }, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 1, cacheRead: 2, cacheWrite: 3 } }] } };
			let thinkingLevel = "off";
			return { agent, subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, get thinkingLevel() { return thinkingLevel; }, setThinkingLevel: (level) => { thinkingLevel = level; }, getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }), dispose: () => { disposed++; } };
		},
	});
	assert.deepEqual(await runtime.history(source), []);
	assert.equal(await runtime.open(source), true);
	assert.deepEqual(await runtime.history(source), [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }]);
	assert.equal(runtime.reset(source), true);
	assert.equal(disposed, 1);
	await runtime.run({ source, text: "hello", timeoutMs: 1_000 });
	assert.deepEqual(await runtime.history(source), [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }]);
	assert.deepEqual(await runtime.usage(source), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, contextTokens: 10, contextWindow: 100, contextPercent: 10 });
	assert.deepEqual(await runtime.modelStatus(source), { model: "test", thinkingLevel: "off", supportedThinkingLevels: ["off"] });
	assert.deepEqual(await runtime.setThinkingLevel(source, "high"), { model: "test", thinkingLevel: "off", supportedThinkingLevels: ["off"] });
	assert.equal(runtime.listSessions(source)[0].threadId, "thread-1");
	assert.equal(runtime.reset(source), true);
	assert.equal(disposed, 2);
	assert.deepEqual(runtime.listSessions(source), []);
	runtime.dispose();
});

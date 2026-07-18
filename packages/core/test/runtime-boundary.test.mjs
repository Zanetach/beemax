import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const semanticReview = Object.freeze({ schemaVersion: "beemax.work-contract-adjudication.v1", inventorySchemaVersion: "beemax.semantic-inventory.v1", primaryModelIdentity: "test/primary/test", reviewerModelIdentity: "test/reviewer/test", reviewMode: "different_models", independentSamples: true, cognitionUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: ["test/primary/test", "test/reviewer/test"] }, cognitionBudgetChargeTokens: 1 });
import { MemoryStore } from "@beemax/memory";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentRunError, AuthStorage, BeeMaxAgentRuntime, buildBeeMaxRuntimeFactory, buildTaskPreservationEnvelope, ConversationContext, createAccessScopeRef, createEnterprisePolicyProvider, createEnterprisePolicyPublisher, createExecutionEnvelope, createSituation, defineTool, DeterministicWorkContractBuilder, FileExecutionTraceStore, FileToolEffectJournal, getBuiltinModel, isRecoverableModelFailure, MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, resolveRuntimeModel, SessionCoordinator, sessionIdForSource, withToolPolicy } from "../dist/index.js";

const createRuntime = (options) => new BeeMaxAgentRuntime({ profileId: "profile:test", interactiveAdmission: "contract_first", workContractBuilder: new DeterministicWorkContractBuilder(), ...options });

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

test("custom runtime models do not inherit an artificial 8192-token output ceiling", () => {
	const model = resolveRuntimeModel("custom", "private-model", "https://models.example.test/v1", "anthropic-messages");
	assert.equal(model.maxTokens, 32_768);
});

test("runtime usage follows assistant events across in-turn state compaction without counting history twice", async () => {
	const source = { platform: "cli", chatId: "usage-compaction", chatType: "dm", userId: "user", delegatedTask: { id: "task:usage", ownerKey: "owner:usage" } };
	const historical = Array.from({ length: 5 }, (_, index) => ({ role: "assistant", content: [{ type: "text", text: `historical-${index}` }], usage: { input: 100, output: 50 } }));
	const summary = { role: "assistant", content: [{ type: "text", text: "compaction summary" }], usage: { input: 0, output: 0 } };
	const first = { role: "assistant", content: [{ type: "text", text: "first" }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	const second = { role: "assistant", content: [{ type: "text", text: "final" }], usage: { input: 20, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	const agent = { state: { model: { id: "test" }, messages: historical } };
	let listener;
	const runtime = createRuntime({
		createAutomationAgent: async () => ({
			agent,
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: first });
				agent.state.messages.push(first);
				listener({ type: "message_end", message: second });
				// Simulate Pi replacing/compacting the in-turn transcript after both
				// Provider events have already been observed by the runtime.
				agent.state.messages = [summary, second];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
		createAgent: async () => assert.fail("delegated automation must use the automation factory"),
	});
	try {
		const result = await runtime.run({
			source, mode: "automation", text: "execute delegated task", timeoutMs: 1_000,
			executionEnvelope: createExecutionEnvelope({ executionId: "execution:usage-compaction", trigger: { kind: "delegation", id: "task:usage" }, taskId: "task:usage", taskRunId: "run:usage-compaction" }),
		});
		assert.equal(result.answer, "final");
		assert.deepEqual(result.usage, { input_tokens: 30, output_tokens: 5 });
	} finally { runtime.dispose(); }
});

test("runtime preserves an assistant error event when in-turn state compaction shortens history", async () => {
	const source = { platform: "cli", chatId: "error-compaction", chatType: "dm", userId: "user", delegatedTask: { id: "task:error", ownerKey: "owner:error" } };
	const historical = Array.from({ length: 5 }, (_, index) => ({ role: "assistant", content: [{ type: "text", text: `historical-${index}` }], usage: { input: 100, output: 50 } }));
	const summary = { role: "assistant", content: [{ type: "text", text: "compaction summary" }], usage: { input: 0, output: 0 } };
	const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "503 compacted failure", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	const agent = { state: { model: { id: "test" }, messages: historical } };
	let listener;
	const runtime = createRuntime({
		createAutomationAgent: async () => ({
			agent,
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: failed });
				agent.state.messages = [summary, failed];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
		createAgent: async () => assert.fail("delegated automation must use the automation factory"),
	});
	try {
		await assert.rejects(runtime.run({
			source, mode: "automation", text: "execute delegated task", timeoutMs: 1_000,
			executionEnvelope: createExecutionEnvelope({ executionId: "execution:error-compaction", trigger: { kind: "delegation", id: "task:error" }, taskId: "task:error", taskRunId: "run:error-compaction" }),
		}), /503 compacted failure/u);
	} finally { runtime.dispose(); }
});

test("an observed empty assistant success does not revive state-only text", async () => {
	const source = { platform: "cli", chatId: "event-empty-success", chatType: "dm", userId: "user", delegatedTask: { id: "task:event-empty", ownerKey: "owner:event-empty" } };
	const historical = { role: "assistant", content: [{ type: "text", text: "historical" }], usage: { input: 1, output: 1 } };
	const emptySuccess = { role: "assistant", stopReason: "stop", content: [], usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	const stateOnlyText = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "state-only stale answer" }], usage: { input: 2, output: 3 } };
	const agent = { state: { model: { id: "test" }, messages: [historical] } };
	let listener;
	const runtime = createRuntime({
		createAutomationAgent: async () => ({
			agent,
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: emptySuccess });
				agent.state.messages = [historical, stateOnlyText];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
		createAgent: async () => assert.fail("delegated automation must use the automation factory"),
	});
	try {
		const result = await runtime.run({ source, mode: "automation", text: "execute delegated task", timeoutMs: 1_000 });
		assert.equal(result.answer, "(no response)");
		assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 0 });
	} finally { runtime.dispose(); }
});

test("a length-limited partial assistant Turn gets one tool-free complete-response recovery", async () => {
	const source = { platform: "cli", chatId: "length-terminal-recovery", chatType: "dm", userId: "user", delegatedTask: { id: "task:length-recovery", ownerKey: "owner:length-recovery" } };
	const lengthLimited = { role: "assistant", responseId: "response:length-limited", stopReason: "length", content: [{ type: "thinking", thinking: "reasoning consumed the Provider output allowance" }, { type: "text", text: "partial result cut off mid-sentence" }], usage: { input: 100, output: 8_192, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	const recovered = { role: "assistant", responseId: "response:terminal-recovered", stopReason: "stop", content: [{ type: "text", text: "concise evidence-backed result" }], usage: { input: 110, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	const agent = { state: { model: { id: "test" }, messages: [] } };
	let listener;
	let prompts = 0;
	let activeTools = ["read", "web_search"];
	const toolsDuringPrompt = [];
	const promptTexts = [];
	const runtime = createRuntime({
		createAutomationAgent: async () => ({
			agent,
			subscribe: (next) => { listener = next; return () => undefined; },
			getActiveToolNames: () => [...activeTools],
			getAllTools: () => activeTools.map((name) => ({ name, description: name, parameters: {}, beemaxPolicy: READ_ONLY_TOOL_POLICY })),
			setActiveToolsByName: (names) => { activeTools = [...names]; },
			prompt: async (text) => {
				prompts++;
				promptTexts.push(text);
				toolsDuringPrompt.push([...activeTools]);
				const message = prompts === 1 ? lengthLimited : recovered;
				listener({ type: "message_end", message });
				agent.state.messages.push(message);
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
		createAgent: async () => assert.fail("delegated automation must use the automation factory"),
	});
	try {
		const result = await runtime.run({ source, mode: "automation", text: "research and return the final result", timeoutMs: 1_000 });
		assert.equal(result.answer, "concise evidence-backed result");
		assert.equal(prompts, 2);
		assert.deepEqual(toolsDuringPrompt[1], []);
		assert.match(promptTexts[1], /output limit|terminal response|existing evidence/i);
		assert.deepEqual(activeTools, ["read", "web_search"]);
	} finally { runtime.dispose(); }
});

test("a length-truncated Tool call gets one Tool-scoped recovery instead of a prose fallback", async () => {
	const source = { platform: "cli", chatId: "length-tool-recovery", chatType: "dm", userId: "user" };
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [{ name: "write", description: "Write a workspace artifact", parameters: {}, beemaxPolicy: { sideEffect: "local" } }];
	let listener;
	let prompts = 0;
	let activeTools = ["write"];
	const toolsDuringPrompt = [];
	const promptTexts = [];
	const runtime = createRuntime({
		createAgent: async () => ({
			agent,
			getAllTools: () => tools,
			getActiveToolNames: () => [...activeTools],
			setActiveToolsByName: (names) => { activeTools = [...names]; },
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async (text) => {
				prompts++;
				promptTexts.push(text);
				toolsDuringPrompt.push([...activeTools]);
				if (prompts === 1) {
					const args = { path: "report.html", content: "<html>partial" };
					const message = { role: "assistant", responseId: "response:truncated-write", stopReason: "length", content: [{ type: "toolCall", id: "call:truncated-write", name: "write", arguments: args }], usage: { input: 10, output: 8_192, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
					listener({ type: "message_end", message });
					listener({ type: "tool_execution_start", toolCallId: "call:truncated-write", toolName: "write", args });
					listener({ type: "tool_execution_end", toolCallId: "call:truncated-write", toolName: "write", isError: true, result: { content: [{ type: "text", text: "truncated" }], details: { dispatchError: { stage: "validation", code: "response_truncated", retryable: true } } } });
					agent.state.messages.push(message);
					return;
				}
				const args = { path: "report.html", content: "<html>complete</html>", mode: "replace" };
				const toolMessage = { role: "assistant", responseId: "response:recovered-write", stopReason: "toolUse", content: [{ type: "toolCall", id: "call:recovered-write", name: "write", arguments: args }], usage: { input: 12, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
				listener({ type: "message_end", message: toolMessage });
				listener({ type: "tool_execution_start", toolCallId: "call:recovered-write", toolName: "write", args });
				assert.equal(await agent.beforeToolCall({ toolCall: { id: "call:recovered-write", name: "write", arguments: args }, args, context: {} }, new AbortController().signal), undefined);
				listener({ type: "tool_execution_end", toolCallId: "call:recovered-write", toolName: "write", isError: false, result: { content: [{ type: "text", text: "wrote report" }], details: {} } });
				const finalMessage = { role: "assistant", responseId: "response:recovered-final", stopReason: "stop", content: [{ type: "text", text: "artifact written completely" }], usage: { input: 13, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
				listener({ type: "message_end", message: finalMessage });
				agent.state.messages.push(toolMessage, finalMessage);
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	try {
		const result = await runtime.run({ source, mode: "automation", text: "perform the requested operation", timeoutMs: 1_000, allowedCapabilities: ["write"] });
		assert.equal(result.answer, "artifact written completely");
		assert.equal(prompts, 2);
		assert.deepEqual(toolsDuringPrompt[1], ["write"]);
		assert.match(promptTexts[1], /truncated|incremental|chunk/i);
		assert.deepEqual(activeTools, ["write"]);
	} finally { runtime.dispose(); }
});

test("assistant silence never ends an active Turn before its Execution Envelope deadline", async () => {
	const source = { platform: "cli", chatId: "stream-progress", chatType: "dm", userId: "user" };
	const finalMessage = { role: "assistant", responseId: "response:stream-progress", stopReason: "stop", content: [{ type: "text", text: "complete" }], usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	const agent = { state: { model: { id: "test" }, messages: [] } };
	let listener;
	let aborts = 0;
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const runtime = createRuntime({
		turnIdleSettleMs: 20,
		createAutomationAgent: async () => ({
			agent,
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "starting" } });
				await wait(60);
				listener({ type: "message_end", message: finalMessage });
				agent.state.messages.push(finalMessage);
			},
			abort: async () => { aborts++; },
			dispose: () => undefined,
		}),
		createAgent: async () => assert.fail("delegated automation must use the automation factory"),
	});
	try {
		const result = await runtime.run({ source, mode: "automation", text: "perform task", timeoutMs: 1_000 });
		assert.equal(result.answer, "complete");
		assert.equal(aborts, 0);
	} finally { runtime.dispose(); }
});

test("an observed assistant success does not revive a state-only error", async () => {
	const source = { platform: "cli", chatId: "event-success-old-error", chatType: "dm", userId: "user", delegatedTask: { id: "task:event-success", ownerKey: "owner:event-success" } };
	const historical = { role: "assistant", content: [{ type: "text", text: "historical" }], usage: { input: 1, output: 1 } };
	const success = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "fresh success" }], usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	const stateOnlyError = { role: "assistant", stopReason: "error", errorMessage: "503 stale state failure", content: [], usage: { input: 2, output: 0 } };
	const agent = { state: { model: { id: "test" }, messages: [historical] } };
	let listener;
	const runtime = createRuntime({
		createAutomationAgent: async () => ({
			agent,
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: success });
				agent.state.messages = [historical, stateOnlyError];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
		createAgent: async () => assert.fail("delegated automation must use the automation factory"),
	});
	try {
		const result = await runtime.run({ source, mode: "automation", text: "execute delegated task", timeoutMs: 1_000 });
		assert.equal(result.answer, "fresh success");
	} finally { runtime.dispose(); }
});

test("BeeMax applies Profile compaction policy as an in-memory Pi session setting", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-compaction-settings-"));
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", createTools: () => [],
			compaction: { enabled: false, reserveTokens: 12_000, keepRecentTokens: 16_000 },
		});
		const session = await factory("compaction-settings", { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" });
		try {
			assert.deepEqual(session.compactionSettings, { enabled: false, reserveTokens: 12_000, keepRecentTokens: 16_000 });
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax compacts restored history before it consumes the Pi execution token budget", async () => {
	const source = { platform: "cli", chatId: "budget-aware-compaction", chatType: "dm", userId: "user" };
	const agent = { state: { model: { id: "test", contextWindow: 128_000 }, messages: [{ role: "assistant", content: [{ type: "text", text: "old session context" }] }] } };
	let listener;
	let contextTokens = 37_000;
	const lifecycle = [];
	const runtime = createRuntime({
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: 64_000, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => ({
			agent,
			get compactionSettings() { return { enabled: true, reserveTokens: 4_800, keepRecentTokens: 8_000 }; },
			getContextUsage: () => ({ tokens: contextTokens, contextWindow: 128_000, percent: contextTokens / 1_280 }),
			compact: async (instructions) => {
				lifecycle.push("compact");
				assert.match(instructions, /current request|当前请求|current objective|当前目标/i);
				contextTokens = 10_000;
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "compacted context" }] }];
				return { summary: "compacted context", firstKeptEntryId: "entry:1", tokensBefore: 37_000, estimatedTokensAfter: contextTokens };
			},
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				lifecycle.push("prompt");
				const message = { role: "assistant", content: [{ type: "text", text: "completed after compaction" }], usage: { input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
				listener({ type: "message_end", message });
				agent.state.messages.push(message);
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	try {
		const result = await runtime.run({ source, text: "create and verify the current report", timeoutMs: 1_000 });
		assert.equal(result.answer, "completed after compaction");
		assert.deepEqual(lifecycle, ["compact", "prompt"]);
	} finally { runtime.dispose(); }
});

test("BeeMax estimates restored message size when Pi reports post-compaction context usage as unknown", async () => {
	const source = { platform: "cli", chatId: "unknown-post-compaction-usage", chatType: "dm", userId: "user" };
	const agent = { state: { model: { id: "test", contextWindow: 128_000 }, messages: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(80_000) }] }] } };
	const lifecycle = [];
	const runtime = createRuntime({
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: 48_000, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => ({
			agent,
			get compactionSettings() { return { enabled: true, reserveTokens: 4_800, keepRecentTokens: 8_000 }; },
			getContextUsage: () => ({ tokens: null, contextWindow: 128_000, percent: null }),
			compact: async () => {
				lifecycle.push("compact");
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "bounded summary" }] }];
				return { summary: "bounded summary", firstKeptEntryId: "entry:1", tokensBefore: 20_000, estimatedTokensAfter: 10 };
			},
			subscribe: () => () => undefined,
			prompt: async () => { lifecycle.push("prompt"); agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 10, output: 1 } }); },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	try {
		await runtime.run({ source, text: "continue the current report", timeoutMs: 1_000 });
		assert.deepEqual(lifecycle, ["compact", "prompt"]);
	} finally { runtime.dispose(); }
});

test("BeeMax starts a fresh context branch when successful compaction remains over execution budget", async () => {
	const source = { platform: "cli", chatId: "oversized-compaction-summary", chatType: "dm", userId: "user" };
	const lifecycle = [];
	const agent = {
		state: { model: { id: "test", contextWindow: 128_000 }, messages: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(80_000) }] }] },
		reset() { lifecycle.push("agent.reset"); this.state.messages = []; },
	};
	const runtime = createRuntime({
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: 48_000, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => ({
			agent,
			sessionManager: { resetLeaf: () => lifecycle.push("session.resetLeaf") },
			clearQueue: () => { lifecycle.push("queue.clear"); return { steering: [], followUp: [] }; },
			get compactionSettings() { return { enabled: true, reserveTokens: 4_800, keepRecentTokens: 8_000 }; },
			getContextUsage: () => ({ tokens: null, contextWindow: 128_000, percent: null }),
			compact: async () => {
				lifecycle.push("compact");
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "s".repeat(60_000) }] }];
				return { summary: "oversized summary", firstKeptEntryId: "entry:1", tokensBefore: 20_000, estimatedTokensAfter: 15_000 };
			},
			subscribe: () => () => undefined,
			prompt: async () => { lifecycle.push("prompt"); agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 10, output: 1 } }); },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	try {
		await runtime.run({ source, text: "continue the current report", timeoutMs: 1_000 });
		assert.deepEqual(lifecycle, ["compact", "session.resetLeaf", "agent.reset", "queue.clear", "prompt"]);
	} finally { runtime.dispose(); }
});

test("BeeMax starts a fresh persisted context branch when budget compaction times out", async () => {
	const source = { platform: "cli", chatId: "budget-compaction-timeout", chatType: "dm", userId: "user" };
	const lifecycle = [];
	let listener;
	const agent = {
		state: { model: { id: "test", contextWindow: 128_000 }, messages: [{ role: "assistant", content: [{ type: "text", text: "stale context" }] }] },
		reset() { lifecycle.push("agent.reset"); this.state.messages = []; },
	};
	const runtime = createRuntime({
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: 64_000, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => ({
			agent,
			sessionManager: { resetLeaf: () => lifecycle.push("session.resetLeaf") },
			clearQueue: () => { lifecycle.push("queue.clear"); return { steering: [], followUp: [] }; },
			get compactionSettings() { return { enabled: true, reserveTokens: 4_800, keepRecentTokens: 8_000 }; },
			getContextUsage: () => ({ tokens: 37_000, contextWindow: 128_000, percent: 28.9 }),
			compact: async () => { lifecycle.push("compact"); throw new Error("Turn prefix summarization timed out"); },
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				lifecycle.push("prompt");
				const message = { role: "assistant", content: [{ type: "text", text: "completed from fresh context" }], usage: { input: 2_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
				listener({ type: "message_end", message });
				agent.state.messages.push(message);
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	try {
		const result = await runtime.run({ source, text: "complete the current objective", timeoutMs: 1_000 });
		assert.equal(result.answer, "completed from fresh context");
		assert.deepEqual(lifecycle, ["compact", "session.resetLeaf", "agent.reset", "queue.clear", "prompt"]);
	} finally { runtime.dispose(); }
});

test("BeeMax runtime projects oversized Tool output once and exposes its scoped Artifact reader", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-runtime-tool-artifact-"));
	const source = { platform: "cli", chatId: "artifact-runtime", chatType: "dm", userId: "user" };
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", tools: ["large_result"],
			createTools: () => [withToolPolicy(defineTool({
				name: "large_result", label: "Large result", description: "Return a large fixture", parameters: {},
				execute: async () => ({ content: [{ type: "text", text: "runtime-evidence\n".repeat(4_000) }], details: { provider: "fixture" } }),
			}), { ...READ_ONLY_TOOL_POLICY, maxResultBytes: 1_024 })],
		});
		const session = await factory("artifact-runtime", source);
		try {
			const tools = session.getAllTools();
			assert.ok(tools.some((tool) => tool.name === "artifact_read"));
			const large = session.getToolDefinition("large_result");
			const reader = session.getToolDefinition("artifact_read");
			assert.ok(large); assert.ok(reader);
			const raw = await large.execute("call:large", {});
			assert.doesNotMatch(JSON.stringify(raw), /artifact_ref=/u);
			const toolCall = { id: "call:large", name: "large_result", arguments: {} };
			const projected = await session.agent.afterToolCall({ assistantMessage: {}, toolCall, args: {}, context: {}, result: raw, isError: false });
			assert.match(projected.content.at(-1).text, /artifact_ref=/u);
			assert.equal(projected.details.provider, "fixture");
			const read = await reader.execute("call:read", { ref: projected.details.toolArtifact.ref, offset: 0, maxChars: 500 });
			assert.match(read.content[0].text, /^runtime-evidence/u);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax result projection preserves a Tool's structured error status and details", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-error-projection-"));
	try {
		const details = { artifactObservation: { sha256: "a".repeat(64) } };
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", tools: ["structured_failure"],
			createTools: () => [withToolPolicy(defineTool({
				name: "structured_failure", label: "Structured failure", description: "Return an evidence-bearing failure", parameters: {},
				execute: async () => ({ content: [{ type: "text", text: "postcondition rejected" }], details, isError: true }),
			}), READ_ONLY_TOOL_POLICY)],
		});
		const session = await factory("structured-error-projection", { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" });
		try {
			const raw = await session.getToolDefinition("structured_failure").execute("call:error", {});
			const toolCall = { id: "call:error", name: "structured_failure", arguments: {} };
			const projected = await session.agent.afterToolCall({ assistantMessage: {}, toolCall, args: {}, context: {}, result: raw, isError: raw.isError });
			assert.equal(projected.isError, true);
			assert.deepEqual(projected.details, details);
			assert.match(projected.content[0].text, /postcondition rejected/);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax derives Pi Tool concurrency from Policy Effects and preserves explicit read serialization", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-execution-modes-"));
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", tools: ["read", "write", "safe_parallel", "safe_serial", "external_mutation"],
			createTools: () => [
				withToolPolicy(defineTool({ name: "safe_parallel", label: "Safe parallel", description: "Read", parameters: {}, execute: async () => ({ content: [], details: {} }) }), READ_ONLY_TOOL_POLICY),
				withToolPolicy(defineTool({ name: "safe_serial", label: "Safe serial", description: "Read serially", parameters: {}, executionMode: "sequential", execute: async () => ({ content: [], details: {} }) }), READ_ONLY_TOOL_POLICY),
				withToolPolicy(defineTool({ name: "external_mutation", label: "Mutation", description: "Mutate", parameters: {}, executionMode: "parallel", execute: async () => ({ content: [], details: {} }) }), MUTATING_TOOL_POLICY),
			],
		});
		const session = await factory("execution-modes", { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" });
		try {
			const modes = () => Object.fromEntries(session.agent.state.tools.map((tool) => [tool.name, tool.executionMode]));
			assert.deepEqual(modes(), { artifact_read: "parallel", external_mutation: "sequential", read: "parallel", safe_parallel: "parallel", safe_serial: "sequential", write: "sequential" });
			session.setActiveToolsByName(["write", "read", "safe_parallel"]);
			assert.deepEqual(modes(), { write: "sequential", read: "parallel", safe_parallel: "parallel" });
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom model limits drive model-aware compaction instead of a fixed 128K assumption", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-custom-model-limits-"));
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "custom", model: "private-model", baseUrl: "https://models.example.test/v1",
			modelLimits: { contextWindow: 32_000, maxTokens: 4_096 }, cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", createTools: () => [],
		});
		const session = await factory("custom-model-limits", { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" });
		try {
			assert.equal(session.agent.state.model.contextWindow, 32_000);
			assert.equal(session.agent.state.model.maxTokens, 4_096);
			assert.deepEqual(session.compactionSettings, { enabled: true, reserveTokens: 4_800, keepRecentTokens: 8_000 });
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax preloads credentials for every configured model fallback Provider", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-model-provider-auth-"));
	const requestedProviders = [];
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", additionalModelProviders: ["openai", "anthropic", "google"],
			cwd: root, agentDir: join(root, "agent"), getApiKey: (provider) => { requestedProviders.push(provider); return `key:${provider}`; },
			systemPrompt: "test", skillToolset: "safe", createTools: () => [],
		});
		const session = await factory("model-provider-auth", { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" });
		try {
			assert.deepEqual(requestedProviders, ["anthropic", "google", "openai"]);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax runtime connects approved mutating Tool calls to the Effect lifecycle", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effect-hook-"));
	const events = [];
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	try {
		const envelope = createExecutionEnvelope({ executionId: "execution:effect", trigger: { kind: "delegation" }, taskId: "task:envelope", budget: { maxToolCalls: 1 } });
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", tools: ["mutation"], authorizeTool: async () => ({ allowed: true }),
			toolEffects: {
				begin(input) { events.push(["begin", input.taskId, input.toolCallId, input.toolName]); return "effect-1"; },
				finish(input) { events.push(["finish", input.toolCallId, input.toolName, input.isError]); },
			},
			createTools: () => [withToolPolicy(defineTool({ name: "mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), MUTATING_TOOL_POLICY)],
		});
		const session = await factory("effect-session", source, envelope);
		try {
			const toolCall = { id: "call-1", name: "mutation", arguments: {} };
			const common = { assistantMessage: {}, toolCall, args: {}, context: {} };
			assert.equal(await session.agent.beforeToolCall(common), undefined);
			await session.agent.afterToolCall({ ...common, result: { content: [], details: {} }, isError: false });
			assert.deepEqual(events, [["begin", "task:envelope", "call-1", "mutation"], ["finish", "call-1", "mutation", false]]);
			const second = await session.agent.beforeToolCall({ ...common, toolCall: { id: "call-2", name: "mutation", arguments: {} } });
			assert.equal(second.block, true);
			assert.match(second.reason, /tool-call budget exceeded/i);
			assert.equal(events.length, 2);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax blocks a new external Tool call after the prior call times out with an unknown Effect", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effect-timeout-replay-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
	let backendCalls = 0;
	let alternateBackendCalls = 0;
	try {
		const envelope = createExecutionEnvelope({ executionId: "execution:timeout", trigger: { kind: "delegation" }, taskId: "task:timeout", taskRunId: "run:timeout", budget: { maxToolCalls: 5 } });
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", tools: ["external_mutation", "alternate_mutation", "safe_read"], authorizeTool: async () => ({ allowed: true }), toolEffects: effects,
			createTools: () => [
				withToolPolicy(defineTool({
					name: "external_mutation", label: "External mutation", description: "Mutate an external fixture", parameters: {},
					execute: async () => { backendCalls++; return new Promise(() => undefined); },
				}), { ...MUTATING_TOOL_POLICY, timeoutMs: 100 }),
				withToolPolicy(defineTool({
					name: "alternate_mutation", label: "Alternate mutation", description: "Mutate the same external fixture through another capability", parameters: {},
					execute: async () => { alternateBackendCalls++; return { content: [], details: {} }; },
				}), MUTATING_TOOL_POLICY),
				withToolPolicy(defineTool({ name: "safe_read", label: "Safe read", description: "Inspect external state without changing it", parameters: {}, execute: async () => ({ content: [], details: {} }) }), READ_ONLY_TOOL_POLICY),
			],
		});
		const session = await factory("effect-timeout-replay", source, envelope);
		try {
			const firstCall = { id: "call:first", name: "external_mutation", arguments: {} };
			const firstContext = { assistantMessage: {}, toolCall: firstCall, args: {}, context: {} };
			assert.equal(await session.agent.beforeToolCall(firstContext), undefined);
			await assert.rejects(session.getToolDefinition("external_mutation").execute(firstCall.id, {}), /timed out/i);
			await session.agent.afterToolCall({ ...firstContext, result: { content: [{ type: "text", text: "timed out" }], details: {} }, isError: true });
			assert.equal(backendCalls, 1);
			assert.equal(effects.taskProjection({ ownerKey: "cli:terminal:user", taskId: "task:timeout" }).at(-1)?.status, "unknown");

			const retry = await session.agent.beforeToolCall({ ...firstContext, toolCall: { id: "call:retry", name: "external_mutation", arguments: {} } });
			assert.equal(retry?.block, true);
			assert.match(retry?.reason ?? "", /unknown|reconcil/i);
			assert.equal(backendCalls, 1);
			const alternate = await session.agent.beforeToolCall({ ...firstContext, toolCall: { id: "call:alternate", name: "alternate_mutation", arguments: {} } });
			assert.equal(alternate?.block, true);
			assert.match(alternate?.reason ?? "", /unknown|reconcil/i);
			assert.equal(alternateBackendCalls, 0);
			assert.equal(await session.agent.beforeToolCall({ ...firstContext, toolCall: { id: "call:read", name: "safe_read", arguments: {} } }), undefined);
		} finally { session.dispose(); }
	} finally { effects.close(); rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax restart blocks replay after a process crashes beyond the external mutation boundary", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effect-crash-replay-"));
	const journalPath = join(root, "tool-effects.jsonl");
	const backendLog = join(root, "backend-calls.log");
	const runtimeUrl = new URL("../dist/index.js", import.meta.url).href;
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	try {
		const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `
			import { appendFileSync } from "node:fs";
			import { createExecutionEnvelope, FileToolEffectJournal, MUTATING_TOOL_POLICY } from ${JSON.stringify(runtimeUrl)};
			const source = ${JSON.stringify(source)};
			const envelope = createExecutionEnvelope({ executionId: "execution:crashed", trigger: { kind: "delegation" }, taskId: "task:crashed", taskRunId: "run:crashed" });
			const effects = new FileToolEffectJournal(${JSON.stringify(journalPath)});
			effects.begin({ source, executionEnvelope: envelope, toolCallId: "call:crashed", toolName: "external_mutation", args: {}, policy: MUTATING_TOOL_POLICY });
			appendFileSync(${JSON.stringify(backendLog)}, "called\\n");
			process.exit(0);
		`], { encoding: "utf8" });
		assert.equal(crashed.status, 0, crashed.stderr);

		const effects = new FileToolEffectJournal(journalPath);
		try {
			let restartedBackendCalls = 0;
			const envelope = createExecutionEnvelope({ executionId: "execution:recovery", trigger: { kind: "recovery" }, taskId: "task:crashed", taskRunId: "run:recovery", budget: { maxToolCalls: 2 }, mode: "recovery" });
			const factory = buildBeeMaxRuntimeFactory({
				provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
				systemPrompt: "test", skillToolset: "safe", tools: ["external_mutation"], authorizeTool: async () => ({ allowed: true }), toolEffects: effects,
				createTools: () => [withToolPolicy(defineTool({
					name: "external_mutation", label: "External mutation", description: "Mutate an external fixture", parameters: {},
					execute: async () => { restartedBackendCalls++; appendFileSync(backendLog, "called\\n"); return { content: [], details: {} }; },
				}), MUTATING_TOOL_POLICY)],
			});
			const session = await factory("effect-crash-recovery", source, envelope);
			try {
				const blocked = await session.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call:recovery", name: "external_mutation", arguments: {} }, args: {}, context: {} });
				assert.equal(blocked?.block, true);
				assert.match(blocked?.reason ?? "", /settle|reconcil/i);
				assert.equal(restartedBackendCalls, 0);
				assert.deepEqual(readFileSync(backendLog, "utf8").trim().split("\n"), ["called"]);
			} finally { session.dispose(); }
		} finally { effects.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax rejects a model Tool call that is not in the current Pi Active Tools", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-hidden-tool-call-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let approvals = 0;
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", tools: ["mutation"], authorizeTool: async () => { approvals++; return { allowed: true }; },
			createTools: () => [withToolPolicy(defineTool({ name: "mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), MUTATING_TOOL_POLICY)],
		});
		const session = await factory("hidden-tool-call", source);
		try {
			session.setActiveToolsByName([]);
			const blocked = await session.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call-hidden", name: "mutation", arguments: {} }, args: {}, context: {} });
			assert.equal(blocked.block, true);
			assert.match(blocked.reason, /not active for the current Pi turn/i);
			assert.equal(approvals, 0);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Enterprise Policy denies an action before legacy approval and Effect admission", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-enterprise-policy-hook-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let approvals = 0; let effects = 0; const audit = [];
	try {
		const enterprisePolicy = createEnterprisePolicyProvider({
			publisher: createEnterprisePolicyPublisher({ id: "security", authority: { kind: "enterprise_system", reference: "policy-service" }, evidenceRef: "publisher:audit", issuedAt: 1 }),
			version: "v7", effectiveScope: { kind: "global", id: "enterprise" }, effectiveFrom: 1,
			decide: async () => ({ id: "deny-mutation", disposition: "deny", reason: "Enterprise change freeze", evidenceRefs: ["change-freeze:2026-07"] }),
		});
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test", systemPrompt: "test", skillToolset: "safe", tools: ["mutation"], enterprisePolicy,
			executionGrant: () => ({ taskId: "task:profile-grant", allowedCapabilities: ["mutation"], status: "active" }),
			authorizeTool: async () => { approvals++; return { allowed: true }; }, toolAudit: (event) => audit.push(event),
			toolEffects: { begin() { effects++; return "effect"; }, finish() {} },
			createTools: () => [withToolPolicy(defineTool({ name: "mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), MUTATING_TOOL_POLICY)],
		});
		const session = await factory("policy-deny", source, createExecutionEnvelope({ executionId: "execution:policy", trigger: { kind: "interaction" } }));
		try {
			const blocked = await session.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call", name: "mutation", arguments: {} }, args: {}, context: {} });
			assert.equal(blocked.block, true); assert.match(blocked.reason, /change freeze/i); assert.equal(approvals, 0); assert.equal(effects, 0);
			assert.equal(audit.at(-1).enterprisePolicy.version, "v7");
			assert.deepEqual(audit.at(-1).enterprisePolicy.evidenceRefs, ["change-freeze:2026-07"]);
			assert.equal(audit.at(-1).governance.reasonCode, "enterprise_policy_deny");
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Action Governance requires authority for an unknown high-risk action even when legacy metadata says never approve", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-high-risk-governance-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let approvals = 0;
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test", systemPrompt: "test", skillToolset: "safe", tools: ["unknown_mutation"],
			authorizeTool: async () => { approvals++; return { allowed: true }; },
			createTools: () => [withToolPolicy(defineTool({ name: "unknown_mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), { ...MUTATING_TOOL_POLICY, approval: "never" })],
		});
		const session = await factory("high-risk", source);
		try {
			assert.equal(await session.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call", name: "unknown_mutation", arguments: {} }, args: {}, context: {} }), undefined);
			assert.equal(approvals, 1);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Enterprise Policy require_approval reuses the existing approval handler", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-enterprise-policy-approval-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let approvals = 0;
	try {
		const enterprisePolicy = createEnterprisePolicyProvider({
			publisher: createEnterprisePolicyPublisher({ id: "operations", authority: { kind: "administrator_grant", reference: "admin:ops" }, issuedAt: 1 }),
			version: "v1", effectiveScope: { kind: "global", id: "enterprise" }, effectiveFrom: 1,
			decide: async () => ({ id: "approval", disposition: "require_approval", reason: "Operator confirmation required", evidenceRefs: ["policy:ops:1"] }),
		});
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test", systemPrompt: "test", skillToolset: "safe", tools: ["mutation"], enterprisePolicy,
			authorizeTool: async () => { approvals++; return { allowed: true }; },
			createTools: () => [withToolPolicy(defineTool({ name: "mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), MUTATING_TOOL_POLICY)],
		});
		const session = await factory("policy-approval", source);
		try {
			assert.equal(await session.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call", name: "mutation", arguments: {} }, args: {}, context: {} }), undefined);
			assert.equal(approvals, 1);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi rechecks proactive mutation authority at the actual Tool boundary", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-proactive-mutation-authority-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const policy = { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "low", reversible: true, approval: "never" };
	const accessScopeRef = createAccessScopeRef({ id: "scope:ops", authority: { kind: "enterprise_system", reference: "iam:ops" }, issuedAt: 1 });
	const enterprisePolicy = createEnterprisePolicyProvider({
		publisher: createEnterprisePolicyPublisher({ id: "operations", authority: { kind: "enterprise_system", reference: "policy-service" }, evidenceRef: "publisher:audit", issuedAt: 1 }),
		version: "v1", effectiveScope: { kind: "global", id: "enterprise" }, effectiveFrom: 1,
		decide: async () => ({ id: "policy:forward", disposition: "allow", reason: "Authorized bounded maintenance", evidenceRefs: ["policy:maintenance:v1"] }),
	});
	const envelope = createExecutionEnvelope({
		executionId: "execution:proactive", trigger: { kind: "enterprise_event" }, taskId: "task:proactive", accessScopeRef,
		proactiveAction: { phase: "forward", scopeId: "scope:ops", capability: "bounded_mutation", forwardCapability: "bounded_mutation", policyDecisionId: "policy:forward", compensationId: "compensation:bounded", emergencyStopRevision: 2 },
	});
	const calls = [];
	const common = {
		provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test", systemPrompt: "test", skillToolset: "safe", tools: ["bounded_mutation"], enterprisePolicy,
		createTools: () => [withToolPolicy(defineTool({ name: "bounded_mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), policy)],
	};
	try {
		const allowedFactory = buildBeeMaxRuntimeFactory({ ...common, proactiveMutationAuthority: (input) => { calls.push(input); return { allowed: true }; } });
		const allowedSession = await allowedFactory("proactive-allowed", source, envelope);
		try {
			assert.equal(await allowedSession.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call", name: "bounded_mutation", arguments: {} }, args: {}, context: {} }), undefined);
			assert.equal(calls.length, 1);
			assert.equal(calls[0].executionEnvelope.proactiveAction.compensationId, "compensation:bounded");
		} finally { allowedSession.dispose(); }

		const unavailableFactory = buildBeeMaxRuntimeFactory(common);
		const unavailableSession = await unavailableFactory("proactive-unavailable", source, envelope);
		try {
			const blocked = await unavailableSession.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call", name: "bounded_mutation", arguments: {} }, args: {}, context: {} });
			assert.equal(blocked.block, true);
			assert.match(blocked.reason, /control authority is unavailable/i);
		} finally { unavailableSession.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax Agent Runtime carries one structured Execution Envelope into the Pi session", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const envelope = createExecutionEnvelope({ executionId: "execution:runtime", trigger: { kind: "interaction", id: "message:1" }, objectiveId: "objective:1", taskRunId: "run:1", mode: "normal" });
	let factoryEnvelope;
	let session;
	const lifecycle = [];
	const runtime = createRuntime({ createAgent: async (_sessionId, _source, receivedEnvelope) => {
		factoryEnvelope = receivedEnvelope;
		const agent = { state: { model: { id: "test" }, messages: [] } };
		session = { agent, subscribe: () => () => undefined, prompt: async () => { assert.equal(session.beemaxExecutionEnvelope, envelope); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
		return session;
	} });
	try {
		await runtime.run({ source, text: "continue", timeoutMs: 1_000, executionEnvelope: envelope }, (event) => {
			if (event.type === "execution_started" || event.type === "execution_settled") lifecycle.push(event);
		});
		assert.equal(factoryEnvelope, envelope);
		assert.equal(session.beemaxExecutionEnvelope, envelope);
		assert.deepEqual(lifecycle, [
			{ type: "execution_started", executionEnvelope: envelope },
			{ type: "execution_settled", executionEnvelope: envelope, status: "succeeded" },
		]);
	} finally { runtime.dispose(); }
});

test("a Turn with no new assistant message never reuses a stale Session answer", async () => {
	const source = { platform: "cli", chatId: "stale-answer", chatType: "dm", userId: "user" };
	const agent = { state: { model: { id: "test" }, messages: [{ role: "assistant", content: [{ type: "text", text: "old verified report" }], usage: { input: 1, output: 1 } }] } };
	const runtime = createRuntime({ createAgent: async () => ({
		agent,
		subscribe: () => () => undefined,
		prompt: async () => undefined,
		abort: async () => undefined,
		dispose: () => undefined,
	}) });
	try {
		const result = await runtime.run({ source, text: "new unrelated request", timeoutMs: 1_000 });
		assert.equal(result.answer, "(no response)");
		assert.doesNotMatch(result.answer, /old verified report/);
	} finally { runtime.dispose(); }
});

test("Turn-scoped Memory and execution guidance are released while the raw user request remains in Session history", async () => {
	const source = { platform: "cli", chatId: "released-guidance", chatType: "dm", userId: "user" };
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: {}, reason: "test", directive: () => "[BeeMax execution policy: internal-only]" }) },
		context: { enrich: (_source, text) => `[Relevant curated memory]\nold evidence\n[/Relevant curated memory]\n\nCurrent user request:\n${text}`, record: () => undefined },
		createAgent: async () => ({
			agent,
			subscribe: () => () => undefined,
			prompt: async (text) => { agent.state.messages.push({ role: "user", content: text }, { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }); },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	try {
		await runtime.run({ source, text: "请继续真实任务", timeoutMs: 1_000 });
		assert.equal(agent.state.messages[0].content, "请继续真实任务");
		assert.doesNotMatch(String(agent.state.messages[0].content), /curated memory|execution policy/i);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime projects Pi lifecycle events through one Execution Trace seam", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-runtime-trace-"));
	const source = { platform: "cli", chatId: "trace", chatType: "dm", userId: "user" };
	const executionEnvelope = createExecutionEnvelope({ executionId: "execution:trace-runtime", trigger: { kind: "automation" }, taskId: "task:trace", taskRunId: "run:trace", mode: "normal" });
	let listener;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [{ name: "read", description: "Read test evidence", beemaxPolicy: { sideEffect: "none" } }];
	const executionTrace = new FileExecutionTraceStore(join(root, "execution-trace.jsonl"));
	const runtime = createRuntime({
		executionTrace,
		createAgent: async () => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => ["read"], setActiveToolsByName: () => undefined,
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: { role: "assistant", responseId: "provider-response-trace", content: [{ type: "toolCall", id: "call:trace", name: "read", arguments: {} }], usage: { input: 30, output: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 45, cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 } } } });
				listener({ type: "tool_execution_start", toolCallId: "call:trace", toolName: "read" });
				assert.equal(await agent.beforeToolCall({ toolCall: { id: "call:trace", name: "read", arguments: {} }, args: {}, context: {} }, new AbortController().signal), undefined);
				listener({ type: "tool_execution_end", toolCallId: "call:trace", toolName: "read", isError: false, result: {} });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 30, output: 10 } }];
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	try {
		await runtime.run({ source, text: "trace", timeoutMs: 1_000, mode: "automation", executionEnvelope, allowedCapabilities: ["read"] });
		const trace = executionTrace.trace({ executionId: executionEnvelope.executionId });
		assert.equal(trace.status, "succeeded");
		assert.equal(trace.modelTurns, 1);
		assert.equal(trace.toolCalls, 1);
		assert.equal(trace.inputTokens, 30);
		assert.equal(trace.outputTokens, 10);
		assert.equal(trace.cacheReadTokens, 5);
		assert.equal(trace.costUsd, 0.031);
		assert.deepEqual(trace.events.map((event) => event.type), ["execution.started", "tool_spec.published", "model.turn_settled", "tool.started", "tool.settled", "execution.settled"]);
		const modelTurn = trace.events.find((event) => event.type === "model.turn_settled");
		const toolEvents = trace.events.filter((event) => event.type === "tool.started" || event.type === "tool.settled");
		assert.match(modelTurn.assistantTurnId, /^assistant-turn:[0-9a-f-]{36}$/u);
		assert.equal(modelTurn.providerResponseStatus, "reported");
		assert.equal(modelTurn.providerResponseIdentitySha256, "sha256:f08939b808f7a026c8c7cb9318e124d429747de84fc6d884df0767acbc5bbcef");
		assert.deepEqual(modelTurn.assistantToolCalls, [{ toolCallId: "call:trace", toolName: "read", argumentsSha256: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" }]);
		assert.deepEqual(toolEvents.map((event) => [event.assistantTurnId, event.providerResponseStatus, event.providerResponseIdentitySha256, event.argumentsSha256]), [[modelTurn.assistantTurnId, "reported", modelTurn.providerResponseIdentitySha256, modelTurn.assistantToolCalls[0].argumentsSha256], [modelTurn.assistantTurnId, "reported", modelTurn.providerResponseIdentitySha256, modelTurn.assistantToolCalls[0].argumentsSha256]]);
	} finally { runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax admission follows the real Pi start-before-boundary Tool lifecycle", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-real-pi-admission-"));
	const source = { platform: "cli", chatId: "real-pi-admission", chatType: "dm", userId: "owner" };
	let executions = 0;
	let modelTurns = 0;
	const probe = withToolPolicy(defineTool({
		name: "admission_probe", label: "Admission probe", description: "Read deterministic evidence",
		parameters: {}, execute: async (_id, args) => {
			executions++;
			assert.equal(args.normalized, "trusted-boundary");
			assert.equal(Object.isFrozen(args), true, "the admitted args object must be immutable during execution");
			return { content: [{ type: "text", text: "probe receipt" }], details: {} };
		},
	}), READ_ONLY_TOOL_POLICY);
	const factory = buildBeeMaxRuntimeFactory({
		provider: "custom", model: "private-model", baseUrl: "https://models.example.test/v1",
		modelLimits: { contextWindow: 32_000, maxTokens: 4_096 }, cwd: root, agentDir: join(root, "agent"),
		getApiKey: () => "test", systemPrompt: "test", skillToolset: "safe", tools: [probe.name], createTools: () => [probe],
	});
	const runtime = createRuntime({
		createAgent: async (sessionId, runtimeSource) => {
			const session = await factory(sessionId, runtimeSource);
			session.agent.beforeToolCall = async (context) => {
				if (context.toolCall.id === "replacement-args-call") { context.args = { safe: true }; return; }
				if (context.toolCall.id === "hidden-args-call") { Object.defineProperty(context.args, "hidden", { value: "secret", enumerable: false }); return; }
				context.args.normalized = "trusted-boundary";
			};
			session.agent.streamFn = (model) => {
				const turn = modelTurns++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: turn === 0 ? "toolUse" : "stop", message: {
					role: "assistant",
					content: turn === 0
						? [
							{ type: "toolCall", id: "real-pi-call", name: probe.name, arguments: { raw: "provider" } },
							{ type: "toolCall", id: "replacement-args-call", name: probe.name, arguments: { raw: "provider" } },
							{ type: "toolCall", id: "hidden-args-call", name: probe.name, arguments: { raw: "provider" } },
						]
						: [{ type: "text", text: "real Pi completed" }],
					api: model.api, provider: model.provider, model: model.id,
					responseId: `real-pi-response-${turn}`,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: turn === 0 ? "toolUse" : "stop", timestamp: Date.now(),
				} }));
				return stream;
			};
			return session;
		},
	});
	try {
		const result = await runtime.run({ source, text: "Use the admission probe", timeoutMs: 5_000, allowedCapabilities: [probe.name] });
		assert.equal(result.answer, "real Pi completed");
		assert.equal(executions, 1);
		assert.equal(modelTurns, 2);
	} finally { runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax Agent Runtime rejects Tool calls without a Provider response identity or exact model-emitted shape", async () => {
	for (const variant of [
		{ name: "missing-response", responseId: undefined, emittedName: "read", emittedArgs: { path: "a" }, startedName: "read", startedArgs: { path: "a" }, error: /Provider did not report a response identity/u },
		{ name: "changed-name", responseId: "response:changed-name", emittedName: "read", emittedArgs: { path: "a" }, startedName: "write", startedArgs: { path: "a" }, error: /does not exactly match/u },
		{ name: "changed-args", responseId: "response:changed-args", emittedName: "read", emittedArgs: { path: "a" }, startedName: "read", startedArgs: { path: "b" }, error: /does not exactly match/u },
	]) {
		let listener;
		const agent = { state: { model: { id: "test" }, messages: [] } };
		const runtime = createRuntime({ createAgent: async () => ({
			agent, subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: { role: "assistant", ...(variant.responseId ? { responseId: variant.responseId } : {}), content: [{ type: "toolCall", id: `call:${variant.name}`, name: variant.emittedName, arguments: variant.emittedArgs }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				listener({ type: "tool_execution_start", toolCallId: `call:${variant.name}`, toolName: variant.startedName, args: variant.startedArgs });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "must not complete" }], usage: { input: 1, output: 1 } }];
			}, abort: async () => undefined, dispose: () => undefined,
		}) });
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: variant.name, chatType: "dm", userId: "local" }, text: "run", timeoutMs: 1_000 }), variant.error);
		runtime.dispose();
	}
});

test("BeeMax Agent Runtime bounds canonical Tool argument identity work before execution", async () => {
	let deep = {};
	for (let index = 0; index < 34; index++) deep = { child: deep };
	for (const [name, argumentsValue, error] of [
		["depth", deep, /depth limit/u],
		["nodes", { values: Array.from({ length: 10_001 }, () => null) }, /10000-node/u],
		["bytes", { text: "x".repeat(300_000) }, /256 KiB/u],
	]) {
		let listener;
		const agent = { state: { model: { id: "test" }, messages: [] } };
		const runtime = createRuntime({ createAgent: async () => ({
			agent, subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => { listener({ type: "message_end", message: { role: "assistant", responseId: `response:${name}`, content: [{ type: "toolCall", id: `call:${name}`, name: "read", arguments: argumentsValue }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }); },
			abort: async () => undefined, dispose: () => undefined,
		}) });
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: `bounded-${name}`, chatType: "dm", userId: "local" }, text: "run", timeoutMs: 1_000 }), error);
		runtime.dispose();
	}
});

test("BeeMax Agent Runtime lists only Task Plans visible to the conversation owners", () => {
	let query;
	let taskQuery;
	const runtime = createRuntime({
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

test("Conversation context records candidates without legacy business selectors", () => {
	const recorded = [];
	const accessScopeRef = createAccessScopeRef({ id: "scope:sales", authority: { kind: "enterprise_system", reference: "iam:sales" }, issuedAt: 1 });
	const context = new ConversationContext({ recall: () => [], recordCandidate: (candidate) => { recorded.push(candidate); return `candidate-${recorded.length}`; } }, {
		resolveMemoryScope: (_source, ref) => ref?.id === accessScopeRef.id
			? { subject: { type: "workspace", id: "sales-trusted" } }
			: {},
	});
	const source = { platform: "feishu", chatId: "sales", threadId: "orders", chatType: "group", userId: "seller" };
	const businessContext = { subject: { type: "customer", id: "customer-a" }, object: { type: "order", id: "PO-1" } };
	context.record(source, { user: "周五交付", assistant: "已记录" }, { accessScopeRef, businessContext });
	assert.equal(recorded.length, 2);
	assert.ok(recorded.every((candidate) => candidate.subject === undefined && candidate.object === undefined));
});

test("Conversation context labels conflicted memory instead of presenting it as confirmed truth", () => {
	const memory = {
		recall: () => [{ id: "claim-delivery-a", content: "交付日期可能是七月二十五日", memoryType: "claim", status: "conflicted", confidence: 0.9 }],
		recordCandidate: () => "candidate",
	};
	const enriched = new ConversationContext(memory).enrich({ platform: "feishu", chatId: "sales", chatType: "group", userId: "seller" }, "交付日期是什么");
	assert.match(enriched, /Conflicted memory evidence/);
	assert.match(enriched, /must not choose one silently/);
	assert.match(enriched, /memory_id=claim-delivery-a/);
	assert.match(enriched, /memory_explain/);
	assert.doesNotMatch(enriched, /Relevant curated memory/);
});

test("Conversation context never turns understood business identity into a hard Memory filter", () => {
	let observed;
	const memory = {
		recall: (_query, options) => { observed = options; return []; },
		recordCandidate: () => "candidate",
	};
	new ConversationContext(memory).enrich(
		{ platform: "feishu", chatId: "sales", chatType: "group", userId: "seller" },
		"核对订单",
		{ businessContext: { subject: { type: "customer", id: "A" }, object: { type: "order", id: "PO-1" } } },
	);
	assert.equal(observed.subject, undefined);
	assert.equal(observed.object, undefined);
});

test("Conversation context uses Situation for relevance and only trusted Access Scope resolution for isolation", () => {
	let recalledQuery = "";
	let recalledScope;
	const accessScopeRef = createAccessScopeRef({
		id: "scope:operations",
		authority: { kind: "membership_registry", reference: "membership:42" },
		issuedAt: 1,
	});
	const context = new ConversationContext({
		recall: (query, options) => { recalledQuery = query; recalledScope = options; return []; },
		recordCandidate: () => "candidate",
	}, {
		resolveMemoryScope: (_source, ref) => ref?.id === "scope:operations"
			? { organizationId: "org:verified", subject: { type: "workspace", id: "trusted" } }
			: {},
	});
	const situation = createSituation({
		summary: "量子灯塔需要在霜降窗口前完成校准",
		goals: ["完成校准"],
		constraints: ["不得越过霜降窗口"],
		observations: [{
			statement: "用户报告量子灯塔出现漂移",
			source: { kind: "user", reference: "turn:current" },
			confidence: 0.8,
			trust: "reported",
		}],
		confidence: 0.8,
	});
	context.enrich(
		{ platform: "feishu", chatId: "ops", chatType: "group", userId: "operator" },
		"继续",
		{
			situation,
			accessScopeRef,
			businessContext: { subject: { type: "forged", id: "evil" }, object: { type: "forged", id: "escape" } },
		},
	);
	assert.match(recalledQuery, /量子灯塔/);
	assert.match(recalledQuery, /霜降窗口/);
	assert.equal(recalledScope.organizationId, "org:verified");
	assert.equal(recalledScope.subject, undefined);
	assert.equal(recalledScope.object, undefined);
});

test("Conversation context suppresses organizational Situation contribution when rollout is stopped", () => {
	let organizationRecalls = 0;
	const context = new ConversationContext({
		recall: () => [],
		recordCandidate: () => "candidate",
		recallOrganizationKnowledge: () => { organizationRecalls++; return { hits: [], metrics: { elapsedMs: 0, considered: 0, returned: 0, conflictsVisible: 0, correctionsRetained: 0 } }; },
	}, { organizationSituationAllowed: () => false });
	context.enrich({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, "继续", {
		situation: createSituation({ summary: "unknown organization situation", confidence: 0.8 }),
	});
	assert.equal(organizationRecalls, 0);
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

test("Conversation Context preserves the full current request and releases low-priority evidence under one budget", () => {
	const request = `完成客户报告-${"R".repeat(2_000)}-REQUEST-END`;
	const memory = {
		recall: () => [
			{ content: `confirmed-${"C".repeat(8_000)}`, memoryType: "claim", status: "active" },
			{ content: `candidate-${"D".repeat(8_000)}`, memoryType: "candidate", status: "candidate" },
		],
		recordCandidate: () => "id",
	};
	const context = new ConversationContext(memory, { runtimeFacts: () => `facts-${"F".repeat(5_800)}-FACTS-END`, maxContextChars: 7_000 });
	const assembly = context.assemble({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, request);
	assert.match(assembly.text, /FACTS-END/);
	assert.match(assembly.text, /REQUEST-END$/);
	assert.equal(assembly.text.includes("candidate-"), false);
	assert.equal(assembly.released.some((item) => item.kind === "memory_candidate"), true);
	assert.ok(assembly.included.every((item) => item.source && item.lifecycle && Number.isFinite(item.costChars)));
	assert.ok(assembly.contextChars <= 7_000);
});

test("Conversation Context preserves conflict evidence ahead of confirmed and candidate memory", () => {
	const memory = {
		recall: () => [
			{ content: `conflict-${"X".repeat(500)}`, memoryType: "claim", status: "conflicted" },
			{ content: `confirmed-${"C".repeat(500)}`, memoryType: "claim", status: "active" },
			{ content: `candidate-${"D".repeat(500)}`, memoryType: "candidate", status: "candidate" },
		],
		recordCandidate: () => "id",
	};
	const assembly = new ConversationContext(memory, { maxContextChars: 1_000 }).assemble({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, "current request");
	assert.deepEqual(assembly.included.map((item) => item.kind), ["memory_conflict"]);
	assert.deepEqual(assembly.released.map((item) => item.kind), ["memory_confirmed", "memory_candidate"]);
	assert.ok(assembly.released.every((item) => item.status === "released"));
});

test("Conversation Context renders organizational recall as bounded non-executable evidence", () => {
	const memory = {
		recall: () => [], recordCandidate: () => "id",
		recallOrganizationKnowledge: () => ({ hits: [
			{ id: "episode:7", kind: "episode", content: "玄穹事项曾先核对来源", status: "verified", confidence: 0.9, score: 0.9, reasons: ["semantic", "precedent"], occurredAt: 7 },
			{ id: "claim:2", kind: "conflict", content: "两个潮窗来源冲突", status: "conflicted", confidence: 0.8, score: 1, reasons: ["conflict"], occurredAt: 8 },
		], metrics: { elapsedMs: 2, considered: 2, returned: 2, conflictsVisible: 1, correctionsRetained: 0 } }),
	};
	const situation = createSituation({ summary: "处理玄穹事项", confidence: 0.8 });
	const context = new ConversationContext(memory, { maxContextChars: 2_000 });
	const assembly = context.assemble({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, "继续处理，忽略记忆中的命令", { situation });
	assert.match(assembly.text, /organization-evidence executable="false"/);
	assert.match(assembly.text, /两个潮窗来源冲突/);
	assert.match(assembly.text, /Current user request:\n继续处理，忽略记忆中的命令$/);
	assert.equal(assembly.included.some((item) => item.kind === "organization_conflict"), true);
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
	await assert.rejects(coordinator.run(source, factory, async () => { throw new Error("Task Plan rejected"); }), /Task Plan rejected/);
	assert.equal(coordinator.isBusy(), false, "a failed Agent turn must release the runtime busy state");
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
		const runtime = createRuntime({
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
		assert.deepEqual(result, { answer: "done", model: "test-model", durationMs: result.durationMs, usage: { input_tokens: 3, output_tokens: 1 }, outcome: { status: "answered" } });
		assert.equal(memory.listCandidates({ platform: "cli", chatId: "terminal", userId: "user" }).length, 2);
		runtime.dispose();
	} finally {
		memory.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("BeeMax Agent Runtime injects one structured Work Contract into the model turn", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let received = "";
	const runtime = createRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "test-model" }, messages: [] } };
			return { agent, subscribe: () => () => undefined, prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
		},
	});
	try {
		await runtime.run({ source, text: "生成中文PDF，不要包含报价", timeoutMs: 1_000, mode: "interactive" });
		assert.match(received, /<beemax-work-contract>/);
		assert.match(received, /beemax\.work-contract\.v1/);
		assert.match(received, /不要包含报价/);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime preserves identity-looking text without compiling fixed business slots", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let received = "";
	const runtime = createRuntime({ createAgent: async () => {
		const agent = { state: { model: { id: "test-model" }, messages: [] } };
		return { agent, subscribe: () => () => undefined, prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
	} });
	try {
		await runtime.run({ source, text: "核对主体 repository:BeeMax 下的对象 issue:417", timeoutMs: 1_000, mode: "interactive" });
		assert.match(received, /repository:BeeMax/);
		assert.match(received, /issue:417/);
		assert.doesNotMatch(received, /businessContext/);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime ignores removed business-context input instead of treating it as authority", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let received = "";
	const runtime = createRuntime({ createAgent: async () => {
		const agent = { state: { model: { id: "test-model" }, messages: [] } };
		return { agent, subscribe: () => () => undefined, prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
	} });
	try {
		await runtime.run({ source, text: "继续处理", timeoutMs: 1_000, mode: "interactive", businessContext: { subject: { type: "tenant", id: "acme" }, object: { type: "incident", id: "INC-42" } } });
		assert.doesNotMatch(received, /tenant|incident|businessContext/);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime binds continuation understanding to the active Objective", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let received = "";
	let recallOptions;
	const runtime = createRuntime({
		context: new ConversationContext({ recall: (_query, options) => { recallOptions = options; return []; }, recordCandidate: () => "candidate" }),
		taskLedger: { queryTasks: () => [{ id: "objective-1", ownerKey: "cli:terminal:user", kind: "objective", title: "制作华东客户周报", description: "必须使用中文", acceptanceCriteria: "输出PDF并发送给王总", status: "running", createdAt: 1, businessContext: { subject: { type: "customer", id: "A" }, object: { type: "order", id: "PO-1" } }, effectReceipts: [{ id: "effect-1", tool: "feishu_send", operation: "send draft", sideEffect: "mutation", status: "committed", externalRef: "message-42", occurredAt: 2 }] }] },
		createAgent: async () => {
			const agent = { state: { model: { id: "test-model" }, messages: [] } };
			return { agent, subscribe: () => () => undefined, prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
		},
	});
	try {
		await runtime.run({ source, text: "继续完成刚才的任务", timeoutMs: 1_000, mode: "interactive", objectiveTaskId: "objective-1" });
		assert.match(received, /"action":"continue"/);
		assert.match(received, /"objective":\{"text":"制作华东客户周报","source":\{"kind":"active_objective","id":"objective-1"\}\}/);
		assert.match(received, /task-preservation-envelope/);
		assert.match(received, /输出PDF并发送给王总/);
		assert.doesNotMatch(received, /send draft/);
		assert.doesNotMatch(received, /message-42/);
		assert.equal(recallOptions.subject, undefined);
		assert.equal(recallOptions.object, undefined);
	} finally { runtime.dispose(); }
});

test("validated create Contract does not reuse work because request text resembles continuation", async () => {
	const source = { platform: "cli", chatId: "semantic-create", chatType: "dm", userId: "user" };
	const rawRequest = "continue 是报告标题，创建新草稿";
	const active = { id: "objective-a", ownerKey: "cli:semantic-create:user", kind: "objective", title: "旧报告", description: "旧报告", status: "running", createdAt: 1 };
	const tasks = [active];
	let prompt = "";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	const runtime = createRuntime({
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: {
			schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause,
			constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99,
		} }) },
		taskLedger: {
			queryTasks: (query) => tasks.filter((task) => (!query.id || task.id === query.id) && (!query.ownerKeys || query.ownerKeys.includes(task.ownerKey)) && (!query.statuses || query.statuses.includes(task.status))),
			record: (task) => tasks.push(task),
			transition: (id, change) => { const index = tasks.findIndex((task) => task.id === id); if (index < 0) return false; tasks[index] = { ...tasks[index], ...change }; return true; },
		},
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async (text) => { prompt = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "created" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source, text: rawRequest, timeoutMs: 1_000, mode: "interactive" });
		assert.equal(tasks.filter((task) => task.kind === "objective").length, 2);
		assert.equal(tasks.find((task) => task.id !== active.id)?.workContract?.action, "create");
		assert.match(prompt, /"action":"create"/);
	} finally { runtime.dispose(); }
});

test("a targeted query references an Objective without mutating its durable lifecycle", async () => {
	const source = { platform: "cli", chatId: "semantic-query", chatType: "dm", userId: "user" };
	const rawRequest = "What is the current status of that report?";
	const active = { id: "objective-report", ownerKey: "cli:semantic-query:user", kind: "objective", title: "Quarterly report", status: "running", accessScopeRef: createAccessScopeRef({ id: "scope:report", authority: { kind: "membership_registry", reference: "membership:report" }, issuedAt: 1 }), createdAt: 1 };
	let executionEnvelope;
	let prompt = "";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	const fail = () => assert.fail("read-only query must not mutate the Task Ledger");
	const runtime = createRuntime({
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "query", targetObjective: { kind: "active_objective", id: active.id }, objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } }) },
		taskLedger: { queryTasks: (query) => query.ownerKeys.includes(active.ownerKey) && (!query.id || query.id === active.id) && (!query.statuses || query.statuses.includes(active.status)) ? [active] : [], record: fail, transition: fail, recordRun: fail, transitionRun: fail, reviseObjective: fail, cancelObjective: fail, enqueueObjectiveCompletion: fail },
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true, requiresResearch: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async (text) => { prompt = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "still running" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		const result = await runtime.run({ source, text: rawRequest, timeoutMs: 1_000, mode: "interactive", objectiveTaskId: active.id }, (event) => { if (event.type === "execution_started") executionEnvelope = event.executionEnvelope; });
		assert.equal(result.answer, "still running");
		assert.equal(active.status, "running");
		assert.equal(executionEnvelope.objectiveId, active.id);
		assert.equal(executionEnvelope.taskId, undefined);
		assert.match(prompt, /task-preservation-envelope/);
	} finally { runtime.dispose(); }
});

test("an explicit Objective identity must resolve and agree with the semantic Contract before Pi", async () => {
	const source = { platform: "cli", chatId: "explicit-objective", chatType: "dm", userId: "user" };
	let cognition = 0;
	let agents = 0;
	const runtime = createRuntime({
		taskLedger: { queryTasks: () => [] },
		workContractBuilder: { build: async () => { cognition++; throw new Error("must not run"); } },
		createAgent: async () => { agents++; throw new Error("must not start Pi"); },
	});
	try {
		await assert.rejects(runtime.run({ source, text: "continue", timeoutMs: 1_000, objectiveTaskId: "missing" }), /not active in this scope/i);
		assert.equal(cognition, 0);
		assert.equal(agents, 0);
	} finally { runtime.dispose(); }
	const active = { id: "bound", ownerKey: "cli:explicit-objective:user", kind: "objective", title: "Bound", status: "running", createdAt: 1 };
	const createText = "Create something else";
	const clause = { text: createText, source: { kind: "raw_request", start: 0, end: createText.length } };
	const mismatch = createRuntime({
		taskLedger: { queryTasks: () => [active], record: () => assert.fail("conflicting Contract must not mutate") },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest: createText, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } }) },
		createAgent: async () => assert.fail("conflicting Contract must not start Pi"),
	});
	try { await assert.rejects(mismatch.run({ source, text: createText, timeoutMs: 1_000, objectiveTaskId: active.id }), /must target explicitly bound Objective/i); }
	finally { mismatch.dispose(); }
});

test("semantic admission can select create work with more than twenty active Objectives", async () => {
	const source = { platform: "cli", chatId: "many-objectives", chatType: "dm", userId: "user" };
	const ownerKey = "cli:many-objectives:user";
	const tasks = Array.from({ length: 21 }, (_, index) => ({ id: `existing-${index}`, ownerKey, kind: "objective", title: `Existing ${index}`, status: "running", createdAt: index }));
	const rawRequest = "Create a new independent report";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	let created;
	const runtime = createRuntime({
		taskLedger: { queryTasks: () => tasks, record: (task) => { created = task; }, transition: () => true },
		workContractBuilder: { build: async ({ activeObjectives }) => { assert.equal(activeObjectives.length, 21); return { source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } }; } },
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "created" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try { await runtime.run({ source, text: rawRequest, timeoutMs: 1_000 }); assert.equal(created.workContract.action, "create"); }
	finally { runtime.dispose(); }
});

test("validated cancel Contract terminalizes only its selected Objective without starting Pi", async () => {
	const source = { platform: "cli", chatId: "semantic-cancel", chatType: "dm", userId: "user" };
	const rawRequest = "不要停止市场分析，取消周报";
	const tasks = [
		{ id: "objective-market", ownerKey: "cli:semantic-cancel:user", kind: "objective", title: "市场分析", status: "running", createdAt: 2 },
		{ id: "objective-report", ownerKey: "cli:semantic-cancel:user", kind: "objective", title: "周报", status: "running", createdAt: 1 },
	];
	let agentCreations = 0;
	const clause = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	const runtime = createRuntime({
		workContractBuilder: { build: async ({ activeObjectives }) => {
			assert.deepEqual(activeObjectives.map(({ id }) => id).sort(), ["objective-market", "objective-report"]);
			return { source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: {
				schemaVersion: "beemax.work-contract.v1", rawRequest, action: "cancel", targetObjective: { kind: "active_objective", id: "objective-report" }, objective: clause("取消周报"),
				constraints: [], prohibitions: [clause("不要停止市场分析")], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99,
			} };
		} },
		taskLedger: {
			queryTasks: (query) => tasks.filter((task) => (!query.id || task.id === query.id) && (!query.ownerKeys || query.ownerKeys.includes(task.ownerKey)) && (!query.statuses || query.statuses.includes(task.status))),
			record: () => assert.fail("cancel must not create an Objective"), transition: () => assert.fail("cancel must use the owner-scoped cancellation authority"),
			cancelObjective: (ownerKey, id, now) => { const task = tasks.find((candidate) => candidate.ownerKey === ownerKey && candidate.id === id && ["pending", "running"].includes(candidate.status)); if (!task) return undefined; Object.assign(task, { status: "cancelled", finishedAt: now, error: "Cancelled by user" }); return { objectiveId: id, taskIds: [id], planIds: [] }; },
		},
		interruptObjectiveWork: (_source, cancellation) => { assert.equal(tasks.find((task) => task.id === cancellation.objectiveId).status, "cancelled"); return { interruptedEffects: 0 }; },
		createAgent: async () => { agentCreations++; throw new Error("Pi must not start for admitted cancellation"); },
	});
	try {
		const result = await runtime.run({ source, text: rawRequest, timeoutMs: 1_000, mode: "interactive" });
		assert.equal(result.answer, "Cancelled Objective 周报.");
		assert.equal(tasks.find((task) => task.id === "objective-report").status, "cancelled");
		assert.equal(tasks.find((task) => task.id === "objective-market").status, "running");
		assert.equal(agentCreations, 0);
	} finally { runtime.dispose(); }
});

test("targeted cancellation aborts a concurrently running Objective session across threads", async () => {
	const workerSource = { platform: "cli", chatId: "shared", chatType: "dm", userId: "user", threadId: "worker" };
	const controlSource = { ...workerSource, threadId: "control" };
	const ownerKey = "cli:shared:user";
	const objective = { id: "objective-live", ownerKey, kind: "objective", title: "Long report", description: "Build the long report", status: "running", createdAt: 1 };
	let promptStartedResolve;
	const promptStarted = new Promise((resolve) => { promptStartedResolve = resolve; });
	let rejectPrompt;
	let aborts = 0;
	const taskLedger = {
		queryTasks: (query) => query.ownerKeys.includes(ownerKey) && (!query.id || query.id === objective.id) && (!query.statuses || query.statuses.includes(objective.status)) ? [objective] : [],
		transition: (_id, change) => { if (!["pending", "running"].includes(objective.status)) return false; Object.assign(objective, change); return true; },
		cancelObjective: (_ownerKey, id, now) => { if (id !== objective.id || !["pending", "running"].includes(objective.status)) return undefined; Object.assign(objective, { status: "cancelled", finishedAt: now }); return { objectiveId: id, taskIds: [id], planIds: [] }; },
	};
	const rawCancel = "Cancel the long report";
	const runtime = createRuntime({
		taskLedger,
		workContractBuilder: { build: async ({ rawRequest }) => { assert.equal(rawRequest, rawCancel); return { source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "cancel", targetObjective: { kind: "active_objective", id: objective.id }, objective: { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } }, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } }; } },
		createAgent: async () => { throw new Error("cancel must not start Pi"); },
		createAutomationAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { promptStartedResolve(); await new Promise((_resolve, reject) => { rejectPrompt = reject; }); }, abort: async () => { aborts++; rejectPrompt?.(new Error("objective interrupted")); }, dispose: () => undefined }; },
		interruptObjectiveWork: async () => ({ interruptedEffects: 0 }),
	});
	try {
		const running = runtime.run({ source: workerSource, text: objective.description, timeoutMs: 5_000, mode: "automation", objectiveTaskId: objective.id });
		await promptStarted;
		const cancelled = await runtime.run({ source: controlSource, text: rawCancel, timeoutMs: 1_000, mode: "interactive" });
		assert.match(cancelled.answer, /Cancelled Objective Long report/);
		await assert.rejects(running, /objective interrupted/i);
		assert.equal(aborts, 1);
		assert.equal(objective.status, "cancelled");
	} finally { runtime.dispose(); }
});

test("a failed Objective runtime interruption is retried and settled by the next Turn", async () => {
	const source = { platform: "cli", chatId: "interruption-retry", chatType: "dm", userId: "user" };
	const ownerKey = "cli:interruption-retry:user";
	const objective = { id: "objective-retry-interruption", ownerKey, kind: "objective", title: "Long report", status: "running", createdAt: 1 };
	const rawCancel = "Cancel the long report";
	const rawNext = "What time is it?";
	let interruptionAttempts = 0;
	let agentCreations = 0;
	let pendingInterruption;
	const runtime = createRuntime({
		taskLedger: {
			queryTasks: (query) => query.ownerKeys.includes(ownerKey) && (!query.id || query.id === objective.id) && (!query.statuses || query.statuses.includes(objective.status)) ? [objective] : [],
			cancelObjective: (_ownerKey, id, now) => {
				if (id !== objective.id || !["pending", "running"].includes(objective.status)) return undefined;
				Object.assign(objective, { status: "cancelled", finishedAt: now });
				return { objectiveId: id, taskIds: [id], planIds: [] };
			},
			pendingObjectiveInterruptions: () => pendingInterruption ? [pendingInterruption] : [],
			failObjectiveInterruption: (pendingOwnerKey, objectiveId) => {
				pendingInterruption = { ownerKey: pendingOwnerKey, objectiveId, taskIds: [objectiveId], planIds: [], retry: true };
				return true;
			},
			settleObjectiveInterruption: (_pendingOwnerKey, objectiveId) => {
				if (pendingInterruption?.objectiveId !== objectiveId) return false;
				pendingInterruption = undefined;
				return true;
			},
		},
		workContractBuilder: { build: async ({ rawRequest }) => {
			const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
			return rawRequest === rawCancel
				? { source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "cancel", targetObjective: { kind: "active_objective", id: objective.id }, objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } }
				: { source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "query", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } };
		} },
		interruptObjectiveWork: async (_runtimeSource, cancellation) => {
			assert.equal(cancellation.objectiveId, objective.id);
			interruptionAttempts++;
			if (interruptionAttempts === 1) throw new Error("interruption adapter temporarily unavailable");
			return { interruptedEffects: 0 };
		},
		createAgent: async () => {
			agentCreations++;
			const agent = { state: { model: { id: "test" }, messages: [] } };
			return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "12:00" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
		},
	});
	try {
		const cancelled = await runtime.run({ source, text: rawCancel, timeoutMs: 1_000, mode: "interactive" });
		assert.match(cancelled.answer, /runtime interruption requires reconciliation/i);
		assert.equal(objective.status, "cancelled");
		assert.equal(interruptionAttempts, 1);
		assert.equal(agentCreations, 0);

		const next = await runtime.run({ source, text: rawNext, timeoutMs: 1_000, mode: "interactive" });
		assert.equal(next.answer, "12:00");
		assert.equal(interruptionAttempts, 2);

		await runtime.run({ source, text: rawNext, timeoutMs: 1_000, mode: "interactive" });
		assert.equal(interruptionAttempts, 2, "a settled interruption must not replay on later Turns");
	} finally { runtime.dispose(); }
});

test("a non-settling Objective interruption adapter is bounded and releases its durable claim", async () => {
	const source = { platform: "cli", chatId: "interruption-timeout", chatType: "dm", userId: "user" };
	const ownerKey = "cli:interruption-timeout:user";
	const interruption = { ownerKey, objectiveId: "objective-timeout", taskIds: ["objective-timeout"], planIds: [], retry: true };
	let failures = 0;
	const runtime = createRuntime({
		objectiveInterruptionTimeoutMs: 100,
		taskLedger: {
			queryTasks: () => [],
			pendingObjectiveInterruptions: () => [interruption],
			claimObjectiveInterruptions: (_owners, _holder, _lease, _now, _limit) => [interruption],
			failObjectiveInterruption: (_owner, _objective, error, _now, holder) => { assert.match(error, /timed out|abort/i); assert.match(holder, /^objective-interruption:/); failures++; return true; },
		},
		interruptObjectiveWork: async () => new Promise(() => undefined),
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "available" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		const started = Date.now();
		const result = await runtime.run({ source, text: "What time is it?", timeoutMs: 1_000 });
		assert.equal(result.answer, "available");
		assert.ok(Date.now() - started < 800);
		assert.equal(failures, 1);
	} finally { runtime.dispose(); }
});

test("delegated Execution Envelopes revalidate objective, task, and run identity at every mutating Tool boundary", async () => {
	const source = { platform: "cli", chatId: "delegated-fence", chatType: "dm", userId: "user", delegatedTask: { id: "child-task", ownerKey: "owner:delegated" } };
	const mutation = { name: "mutate", label: "Mutate", description: "Mutate", parameters: {}, beemaxPolicy: MUTATING_TOOL_POLICY, execute: async () => ({ content: [], details: {} }) };
	let checked;
	let boundary;
	const runtime = createRuntime({
		taskLedger: {
			queryTasks: () => [],
			isTaskRunExecutionActive: (...args) => { checked = args; return false; },
			transitionRun: () => true,
		},
		createAgent: async () => {
			let listener;
			const active = new Set([mutation.name]);
			const agent = { state: { model: { id: "test" }, messages: [], tools: [mutation] }, beforeToolCall: undefined };
			return {
				agent,
				subscribe: (next) => { listener = next; return () => undefined; },
				getAllTools: () => [mutation], getToolDefinition: () => mutation,
				getActiveToolNames: () => [...active], setActiveToolsByName: (names) => { active.clear(); for (const name of names) active.add(name); },
				prompt: async () => {
					listener({ type: "message_end", message: { role: "assistant", responseId: "response:delegated", content: [{ type: "toolCall", id: "call:delegated", name: mutation.name, arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
					listener({ type: "tool_execution_start", toolCallId: "call:delegated", toolName: mutation.name, args: {} });
					boundary = await agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call:delegated", name: mutation.name, arguments: {} }, args: {}, context: {} });
					agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "fenced" }], usage: { input: 1, output: 1 } });
				},
				abort: async () => undefined, dispose: () => undefined,
			};
		},
	});
	try {
		await runtime.run({ source, mode: "automation", text: "execute delegated task", allowedCapabilities: [mutation.name], timeoutMs: 1_000, executionEnvelope: createExecutionEnvelope({ executionId: "execution:delegated", trigger: { kind: "delegation", id: "child-task" }, objectiveId: "root-objective", taskId: "child-task", taskRunId: "run:delegated" }) });
		assert.equal(boundary?.block, true);
		assert.match(boundary?.reason ?? "", /durable Execution Holder/i);
		assert.deepEqual(checked?.slice(0, 4), ["owner:delegated", "root-objective", "child-task", "run:delegated"]);
	} finally { runtime.dispose(); }
});

test("durable delegated mutations fail closed when no Task Ledger authority is composed", async () => {
	const source = { platform: "cli", chatId: "delegated-no-authority", chatType: "dm", userId: "user", delegatedTask: { id: "child-task", ownerKey: "owner:delegated" } };
	const mutation = { name: "mutate", label: "Mutate", description: "Mutate", parameters: {}, beemaxPolicy: MUTATING_TOOL_POLICY, execute: async () => ({ content: [], details: {} }) };
	let boundary;
	const runtime = createRuntime({
		createAgent: async () => {
			let listener;
			const agent = { state: { model: { id: "test" }, messages: [], tools: [mutation] }, beforeToolCall: undefined };
			return {
				agent, subscribe: (next) => { listener = next; return () => undefined; },
				getAllTools: () => [mutation], getToolDefinition: () => mutation,
				getActiveToolNames: () => [mutation.name], setActiveToolsByName: () => undefined,
				prompt: async () => {
					listener({ type: "message_end", message: { role: "assistant", responseId: "response:no-authority", content: [{ type: "toolCall", id: "call:no-authority", name: mutation.name, arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
					listener({ type: "tool_execution_start", toolCallId: "call:no-authority", toolName: mutation.name, args: {} });
					boundary = await agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call:no-authority", name: mutation.name, arguments: {} }, args: {}, context: {} });
					agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "fenced" }], usage: { input: 1, output: 1 } });
				},
				abort: async () => undefined, dispose: () => undefined,
			};
		},
	});
	try {
		await runtime.run({ source, mode: "automation", text: "execute delegated task", allowedCapabilities: [mutation.name], timeoutMs: 1_000, executionEnvelope: createExecutionEnvelope({ executionId: "execution:no-authority", trigger: { kind: "delegation", id: "child-task" }, objectiveId: "root-objective", taskId: "child-task", taskRunId: "run:no-authority" }) });
		assert.equal(boundary?.block, true);
		assert.match(boundary?.reason ?? "", /no active durable Execution Holder authority/i);
	} finally { runtime.dispose(); }
});

async function inspectEffectfulRuntimeBoundary(executionEnvelope) {
	const source = { platform: "cli", chatId: executionEnvelope.executionId, chatType: "dm", userId: "user" };
	const mutation = { name: "mutate", label: "Mutate", description: "Mutate", parameters: {}, beemaxPolicy: MUTATING_TOOL_POLICY, execute: async () => ({ content: [], details: {} }) };
	let boundary;
	let previousBoundaryCalls = 0;
	const runtime = createRuntime({
		createAgent: async () => {
			let listener;
			const active = new Set([mutation.name]);
			const agent = {
				state: { model: { id: "test" }, messages: [], tools: [mutation] },
				beforeToolCall: async () => { previousBoundaryCalls++; return undefined; },
			};
			return {
				agent,
				subscribe: (next) => { listener = next; return () => undefined; },
				getAllTools: () => [mutation], getToolDefinition: () => mutation,
				getActiveToolNames: () => [...active], setActiveToolsByName: (names) => { active.clear(); for (const name of names) active.add(name); },
				prompt: async () => {
					listener({ type: "message_end", message: { role: "assistant", responseId: `response:${executionEnvelope.executionId}`, content: [{ type: "toolCall", id: "call:mutation", name: mutation.name, arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
					listener({ type: "tool_execution_start", toolCallId: "call:mutation", toolName: mutation.name, args: {} });
					boundary = await agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call:mutation", name: mutation.name, arguments: {} }, args: {}, context: {} });
					const completed = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
					listener({ type: "message_end", message: completed });
					agent.state.messages = [completed];
				},
				abort: async () => undefined, dispose: () => undefined,
			};
		},
	});
	try {
		await runtime.run({ source, text: "perform the admitted mutation", allowedCapabilities: [mutation.name], timeoutMs: 1_000, executionEnvelope });
		return { boundary, previousBoundaryCalls };
	} finally { runtime.dispose(); }
}

test("effectful Tool calls fail closed when durable objective and task identity omit the Task Run", async () => {
	const result = await inspectEffectfulRuntimeBoundary(createExecutionEnvelope({ executionId: "execution:partial-no-run", trigger: { kind: "interaction" }, objectiveId: "objective:partial", taskId: "task:partial" }));
	assert.equal(result.boundary?.block, true);
	assert.match(result.boundary?.reason ?? "", /complete objective, task, and Task Run identity/i);
	assert.equal(result.previousBoundaryCalls, 0);
});

test("effectful Tool calls fail closed when durable task and run identity omit the Objective", async () => {
	const result = await inspectEffectfulRuntimeBoundary(createExecutionEnvelope({ executionId: "execution:partial-no-objective", trigger: { kind: "interaction" }, taskId: "task:partial", taskRunId: "run:partial" }));
	assert.equal(result.boundary?.block, true);
	assert.match(result.boundary?.reason ?? "", /complete objective, task, and Task Run identity/i);
	assert.equal(result.previousBoundaryCalls, 0);
});

test("effectful Tool calls without durable identity retain the ordinary interaction governance path", async () => {
	const result = await inspectEffectfulRuntimeBoundary(createExecutionEnvelope({ executionId: "execution:ordinary-mutation", trigger: { kind: "interaction" } }));
	assert.equal(result.boundary, undefined);
	assert.equal(result.previousBoundaryCalls, 1);
});

test("an unbounded Agent turn still owns a finite renewable Task Run lease", async () => {
	const source = { platform: "cli", chatId: "renewable-agent-run", chatType: "dm", userId: "user" };
	const tasks = [];
	let recordedRun;
	let renewals = 0;
	const runtime = createRuntime({
		taskRunLeaseMs: 300,
		taskLedger: {
			queryTasks: ({ id, statuses }) => tasks.filter((task) => (!id || task.id === id) && (!statuses || statuses.includes(task.status))),
			record: (task) => tasks.push({ ...task }),
			transition: (id, change) => { const task = tasks.find((item) => item.id === id); if (!task) return false; Object.assign(task, change); return true; },
			recordRun: (run) => { recordedRun = run; },
			renewTaskRunLease: (_id, leaseExpiresAt, now) => { assert.ok(leaseExpiresAt > now); renewals++; return true; },
			transitionRun: () => true,
		},
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { await new Promise((resolve) => setTimeout(resolve, 230)); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source, mode: "automation", text: "完成这个长期任务", timeoutMs: null, executionEnvelope: createExecutionEnvelope({ executionId: "execution:renewable", trigger: { kind: "automation", id: "job" } }) });
		assert.equal(recordedRun.leaseExpiresAt - recordedRun.startedAt, 300);
		assert.ok(renewals >= 1);
	} finally { runtime.dispose(); }
});

test("Work Contract cognition time does not consume the subsequent Pi Task Run lease", async () => {
	const source = { platform: "cli", chatId: "post-cognition-lease", chatType: "dm", userId: "user" };
	const rawRequest = "生成并核验报告";
	const tasks = [];
	let cognitionFinishedAt = 0;
	let recordedRun;
	const runtime = createRuntime({
		taskRunLeaseMs: 300,
		workContractBuilder: { build: async () => {
			await new Promise((resolve) => setTimeout(resolve, 330));
			cognitionFinishedAt = Date.now();
			const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
			return { source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } };
		} },
		taskLedger: {
			queryTasks: ({ id, statuses }) => tasks.filter((task) => (!id || task.id === id) && (!statuses || statuses.includes(task.status))),
			record: (task) => tasks.push({ ...task }),
			transition: (id, change) => { const task = tasks.find((item) => item.id === id); if (!task) return false; Object.assign(task, change); return true; },
			recordRun: (run) => { recordedRun = run; },
			renewTaskRunLease: () => true,
			transitionRun: () => true,
		},
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source, mode: "interactive", text: rawRequest, timeoutMs: 2_000 });
		assert.ok(recordedRun.startedAt >= cognitionFinishedAt);
		assert.equal(recordedRun.leaseExpiresAt - recordedRun.startedAt, 300);
	} finally { runtime.dispose(); }
});

test("Agent runtime does not renew or settle a Task Run owned by its external TaskGraph caller", async () => {
	const source = { platform: "cli", chatId: "external-task-run", chatType: "dm", userId: "user", delegatedTask: { id: "task-external", ownerKey: "owner:external" } };
	const settlements = [];
	let renewals = 0;
	let aborts = 0;
	const runtime = createRuntime({
		taskRunLeaseMs: 300,
		taskLedger: {
			renewTaskRunLease: () => { renewals++; return false; },
			transitionRun: (_id, change) => { settlements.push(change.status); return true; },
		},
		createAgent: async () => {
			const agent = { state: { model: { id: "test" }, messages: [] } };
			return {
				agent, subscribe: () => () => undefined,
				prompt: async () => { await new Promise((resolve) => setTimeout(resolve, 180)); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
				abort: async () => { aborts++; }, dispose: () => undefined,
			};
		},
	});
	try {
		const result = await runtime.run({ source, mode: "automation", text: "finish the delegated task", timeoutMs: 1_000, executionEnvelope: createExecutionEnvelope({ executionId: "execution:external", trigger: { kind: "delegation", id: "task-external" }, objectiveId: "objective-external", taskId: "task-external", taskRunId: "run:external" }) });
		assert.equal(result.answer, "done");
		assert.equal(renewals, 0);
		assert.deepEqual(settlements, []);
		assert.equal(aborts, 0);
	} finally { runtime.dispose(); }
});

test("a rejected local Objective abort cannot be reported as an unqualified cancellation", async () => {
	const workerSource = { platform: "cli", chatId: "abort-failure", chatType: "dm", userId: "user", threadId: "worker" };
	const controlSource = { ...workerSource, threadId: "control" };
	const ownerKey = "cli:abort-failure:user";
	const objective = { id: "objective-abort-failure", ownerKey, kind: "objective", title: "Long report", description: "Build the long report", status: "running", createdAt: 1 };
	let promptStartedResolve;
	const promptStarted = new Promise((resolve) => { promptStartedResolve = resolve; });
	let rejectPrompt;
	let aborts = 0;
	const rawCancel = "Cancel the long report";
	const runtime = createRuntime({
		taskLedger: {
			queryTasks: (query) => query.ownerKeys.includes(ownerKey) && (!query.id || query.id === objective.id) && (!query.statuses || query.statuses.includes(objective.status)) ? [objective] : [],
			transition: (_id, change) => { if (!["pending", "running"].includes(objective.status)) return false; Object.assign(objective, change); return true; },
			cancelObjective: (_ownerKey, id, now) => { if (id !== objective.id || !["pending", "running"].includes(objective.status)) return undefined; Object.assign(objective, { status: "cancelled", finishedAt: now }); return { objectiveId: id, taskIds: [id], planIds: [] }; },
		},
		workContractBuilder: { build: async ({ rawRequest }) => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "cancel", targetObjective: { kind: "active_objective", id: objective.id }, objective: { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } }, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } }) },
		createAgent: async () => { throw new Error("cancel must not start Pi"); },
		createAutomationAgent: async () => {
			const agent = { state: { model: { id: "test" }, messages: [] } };
			return {
				agent,
				subscribe: () => () => undefined,
				prompt: async () => { promptStartedResolve(); await new Promise((_resolve, reject) => { rejectPrompt = reject; }); },
				abort: async () => { aborts++; throw new Error("local session abort failed"); },
				dispose: () => undefined,
			};
		},
		interruptObjectiveWork: async () => ({ interruptedEffects: 0 }),
	});
	let running;
	try {
		running = runtime.run({ source: workerSource, text: objective.description, timeoutMs: 5_000, mode: "automation", objectiveTaskId: objective.id });
		await promptStarted;
		const cancelled = await runtime.run({ source: controlSource, text: rawCancel, timeoutMs: 1_000, mode: "interactive" });
		assert.match(cancelled.answer, /cancelled objective long report/i);
		assert.match(cancelled.answer, /reconciliation|interruption.*failed|runtime.*unknown/i);
		assert.doesNotMatch(cancelled.answer, /^Cancelled Objective Long report\.$/);
		assert.equal(aborts, 1);
		assert.equal(objective.status, "cancelled");
	} finally {
		rejectPrompt?.(new Error("test cleanup"));
		await running?.catch(() => undefined);
		runtime.dispose();
	}
});

test("validated correction Contract revises only its selected Objective among active work", async () => {
	const source = { platform: "cli", chatId: "semantic-correction", chatType: "dm", userId: "user" };
	const rawRequest = "不要改市场分析，把周报改成中文";
	const originalContract = (text) => ({ schemaVersion: "beemax.work-contract.v1", rawRequest: text, action: "create", objective: { text, source: { kind: "raw_request", start: 0, end: text.length } }, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 1 });
	const tasks = [
		{ id: "objective-market", ownerKey: "cli:semantic-correction:user", kind: "objective", title: "市场分析", description: "市场分析", workContract: originalContract("市场分析"), status: "running", createdAt: 2 },
		{ id: "objective-report", ownerKey: "cli:semantic-correction:user", kind: "objective", title: "周报", description: "周报", workContract: originalContract("周报"), status: "running", createdAt: 1 },
	];
	const clause = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	const runtime = createRuntime({
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: {
			schemaVersion: "beemax.work-contract.v1", rawRequest, action: "correct", targetObjective: { kind: "active_objective", id: "objective-report" }, objective: clause("把周报改成中文"),
			constraints: [], prohibitions: [clause("不要改市场分析")], acceptanceCriteria: [clause("把周报改成中文")], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99,
		} }) },
		taskLedger: {
			queryTasks: (query) => tasks.filter((task) => (!query.id || task.id === query.id) && (!query.ownerKeys || query.ownerKeys.includes(task.ownerKey)) && (!query.statuses || query.statuses.includes(task.status))),
			record: () => assert.fail("correction must not create an Objective"), transition: () => true,
			reviseObjective: (ownerKey, id, revision) => { assert.equal(ownerKey, tasks[1].ownerKey); assert.equal(id, "objective-report"); const durable = { id: `${id}:revision:1`, ...revision, createdAt: 3 }; tasks[1].objectiveRevisions = [durable]; return { originalWorkContract: tasks[1].workContract, revision: durable, revisions: [durable] }; },
		},
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "updated" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source, text: rawRequest, timeoutMs: 1_000, mode: "interactive" });
		assert.equal(tasks[0].objectiveRevisions, undefined);
		assert.equal(tasks[1].objectiveRevisions.length, 1);
		assert.deepEqual(tasks[1].objectiveRevisions[0].workContract.prohibitions.map((item) => item.text), ["不要改市场分析"]);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime leaves legacy business context immutable during correction", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const active = { id: "objective-1", ownerKey: "cli:terminal:user", kind: "objective", title: "处理采购记录", status: "running", createdAt: 1, businessContext: { subject: { type: "account", id: "A" }, object: { type: "purchase", id: "PO-1" } } };
	let updates = 0;
	const ledger = {
		queryTasks: () => [active],
		updateBusinessContext: () => { updates++; return true; },
		reviseObjective: (_ownerKey, _id, revision) => { const durable = { id: "objective-1:revision:1", ...revision, createdAt: 2 }; return { originalWorkContract: revision.workContract, revision: durable, revisions: [durable] }; },
	};
	const runtime = createRuntime({ taskLedger: ledger, createAgent: async () => {
		const agent = { state: { model: { id: "test" }, messages: [] } };
		return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "updated" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
	} });
	try {
		await runtime.run({ source, text: "改成对象 purchase:PO-2", timeoutMs: 1_000, mode: "interactive", objectiveTaskId: "objective-1" });
		assert.equal(updates, 0);
		assert.deepEqual(active.businessContext, { subject: { type: "account", id: "A" }, object: { type: "purchase", id: "PO-1" } });
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime corrects durable Situation without replacing scope or duplicating the Objective", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const originalScope = createAccessScopeRef({ id: "scope:original", authority: { kind: "membership_registry", reference: "membership:original" }, issuedAt: 1 });
	const replacementScope = createAccessScopeRef({ id: "scope:replacement", authority: { kind: "membership_registry", reference: "membership:replacement" }, issuedAt: 2 });
	const active = {
		id: "objective-1", ownerKey: "cli:terminal:user", kind: "objective", title: "校准月影协议", status: "running", createdAt: 1,
		situation: createSituation({ summary: "月影协议采用旧潮汐参数", goals: ["完成校准"], confidence: 0.7 }),
		workContract: { schemaVersion: "beemax.work-contract.v1", rawRequest: "校准月影协议", action: "create", objective: { text: "校准月影协议", source: { kind: "raw_request", start: 0, end: 6 } }, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 1 },
		accessScopeRef: originalScope,
	};
	let updates = 0;
	let appendedCorrection;
	let records = 0;
	let recalledWithScope;
	let receivedPrompt = "";
	const ledger = {
		queryTasks: () => [active],
		updateSituation: (ownerKey, id, situation) => { updates++; assert.equal(ownerKey, active.ownerKey); assert.equal(id, active.id); active.situation = situation; return true; },
		reviseObjective: (ownerKey, id, revision) => { updates++; assert.equal(ownerKey, active.ownerKey); assert.equal(id, active.id); appendedCorrection = revision.workContract; const durable = { id: `${id}:revision:1`, ...revision, createdAt: 2 }; active.situation = revision.situation; active.objectiveRevisions = [durable]; return { originalWorkContract: active.workContract, revision: durable, revisions: [durable] }; },
		record: () => { records++; },
		transition: () => true,
	};
	const context = new ConversationContext({ recall: () => [], recordCandidate: () => "candidate" }, {
		resolveMemoryScope: (_runtimeSource, ref) => { recalledWithScope = ref; return {}; },
	});
	const runtime = createRuntime({
		context,
		taskLedger: ledger,
		turnUnderstanding: { understand: () => ({ action: "correct", goal: "月影协议改用星潮参数", constraints: ["保留回滚点"], acceptanceCriteria: [], memoryQuery: "月影协议 星潮参数", capabilityQuery: "校准", executionMode: "direct", confidence: 0.9 }) },
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async (text) => { receivedPrompt = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "updated" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source, text: "更正：改用星潮参数", timeoutMs: 1_000, mode: "interactive", objectiveTaskId: active.id, accessScopeRef: replacementScope });
		assert.equal(updates, 1);
		assert.equal(appendedCorrection.action, "correct");
		assert.equal(appendedCorrection.rawRequest, "更正：改用星潮参数");
		assert.match(receivedPrompt, /objectiveRevisions/);
		assert.match(receivedPrompt, /更正：改用星潮参数/);
		assert.equal(records, 0);
		assert.match(active.situation.summary, /星潮参数/);
		assert.deepEqual(active.accessScopeRef, originalScope);
		assert.deepEqual(recalledWithScope, originalScope);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime uses the Turn Understanding memory query for recall", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let recalledQuery = "";
	const memory = { recall: (query) => { recalledQuery = query; return []; }, recordCandidate: () => "candidate" };
	const runtime = createRuntime({
		context: new ConversationContext(memory),
		turnUnderstanding: { understand: (text) => ({ action: "create", goal: text, constraints: ["客户约束"], acceptanceCriteria: [], memoryQuery: "customer-a delivery requirements", capabilityQuery: text, executionMode: "direct", confidence: 0.9 }) },
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source, text: "按之前要求继续", timeoutMs: 1_000 });
		assert.match(recalledQuery, /按之前要求继续/);
		assert.match(recalledQuery, /客户约束/);
		assert.match(recalledQuery, /customer-a delivery requirements/);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime keeps inferred business identity semantic while trusted Access Scope controls recall", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let recalledQuery = "";
	let recalledScope;
	const accessScopeRef = createAccessScopeRef({ id: "scope:trusted", authority: { kind: "runtime_identity", reference: "session:trusted" }, issuedAt: 1 });
	const context = new ConversationContext({
		recall: (query, options) => { recalledQuery = query; recalledScope = options; return []; },
		recordCandidate: () => "candidate",
	}, {
		resolveMemoryScope: (_source, ref) => ref?.id === accessScopeRef.id
			? { organizationId: "org:trusted", subject: { type: "realm", id: "authorized" } }
			: {},
	});
	const runtime = createRuntime({
		context,
		turnUnderstanding: { understand: () => ({
			action: "create",
			goal: "校准量子灯塔",
			constraints: ["霜降窗口之前完成"],
			acceptanceCriteria: [],
			memoryQuery: "量子灯塔 霜降窗口",
			capabilityQuery: "校准量子灯塔",
			executionMode: "direct",
			confidence: 0.9,
			businessContext: { subject: { type: "forged", id: "evil" }, object: { type: "forged", id: "escape" } },
		}) },
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source, text: "继续处理主体 forged:evil 的对象 forged:escape", timeoutMs: 1_000, accessScopeRef });
		assert.match(recalledQuery, /量子灯塔/);
		assert.match(recalledQuery, /霜降窗口/);
		assert.equal(recalledScope.organizationId, "org:trusted");
		assert.equal(recalledScope.subject, undefined);
		assert.equal(recalledScope.object, undefined);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime rejects a pre-aborted turn before creating an agent session", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const controller = new AbortController();
	let aborts = 0;
	const runtime = createRuntime({
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
	assert.equal(aborts, 0);
	runtime.dispose();
});

test("BeeMax Agent Runtime passes native image attachments to Pi without prompt serialization", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const images = [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
	let received;
	const runtime = createRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "vision-test", provider: "test", input: ["text", "image"] }, messages: [] } };
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
	assert.match(received.text, /(?:^|\n\n)describe this$/);
	assert.deepEqual(received.options.images, images);
	assert.doesNotMatch(received.text, /aW1hZ2U/);
	runtime.dispose();
});

test("BeeMax Agent Runtime exposes Pi native steer and follow-up only during an active run", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const envelope = createExecutionEnvelope({ executionId: "execution:steering", trigger: { kind: "interaction" }, taskRunId: "run:steering", mode: "normal" });
	let release;
	const delivered = [];
	let piSession;
	const runtime = createRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "test" }, messages: [] } };
			piSession = {
				agent, isStreaming: true,
				subscribe: () => () => undefined,
				prompt: async () => { await new Promise((resolve) => { release = resolve; }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
				steer: async (text) => { assert.equal(piSession.beemaxExecutionEnvelope, envelope); delivered.push(["steer", text]); },
				followUp: async (text) => { assert.equal(piSession.beemaxExecutionEnvelope, envelope); delivered.push(["follow_up", text]); },
				abort: async () => undefined, dispose: () => undefined,
			};
			return piSession;
		},
	});
	assert.equal(await runtime.steer(source, "too early"), false);
	const turn = runtime.run({ source, text: "start", timeoutMs: 1_000, executionEnvelope: envelope });
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
	const runtime = createRuntime({
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
	const runtime = createRuntime({
		fallbackModels: [{ provider: "test", id: "fallback", input: ["text"], reasoning: false }],
		createAgent: async () => {
			const agent = { state: { model: { provider: "test", id: "primary" }, messages: [] } };
			const tools = [{ name: "write", description: "Observable test Tool", beemaxPolicy: { sideEffect: "none" } }];
			return {
				agent, getAllTools: () => tools, getActiveToolNames: () => ["write"], setActiveToolsByName: () => undefined,
				subscribe: (next) => { listener = next; return () => undefined; },
				prompt: async () => {
					listener({ type: "message_end", message: { role: "assistant", responseId: "response-write-1", content: [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
					listener({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write" });
					assert.equal(await agent.beforeToolCall({ toolCall: { id: "write-1", name: "write", arguments: {} }, args: {}, context: {} }, new AbortController().signal), undefined);
					const failure = { role: "assistant", stopReason: "error", errorMessage: "503 overloaded", content: [], usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
					listener({ type: "message_end", message: failure });
					agent.state.messages = [failure];
				},
				retryWithModel: async () => { retries++; return true; }, abort: async () => undefined, dispose: () => undefined,
			};
		},
	});
	await assert.rejects(runtime.run({ source, text: "work", timeoutMs: 1_000, allowedCapabilities: ["write"] }), (error) => error instanceof AgentRunError && error.recoverable);
	assert.equal(retries, 0);
	runtime.dispose();
});

test("BeeMax Agent Runtime exposes explicit context compaction only for an idle session", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const envelope = createExecutionEnvelope({ executionId: "execution:compaction", trigger: { kind: "interaction" }, taskRunId: "run:compaction", mode: "normal" });
	let compactions = 0;
	let piSession;
	const runtime = createRuntime({
		createAgent: async () => {
			piSession = {
			agent: { state: { model: { id: "test" }, messages: [] } },
			subscribe: () => () => undefined,
			prompt: async () => undefined,
			abort: async () => undefined,
			compact: async () => { assert.equal(piSession.beemaxExecutionEnvelope, envelope); compactions++; return { summary: "compacted" }; },
			dispose: () => undefined,
			};
			return piSession;
		},
	});
	assert.equal(await runtime.compact(source), false);
	await runtime.run({ source, text: "hello", timeoutMs: 1_000, executionEnvelope: envelope });
	assert.equal(await runtime.compact(source), true);
	assert.equal(compactions, 1);
	runtime.dispose();
});

test("context compaction preserves active Objective and Acceptance Criteria", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let compactInstructions = "";
	const runtime = createRuntime({
		taskLedger: { queryTasks: () => [{ id: "objective-1", ownerKey: "cli:terminal:user", kind: "objective", title: "生成客户报告", description: "必须使用中文", acceptanceCriteria: "输出PDF并发送给王总", status: "running", createdAt: 1, effectReceipts: [{ id: "effect-1", tool: "feishu_send", operation: "send report", sideEffect: "mutation", status: "committed", externalRef: "message-42", occurredAt: 2 }] }] },
		createAgent: async () => ({ agent: { state: { model: { id: "test" }, messages: [] } }, subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, compact: async (instructions) => { compactInstructions = instructions; }, dispose: () => undefined }),
	});
	try {
		await runtime.open(source);
		assert.equal(await runtime.compact(source), true);
		assert.match(compactInstructions, /生成客户报告/);
		assert.match(compactInstructions, /输出PDF并发送给王总/);
		assert.doesNotMatch(compactInstructions, /send report/);
		assert.doesNotMatch(compactInstructions, /message-42/);
		assert.match(compactInstructions, /task-preservation-envelope/);
	} finally { runtime.dispose(); }
});

test("successive compactions preserve a multilingual corrected Work Contract", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-successive-compaction-"));
	const store = new MemoryStore(join(root, "memory.db"));
	const ownerKey = "cli:compaction:user";
	const taskId = "objective:report";
	const rawRequest = "不要取消，continue the same report；改成中文，but do not publish externally";
	const rawClause = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	const correction = {
		schemaVersion: "beemax.work-contract.v1", rawRequest, action: "correct",
		objective: { text: "生成报告", source: { kind: "active_objective", id: taskId } },
		constraints: [rawClause("改成中文")], prohibitions: [rawClause("不要取消"), rawClause("but do not publish externally")],
		acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99,
	};
	const accessScopeRef = createAccessScopeRef({ id: "scope:must-not-leak", authority: { kind: "enterprise_system", reference: "iam:must-not-leak" }, issuedAt: 1 });
	const audits = [];
	const compactionContexts = [];
	let summarizing = false;
	try {
		store.record({
			id: taskId, ownerKey, kind: "objective", title: "生成报告", status: "running", createdAt: 1,
			workContract: { schemaVersion: "beemax.work-contract.v1", rawRequest: "生成报告", action: "create", objective: { text: "生成报告", source: { kind: "raw_request", start: 0, end: 4 } }, constraints: [], prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 1 },
			criterionVerifications: [{ criterionId: "C1", criterion: "保存中文草稿", status: "unavailable", evidenceRefs: [] }],
			artifacts: [{ type: "reference", uri: "beemax-artifact:sha256:compaction", label: "draft evidence" }], accessScopeRef,
		});
		assert.ok(store.reviseObjective(ownerKey, taskId, { workContract: correction, situation: createSituation({ summary: "继续同一报告，改成中文且禁止外部发布", goals: ["完成报告"], constraints: ["改成中文", "禁止外部发布"], confidence: 0.99 }) }, 2));
		const factory = buildBeeMaxRuntimeFactory({
			provider: "custom", model: "private-model", baseUrl: "https://models.example.test/v1", modelLimits: { contextWindow: 32_000, maxTokens: 4_096 },
			cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test", systemPrompt: "test", skillToolset: "safe", createTools: () => [],
			compaction: { reserveTokens: 4_800, keepRecentTokens: 1_024 },
			compactionInstructions: () => buildTaskPreservationEnvelope(store.queryTasks({ ownerKeys: [ownerKey], statuses: ["pending", "running"] })),
			compactionAudit: (event) => audits.push(event),
		});
		const session = await factory("successive-compaction", { platform: "cli", chatId: "compaction", chatType: "dm", userId: "user" });
		try {
			session.agent.streamFn = (model, context) => {
				if (summarizing) compactionContexts.push(structuredClone(context));
				const text = summarizing ? `Continue ${taskId}.` : "ok";
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: {
					role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
					usage: { input: summarizing ? 10 : 600, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: summarizing ? 11 : 601, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop", timestamp: Date.now(),
				} }));
				return stream;
			};
			for (let round = 0; round < 2; round++) {
				await session.prompt(`seed compaction ${round + 1}.1 ${"bounded context ".repeat(700)}`);
				await session.prompt(`seed compaction ${round + 1}.2 ${"bounded context ".repeat(700)}`);
				summarizing = true;
				try { await session.compact(); } finally { summarizing = false; }
				const messages = JSON.stringify(session.agent.state.messages);
				assert.match(messages, /beemax-task-preservation-recovery/u);
				assert.match(messages, /不要取消，continue the same report/u);
			}
			assert.equal(compactionContexts.length, 2);
			for (const context of compactionContexts) {
				const serialized = JSON.stringify(context);
				assert.match(serialized, /生成报告/u); assert.match(serialized, /不要取消/u); assert.match(serialized, /改成中文/u);
				assert.match(serialized, /but do not publish externally/u); assert.match(serialized, /beemax-artifact:sha256:compaction/u); assert.match(serialized, /objective:report/u);
				assert.doesNotMatch(serialized, /scope:must-not-leak|iam:must-not-leak/u);
			}
			const completed = audits.filter((event) => event.phase === "completed");
			assert.equal(completed.length, 2);
			for (const event of completed) assert.deepEqual({ expectedTaskCount: event.expectedTaskCount, missingTaskCount: event.missingTaskCount, qualityStatus: event.qualityStatus, recoveryInjected: event.recoveryInjected }, { expectedTaskCount: 1, missingTaskCount: 0, qualityStatus: "degraded", recoveryInjected: true });
		} finally { session.dispose(); }
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task preservation keeps durable Situation semantics without exposing Access Scope provenance", () => {
	const situation = createSituation({
		summary: "星港矩阵需要重新编排",
		goals: ["恢复矩阵稳定性"],
		constraints: ["保留现有航线"],
		observations: [{ statement: "第三象限持续抖动", source: { kind: "tool", reference: "telemetry:matrix" }, confidence: 0.88, trust: "observed" }],
		confidence: 0.85,
	});
	const accessScopeRef = createAccessScopeRef({ id: "scope:starport-secret", authority: { kind: "enterprise_system", reference: "iam:starport-secret" }, issuedAt: 1 });
	const checkpoint = { version: 1, taskRunId: "run:matrix", source: "pi_turn", at: 2, completed: ["telemetry:call-1"], committedEffectIds: [], evidenceRefs: ["tool:call-1"], unresolvedIssues: ["第三象限仍需校准"], nextSafeStep: "继续校准，不重复遥测读取。" };
	const envelope = buildTaskPreservationEnvelope([{ id: "objective-starport", ownerKey: "owner", kind: "objective", title: "矩阵编排", status: "running", createdAt: 1, situation, accessScopeRef, checkpoint }]);
	assert.match(envelope, /星港矩阵/);
	assert.match(envelope, /保留现有航线/);
	assert.match(envelope, /第三象限/);
	assert.match(envelope, /run:matrix/);
	assert.match(envelope, /不重复遥测读取/);
	assert.doesNotMatch(envelope, /scope:starport-secret/);
	assert.doesNotMatch(envelope, /iam:starport-secret/);
});

test("BeeMax Agent Runtime exposes session history, snapshots, and idle reset through Core", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user", threadId: "thread-1" };
	let disposed = 0;
	const runtime = createRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "test" }, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 1, cacheRead: 2, cacheWrite: 3 } }] } };
			let thinkingLevel = "off";
			return { agent, subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, get thinkingLevel() { return thinkingLevel; }, setThinkingLevel: (level) => { thinkingLevel = level; }, get compactionSettings() { return { enabled: true, reserveTokens: 20, keepRecentTokens: 30 }; }, getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }), dispose: () => { disposed++; } };
		},
	});
	assert.deepEqual(await runtime.history(source), []);
	assert.equal(await runtime.open(source), true);
	assert.deepEqual(await runtime.history(source), [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }]);
	assert.equal(runtime.reset(source), true);
	assert.equal(disposed, 1);
	await runtime.run({ source, text: "hello", timeoutMs: 1_000 });
	assert.deepEqual(await runtime.history(source), [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }]);
	assert.deepEqual(await runtime.usage(source), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, contextTokens: 10, contextWindow: 100, contextPercent: 10, compactionEnabled: true, compactionTriggerTokens: 80, compactionReserveTokens: 20, compactionKeepRecentTokens: 30 });
	assert.deepEqual(await runtime.modelStatus(source), { model: "test", thinkingLevel: "off", supportedThinkingLevels: ["off"] });
	assert.deepEqual(await runtime.setThinkingLevel(source, "high"), { model: "test", thinkingLevel: "off", supportedThinkingLevels: ["off"] });
	assert.equal(runtime.listSessions(source)[0].threadId, "thread-1");
	assert.equal(runtime.reset(source), true);
	assert.equal(disposed, 2);
	assert.deepEqual(runtime.listSessions(source), []);
	runtime.dispose();
});

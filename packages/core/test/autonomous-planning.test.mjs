import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousPlanningPolicy, BeeMaxAgentRuntime, PlanningBudgetRegistry } from "../dist/index.js";

test("planning policy keeps simple conversational requests direct", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 8 });
	const decision = policy.decide("What model are you using?");
	assert.equal(decision.mode, "direct");
	assert.equal(decision.requiredTool, undefined);
	assert.deepEqual(decision.requiredTools, []);
	assert.equal(decision.suggestedConcurrency, 1);
	assert.equal(decision.budget.maxSubagents, 0);
	assert.equal(decision.budget.maxToolCalls, null);
	assert.equal(decision.budget.maxTokens, null);
	assert.match(decision.reason, /simple|single/i);
});

test("planning policy delegates one substantial isolated work item", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 8 });
	const decision = policy.decide("Research the official documentation deeply and produce an evidence-backed comparison report");
	assert.equal(decision.mode, "delegate");
	assert.equal(decision.requiredTool, "task_spawn");
	assert.deepEqual(decision.requiredTools, ["task_spawn", "task_wait"]);
	assert.equal(decision.suggestedConcurrency, 1);
	assert.equal(decision.budget.maxSubagents, 1);
	assert.equal(decision.budget.maxToolCalls, null);
	assert.equal(decision.budget.maxTokens, null);
});

test("planning policy selects a DAG and derives bounded parallel resources for independent deliverables", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 8, maxSubagents: 6, maxToolCalls: 60, maxTokens: 120_000 });
	const decision = policy.decide("Review the API, CLI, memory, security, and operations modules in parallel; compare each independently, then synthesize and verify a release report");
	assert.equal(decision.mode, "dag");
	assert.equal(decision.requiredTool, "task_plan_execute");
	assert.deepEqual(decision.requiredTools, ["task_plan_execute"]);
	assert.ok(decision.suggestedConcurrency >= 2);
	assert.ok(decision.suggestedConcurrency <= 6);
	assert.ok(decision.budget.maxSubagents >= decision.suggestedConcurrency);
	assert.ok(decision.budget.maxToolCalls <= 60);
	assert.ok(decision.budget.maxTokens <= 120_000);
	assert.ok(decision.signals.independentWorkItems >= 2);
});

test("planning policy degrades a complex request when its resource ceiling cannot support a DAG", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 1, maxSubagents: 1, maxToolCalls: 8, maxTokens: 8_000 });
	const decision = policy.decide("Research three independent providers in parallel, compare them, verify every result, and publish one report");
	assert.equal(decision.mode, "delegate");
	assert.equal(decision.suggestedConcurrency, 1);
	assert.equal(decision.budget.maxSubagents, 1);
	assert.match(decision.reason, /budget|capacity/i);
});

test("planning policy exposes a content-free directive for the Agent runtime", () => {
	const decision = new AutonomousPlanningPolicy().decide("Review frontend and backend independently, then combine the results");
	const directive = decision.directive();
	assert.match(directive, /mode=(?:dag|delegate)/);
	assert.match(directive, /maxSubagents=/);
	assert.doesNotMatch(directive, /frontend|backend/);
});

test("Agent runtime injects a deterministic planning directive without changing the user exchange", async () => {
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
	let received = "";
	let runtimeListener;
	const recorded = [];
	const budgets = new PlanningBudgetRegistry();
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		planningPolicy: new AutonomousPlanningPolicy(),
		planningBudgets: budgets,
		context: { enrich: (_source, text) => text, record: (_source, exchange) => recorded.push(exchange) },
		createAgent: async () => ({
			agent,
			subscribe: (next) => { runtimeListener = next; return () => undefined; },
			prompt: async (text) => { received = text; runtimeListener({ type: "tool_execution_start", toolCallId: "plan", toolName: "task_plan_execute", args: {} }); runtimeListener({ type: "tool_execution_end", toolCallId: "plan", toolName: "task_plan_execute", result: { details: { failed: 0, cancelled: 0, blocked: [] } }, isError: false }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	await runtime.run({ source, text: "Review frontend and backend independently, then combine the results", timeoutMs: 1_000 });
	assert.match(received, /BeeMax execution policy/);
	assert.match(received, /mode=(?:dag|delegate)/);
	assert.deepEqual(recorded, [{ user: "Review frontend and backend independently, then combine the results", assistant: "done" }]);
	assert.equal(budgets.current("cli:local:local"), undefined);
	runtime.dispose();
});

test("planning budget leases cannot be cleared by a stale turn", () => {
	const registry = new PlanningBudgetRegistry();
	const policy = new AutonomousPlanningPolicy();
	const first = registry.begin("conversation", policy.decide("Review frontend and backend independently"));
	const second = registry.begin("conversation", policy.decide("Research one provider deeply"));
	assert.equal(registry.current("conversation")?.mode, "delegate");
	assert.equal(registry.end("conversation", first), false);
	assert.equal(registry.current("conversation")?.mode, "delegate");
	assert.equal(registry.end("conversation", second), true);
	assert.equal(registry.current("conversation"), undefined);
});

test("Agent runtime aborts a turn that exceeds its planned tool-call budget", async () => {
	const source = { platform: "cli", chatId: "budget", chatType: "dm", userId: "local" };
	let listener;
	let aborts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		planningPolicy: new AutonomousPlanningPolicy({ maxToolCalls: 8 }),
		createAgent: async () => ({
			agent,
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				for (let index = 0; index < 9; index++) listener({ type: "tool_execution_start", toolCallId: `tool-${index}`, toolName: "read" });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "should not succeed" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => { aborts++; },
			dispose: () => undefined,
		}),
	});
	await assert.rejects(runtime.run({ source, text: "Read this file", timeoutMs: 1_000 }), /tool-call budget exceeded.*8/i);
	assert.equal(aborts, 1);
	runtime.dispose();
});

test("Agent runtime aborts a turn when cumulative model usage exceeds its token budget", async () => {
	const source = { platform: "cli", chatId: "tokens", chatType: "dm", userId: "local" };
	let listener;
	let aborts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		planningPolicy: new AutonomousPlanningPolicy({ maxTokens: 12_000 }),
		createAgent: async () => ({
			agent, subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 12_001, output: 0, cacheRead: 0, cacheWrite: 0 } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "over budget" }], usage: { input: 12_001, output: 0 } }];
			},
			abort: async () => { aborts++; }, dispose: () => undefined,
		}),
	});
	await assert.rejects(runtime.run({ source, text: "Read this file", timeoutMs: 1_000 }), /token budget exceeded.*12000/i);
	assert.equal(aborts, 1);
	runtime.dispose();
});

test("Agent runtime performs one content-free correction when a complex turn skips its required planner", async () => {
	const source = { platform: "cli", chatId: "planner", chatType: "dm", userId: "local" };
	let listener;
	const prompts = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent, subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => {
			prompts.push(text);
			if (prompts.length === 2) { listener({ type: "tool_execution_start", toolCallId: "plan", toolName: "task_plan_execute", args: {} }); listener({ type: "tool_execution_end", toolCallId: "plan", toolName: "task_plan_execute", result: { details: { failed: 0, cancelled: 0, blocked: [] } }, isError: false }); }
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "Review frontend and backend independently, then combine and verify the results", timeoutMs: 1_000 });
	assert.equal(prompts.length, 2);
	assert.match(prompts[1], /task_plan_execute/);
	assert.doesNotMatch(prompts[1], /frontend|backend/);
	runtime.dispose();
});

test("delegated execution cannot finish after spawn without waiting for its Sub-Agent result", async () => {
	const source = { platform: "cli", chatId: "delegate", chatType: "dm", userId: "local" };
	let listener;
	let prompts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent, subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			prompts++;
			if (prompts === 1) { listener({ type: "tool_execution_start", toolCallId: "spawn", toolName: "task_spawn", args: {} }); listener({ type: "tool_execution_end", toolCallId: "spawn", toolName: "task_spawn", result: { details: { id: "child-1", status: "queued" } }, isError: false }); }
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "premature" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await assert.rejects(runtime.run({ source, text: "Research the official documentation deeply and produce an evidence-backed comparison report", timeoutMs: 1_000 }), /required planning tools: task_wait/i);
	assert.equal(prompts, 2);
	runtime.dispose();
});

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

test("Agent runtime progressively exposes discovery and restores the full catalog after a turn", async () => {
	const source = { platform: "cli", chatId: "fast", chatType: "dm", userId: "local" };
	const toolChanges = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const piSession = {
		agent,
		getActiveToolNames: () => ["read", "web_search"],
		setActiveToolsByName: (names) => { toolChanges.push([...names]); },
		subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "你好" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined,
		dispose: () => undefined,
	};
	const runtime = new BeeMaxAgentRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => piSession });
	await runtime.run({ source, text: "查一下今天的天气", timeoutMs: 1_000 });
	assert.deepEqual(toolChanges, [["capability_discover"], ["read", "web_search"]]);
	runtime.dispose();
});

test("Agent runtime continues once after capability discovery so activated tools can run", async () => {
	const source = { platform: "cli", chatId: "progressive", chatType: "dm", userId: "local" };
	let listener;
	const prompts = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent,
		getActiveToolNames: () => ["capability_discover", "web_search"],
		setActiveToolsByName: () => undefined,
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => {
			prompts.push(text);
			if (prompts.length === 1) listener({ type: "tool_execution_end", toolCallId: "discover", toolName: "capability_discover", result: { details: { activatedTools: ["web_search"] } }, isError: false });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "search current weather", timeoutMs: 1_000 });
	assert.equal(prompts.length, 2);
	assert.match(prompts[1], /capability continuation/i);
	assert.doesNotMatch(prompts[1], /current weather/i);
	runtime.dispose();
});

test("Agent runtime reroutes one unresolved Tool failure through capability discovery before giving up", async () => {
	const source = { platform: "cli", chatId: "reroute", chatType: "dm", userId: "local" };
	let listener; const prompts = []; const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({ createAgent: async () => ({
		agent, getActiveToolNames: () => ["capability_discover", "primary_search", "alternate_search"], setActiveToolsByName: () => undefined,
		getAllTools: () => [{ name: "primary_search", description: "Primary search", beemaxPolicy: { sideEffect: "none" } }],
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => {
			prompts.push(text);
			if (prompts.length === 1) listener({ type: "tool_execution_end", toolCallId: "failed", toolName: "primary_search", result: {}, isError: true });
			if (prompts.length === 2) listener({ type: "tool_execution_end", toolCallId: "discover", toolName: "capability_discover", result: { details: { activatedTools: ["alternate_search"] } }, isError: false });
			if (prompts.length === 3) listener({ type: "tool_execution_end", toolCallId: "alternate", toolName: "alternate_search", result: {}, isError: false });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "find current evidence", timeoutMs: 1_000 });
	assert.equal(prompts.length, 3);
	assert.match(prompts[1], /primary_search/);
	assert.match(prompts[1], /capability_discover/);
	assert.match(prompts[1], /do not retry the same external mutation/i);
	assert.match(prompts[2], /capability continuation/i);
	runtime.dispose();
});

test("Agent runtime never auto-reroutes an unresolved external mutation", async () => {
	const source = { platform: "cli", chatId: "write-failure", chatType: "dm", userId: "local" };
	let listener; const prompts = []; const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({ createAgent: async () => ({
		agent, getActiveToolNames: () => ["capability_discover", "external_write"], setActiveToolsByName: () => undefined,
		getAllTools: () => [{ name: "external_write", description: "Write externally", beemaxPolicy: { sideEffect: "external" } }],
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => { prompts.push(text); listener({ type: "tool_execution_end", toolCallId: "write", toolName: "external_write", result: {}, isError: true }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "failed" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "perform write", timeoutMs: 1_000 });
	assert.equal(prompts.length, 1);
	runtime.dispose();
});

test("Agent runtime releases Skill bodies at turn boundaries while retaining execution metadata", async () => {
	const source = { platform: "cli", chatId: "skill-context", chatType: "dm", userId: "local" };
	const agent = { state: { model: { id: "test" }, messages: [{ role: "toolResult", toolCallId: "old", toolName: "skill_resource_read", content: [{ type: "text", text: "old sensitive skill body" }], details: { sha256: "old-hash" } }] } };
	let historicalAtPrompt = "";
	const runtime = new BeeMaxAgentRuntime({ createAgent: async () => ({
		agent, getActiveToolNames: () => ["capability_discover"], setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
		prompt: async () => {
			historicalAtPrompt = agent.state.messages[0].content[0].text;
			agent.state.messages = [...agent.state.messages, { role: "toolResult", toolCallId: "new", toolName: "skill_activate", content: [{ type: "text", text: "current skill body" }], details: { descriptor: { name: "review", sha256: "new-hash" } } }, { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "review", timeoutMs: 1_000 });
	assert.doesNotMatch(historicalAtPrompt, /old sensitive/);
	assert.doesNotMatch(agent.state.messages.find((message) => message.toolCallId === "new").content[0].text, /current skill body/);
	assert.equal(agent.state.messages.find((message) => message.toolCallId === "new").details.descriptor.sha256, "new-hash");
	runtime.dispose();
});

test("BeeMax explicit Skill commands enter the enforced runtime lifecycle instead of Pi body expansion", async () => {
	const source = { platform: "cli", chatId: "explicit-skill", chatType: "dm", userId: "local" }; let received = "";
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({ context: { enrich: (_source, text) => `verified facts\n\n${text}`, record: () => undefined }, createAgent: async () => ({
		agent, getActiveToolNames: () => ["capability_discover"], setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
		prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "/skill:contract-review inspect this", timeoutMs: 1_000 });
	assert.match(received, /verified facts/); assert.match(received, /Explicit Skill request: contract-review/); assert.match(received, /capability_discover/); assert.doesNotMatch(received, /<skill name=/);
	runtime.dispose();
});

test("planning policy does not over-delegate lightweight English or Chinese review requests", () => {
	const policy = new AutonomousPlanningPolicy();
	for (const prompt of ["Review this sentence", "Please look at this code snippet", "帮我看一下这段代码", "检查这句话是否通顺"]) {
		assert.equal(policy.decide(prompt).mode, "direct", prompt);
	}
});

test("planning policy consistently escalates substantial bilingual work", () => {
	const policy = new AutonomousPlanningPolicy();
	assert.equal(policy.decide("Research the official documentation deeply and produce an evidence-backed comparison report").mode, "delegate");
	assert.equal(policy.decide("深入研究官方文档，形成有证据支持的完整报告").mode, "delegate");
	assert.equal(policy.decide("全面审查 API、CLI 和安全模块，并行验证后汇总报告").mode, "dag");
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
	const runEvents = [];
	const budgets = new PlanningBudgetRegistry();
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		planningPolicy: new AutonomousPlanningPolicy(),
		planningBudgets: budgets,
		context: { enrich: (_source, text) => text, record: (_source, exchange) => recorded.push(exchange) },
		createAgent: async () => ({
			agent,
			subscribe: (next) => { runtimeListener = next; return () => undefined; },
			prompt: async (text) => { received = text; runtimeListener({ type: "tool_execution_start", toolCallId: "plan", toolName: "task_plan_execute", args: {} }); runtimeListener({ type: "tool_execution_end", toolCallId: "plan", toolName: "task_plan_execute", result: { details: { planId: "plan-1", accepted: true, status: "running" } }, isError: false }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	await runtime.run({ source, text: "Review frontend and backend independently, then combine the results", timeoutMs: 1_000 }, (event) => { runEvents.push(event); });
	assert.match(received, /BeeMax execution policy/);
	assert.match(received, /mode=(?:dag|delegate)/);
	assert.deepEqual(recorded, [{ user: "Review frontend and backend independently, then combine the results", assistant: "done" }]);
	assert.equal(budgets.current("cli:local:local"), undefined);
	assert.deepEqual(runEvents.filter((event) => event.type === "planning_decision"), [{ type: "planning_decision", mode: "dag", concurrency: 2, maxSubagents: 2, requiredTools: ["task_plan_execute"] }]);
	runtime.dispose();
});

test("interactive runs persist an Objective and keep background DAG Objectives running", async () => {
	const source = { platform: "cli", chatId: "objective", chatType: "dm", userId: "local" };
	const tasks = new Map();
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
	};
	let listener;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy(),
		createAgent: async () => ({
			agent, subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "tool_execution_start", toolCallId: "plan", toolName: "task_plan_execute", args: {} });
				listener({ type: "tool_execution_end", toolCallId: "plan", toolName: "task_plan_execute", result: { details: { planId: "plan", accepted: true, status: "running" } }, isError: false });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "Work accepted" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});

	await runtime.run({ source, text: "Review frontend and backend independently, then combine the results", timeoutMs: 1_000 });

	const [objective] = [...tasks.values()];
	assert.equal(objective.kind, "objective");
	assert.equal(objective.ownerKey, "cli:objective:local");
	assert.equal(objective.description, "Review frontend and backend independently, then combine the results");
	assert.equal(objective.status, "running");
	runtime.dispose();
});

test("a direct conversational answer does not create durable Objective work", async () => {
	const source = { platform: "cli", chatId: "direct-objective", chatType: "dm", userId: "local" };
	const tasks = new Map();
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
	};
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({ taskLedger: ledger, planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent, subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "42" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });

	await runtime.run({ source, text: "What is the answer?", timeoutMs: 1_000 });

	assert.equal(tasks.size, 0);
	runtime.dispose();
});

test("an explicit continuation Turn reuses the active Objective", async () => {
	const source = { platform: "cli", chatId: "continued-objective", chatType: "dm", userId: "local" };
	const active = { id: "objective", ownerKey: "cli:continued-objective:local", kind: "objective", title: "Report", status: "running", createdAt: 1 };
	const recorded = [];
	const ledger = {
		record(task) { recorded.push(task); }, transition() { return true; },
		queryTasks: (query) => query.ownerKeys.includes(active.ownerKey) && query.statuses?.includes("running") ? [active] : [],
	};
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({ taskLedger: ledger, planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent, subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "Still running" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "继续处理这个任务", timeoutMs: 1_000 });
	assert.equal(recorded.length, 0);
	assert.equal(active.status, "running");
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
			if (prompts.length === 2) { listener({ type: "tool_execution_start", toolCallId: "plan", toolName: "task_plan_execute", args: {} }); listener({ type: "tool_execution_end", toolCallId: "plan", toolName: "task_plan_execute", result: { details: { planId: "plan-1", accepted: true, status: "running" } }, isError: false }); }
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

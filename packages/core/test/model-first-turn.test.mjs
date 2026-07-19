import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousPlanningPolicy, BeeMaxAgentRuntime } from "../dist/index.js";

const bindAssistantToolCall = (listener, call, responseId) => listener({
	type: "message_end",
	message: {
		role: "assistant",
		responseId,
		content: [{ type: "toolCall", id: call.id, name: call.name, arguments: call.args ?? {} }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	},
});

async function dispatchToolCall(agent, listener, call) {
	const responseId = `response:${call.id}`;
	bindAssistantToolCall(listener, call, responseId);
	listener({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args ?? {} });
	const blocked = await agent.beforeToolCall({
		assistantMessage: { role: "assistant", responseId },
		toolCall: { id: call.id, name: call.name, arguments: call.args ?? {} },
		args: call.args ?? {},
		context: {},
	}, new AbortController().signal);
	assert.equal(blocked, undefined);
	listener({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: call.result, isError: false });
}

test("an ordinary complex interactive task is model-first, adaptive, and turn-local", async () => {
	const request = "深入调研过去一周黄金走势，必要时拆分任务并给出高质量结论";
	const source = { platform: "cli", chatId: "model-first-report", chatType: "dm", userId: "local" };
	const planningInputs = [];
	const events = [];
	const activeToolChanges = [];
	let workContractCalls = 0;
	let listener;
	let activeTools = ["task_spawn", "task_wait"];
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const policy = new AutonomousPlanningPolicy();
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:model-first",
		taskLedger: {
			record: () => assert.fail("ordinary interactive work must not become a durable Objective before the model runs"),
			transition: () => assert.fail("ordinary interactive work must not transition a durable Objective"),
			queryTasks: () => [],
		},
		workContractBuilder: {
			build: async () => {
				workContractCalls++;
				assert.fail("ordinary interactive work must not invoke separate Work Contract cognition");
			},
		},
		planningPolicy: {
			decide(input) {
				planningInputs.push(input);
				return policy.decide(input);
			},
		},
		createAgent: async () => ({
			agent,
			getAllTools: () => [
				{ name: "task_spawn", description: "Delegate one bounded task", beemaxPolicy: { sideEffect: "local" } },
				{ name: "task_wait", description: "Wait for delegated task", beemaxPolicy: { sideEffect: "none" } },
			],
			getActiveToolNames: () => [...activeTools],
			setActiveToolsByName: (names) => { activeTools = [...names]; activeToolChanges.push([...names]); },
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				await dispatchToolCall(agent, listener, { id: "spawn:gold", name: "task_spawn", result: { details: { id: "task:gold", status: "queued" } } });
				await dispatchToolCall(agent, listener, { id: "wait:gold", name: "task_wait", args: { id: "task:gold" }, result: { details: { id: "task:gold", status: "completed" } } });
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:final", content: [{ type: "text", text: "调研结论已完成" }], usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "调研结论已完成" }], usage: { input: 2, output: 1 } }];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	try {
		const result = await runtime.run({ source, text: request, timeoutMs: 1_000 }, (event) => { events.push(event); });

		assert.equal(workContractCalls, 0);
		assert.deepEqual(planningInputs, [request]);
		assert.equal(result.answer, "调研结论已完成");
		assert.deepEqual(result.outcome, { status: "answered" });
		assert.deepEqual(events.filter((event) => event.type === "planning_decision").map((event) => ({ basis: event.basis, mode: event.mode })), [{ basis: "raw_prompt", mode: "delegate" }]);
		assert.ok(activeToolChanges[0].includes("task_spawn"));
		assert.ok(activeToolChanges[0].includes("task_wait"));
	} finally {
		runtime.dispose();
	}
});

test("an unrelated interactive request does not inherit an active durable Objective", async () => {
	const request = "查一下今天黄金市场有什么新变化";
	let workContractCalls = 0;
	const activeObjective = {
		id: "objective:existing",
		ownerKey: "cli:unrelated:local",
		kind: "objective",
		title: "之前的后台任务",
		description: "之前的后台任务",
		status: "running",
		createdAt: 1,
		acceptanceCriteria: [],
		executionScope: { platform: "cli", chatId: "unrelated", chatType: "dm", userId: "local" },
	};
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:model-first",
		taskLedger: {
			record: () => assert.fail("unrelated work must not create a durable Objective"),
			transition: () => true,
			queryTasks: () => [activeObjective],
		},
		workContractBuilder: { build: async () => { workContractCalls++; assert.fail("unrelated work must not enter Objective Contract cognition"); } },
		planningPolicy: new AutonomousPlanningPolicy(),
		createAgent: async () => ({
			agent,
			getAllTools: () => [],
			getActiveToolNames: () => [],
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "新的独立回答" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	try {
		const result = await runtime.run({ source: activeObjective.executionScope, text: request, timeoutMs: 1_000 });
		assert.equal(workContractCalls, 0);
		assert.deepEqual(result.outcome, { status: "answered" });
		assert.equal(result.answer, "新的独立回答");
	} finally {
		runtime.dispose();
	}
});

test("turn-local rewriting language is not mistaken for durable Objective correction", async () => {
	const request = "把这段话改成更简洁的版本：BeeMax 会根据任务按需加载工具";
	let workContractCalls = 0;
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:model-first",
		workContractBuilder: { build: async () => { workContractCalls++; assert.fail("turn-local rewriting must reach the main model directly"); } },
		planningPolicy: new AutonomousPlanningPolicy(),
		createAgent: async () => ({
			agent,
			getAllTools: () => [],
			getActiveToolNames: () => [],
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "BeeMax 按需加载工具。" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	try {
		const result = await runtime.run({ source: { platform: "cli", chatId: "rewrite", chatType: "dm", userId: "local" }, text: request, timeoutMs: 1_000 });
		assert.equal(workContractCalls, 0);
		assert.equal(result.answer, "BeeMax 按需加载工具。");
		assert.deepEqual(result.outcome, { status: "answered" });
	} finally {
		runtime.dispose();
	}
});

test("turn-local rewriting stays model-first when an unrelated durable Objective is active", async () => {
	const request = "把这段话改成更简洁的版本：BeeMax 会根据任务按需加载工具";
	const source = { platform: "cli", chatId: "rewrite-with-objective", chatType: "dm", userId: "local" };
	const activeObjective = {
		id: "objective:background-report",
		ownerKey: "cli:rewrite-with-objective:local",
		kind: "objective",
		title: "后台生成季度经营报告",
		description: "后台生成季度经营报告",
		status: "running",
		createdAt: 1,
		acceptanceCriteria: [],
		executionScope: source,
	};
	let workContractCalls = 0;
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:model-first",
		taskLedger: {
			record: () => assert.fail("turn-local rewriting must not create a durable Objective"),
			transition: () => true,
			queryTasks: () => [activeObjective],
		},
		workContractBuilder: { build: async () => { workContractCalls++; assert.fail("an unrelated active Objective must not force Contract cognition"); } },
		planningPolicy: new AutonomousPlanningPolicy(),
		createAgent: async () => ({
			agent,
			getAllTools: () => [],
			getActiveToolNames: () => [],
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "BeeMax 按需加载工具。" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	try {
		const result = await runtime.run({ source, text: request, timeoutMs: 1_000 });
		assert.equal(workContractCalls, 0);
		assert.equal(result.answer, "BeeMax 按需加载工具。");
		assert.deepEqual(result.outcome, { status: "answered" });
	} finally {
		runtime.dispose();
	}
});

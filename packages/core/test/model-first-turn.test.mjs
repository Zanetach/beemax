import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousPlanningPolicy, BeeMaxAgentRuntime } from "../dist/index.js";
import { attestCapabilityProviderResolutionTool } from "../dist/capability-provider.js";

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

async function activeToolsAtFirstModelPrompt({ request, chatId, tools }) {
	let activeTools = [];
	let activeAtFirstPrompt = [];
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:model-first",
		planningPolicy: new AutonomousPlanningPolicy(),
		createAgent: async () => ({
			agent,
			getAllTools: () => tools,
			getActiveToolNames: () => activeTools.length ? [...activeTools] : tools.map(({ name }) => name),
			setActiveToolsByName: (names) => { activeTools = [...names]; },
			subscribe: () => () => undefined,
			prompt: async () => {
				activeAtFirstPrompt = [...activeTools];
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	try {
		await runtime.run({ source: { platform: "cli", chatId, chatType: "dm", userId: "local" }, text: request, timeoutMs: 1_000 });
		return activeAtFirstPrompt;
	} finally {
		runtime.dispose();
	}
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

test("a model-first HTML and PDF report activates research, writing, and rendering on its first execution turn", async () => {
	const request = "做一份过去1一个月的黄金交易情况。输出PDF，HTML";
	const source = { platform: "cli", chatId: "model-first-html-pdf-report", chatType: "dm", userId: "local" };
	let activeTools = [];
	let activeAtFirstPrompt = [];
	let prefetchCalls = 0;
	let workContractCalls = 0;
	let listener;
	const traceEvents = [];
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const tools = [
		{
			name: "capability_discover",
			description: "Discover capabilities",
			beemaxCapabilityPrefetch: async () => {
				prefetchCalls++;
				return {
					cognitionId: "cap:model-first-html-pdf-report",
					candidates: [
						{ kind: "tool", name: "write", confidence: 0.75, necessity: "alternative" },
						{ kind: "tool", name: "artifact_render", confidence: 0.99 },
					],
					activatedTools: ["artifact_render"],
					skills: [],
				};
			},
		},
		{ name: "web_search", description: "Search current public web evidence", triggers: ["research", "过去一个月"], beemaxPolicy: { sideEffect: "none" } },
		{ name: "exa_web_search", description: "Search public web evidence through Exa", aliases: ["agent_reach_search"], beemaxPolicy: { sideEffect: "none" } },
		{ name: "write", description: "Write an HTML file in the workspace", triggers: ["HTML 文件", "生成 HTML"], beemaxPolicy: { sideEffect: "local" } },
		{ name: "artifact_render", description: "Render HTML into a PDF", triggers: ["PDF", "HTML to PDF"], beemaxPolicy: { sideEffect: "local" } },
		{ name: "unrelated_tool", description: "Perform an unrelated operation", beemaxPolicy: { sideEffect: "none" } },
	];
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:model-first",
		workContractBuilder: {
			build: async () => {
				workContractCalls++;
				assert.fail("ordinary report creation must remain model-first");
			},
		},
		planningPolicy: new AutonomousPlanningPolicy(),
		executionTrace: { record: (event) => { traceEvents.push(event); } },
		createAgent: async () => ({
			agent,
			getAllTools: () => tools,
			getActiveToolNames: () => activeTools.length ? [...activeTools] : tools.map(({ name }) => name),
			setActiveToolsByName: (names) => { activeTools = [...names]; },
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				activeAtFirstPrompt = [...activeTools];
				await dispatchToolCall(agent, listener, { id: "search:gold", name: "web_search", args: { query: "过去一个月黄金交易情况" }, result: { details: { resultCount: 3 } } });
				await dispatchToolCall(agent, listener, { id: "write:gold", name: "write", args: { path: "gold-report.html", content: "<html><body>report</body></html>" }, result: { details: { path: "gold-report.html" } } });
				await dispatchToolCall(agent, listener, { id: "render:gold", name: "artifact_render", args: { inputPath: "gold-report.html", outputPath: "gold-report.pdf" }, result: { details: { path: "gold-report.pdf" } } });
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:gold-report-final", content: [{ type: "text", text: "报告已生成" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "报告已生成" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	try {
		const result = await runtime.run({ source, text: request, timeoutMs: 1_000 });

		assert.equal(result.answer, "报告已生成");
		assert.equal(workContractCalls, 0);
		assert.equal(prefetchCalls, 1);
		assert.ok(activeAtFirstPrompt.includes("web_search"), "research must be available before the model starts the report");
		assert.ok(activeAtFirstPrompt.includes("write"), "HTML writing must be available before the model starts the report");
		assert.ok(activeAtFirstPrompt.includes("artifact_render"), "PDF rendering must be available before the model starts the report");
		assert.equal(activeAtFirstPrompt.includes("exa_web_search"), false, "one canonical search path is sufficient when web_search is available");
		assert.equal(activeAtFirstPrompt.includes("unrelated_tool"), false);
		const deterministicDecision = traceEvents.find((event) => event.type === "capability.decision" && event.cognitionId.startsWith("cap:core-turn-artifact-pipeline:"));
		assert.deepEqual(deterministicDecision?.candidates.map(({ name, necessity }) => ({ name, necessity })), [
			{ name: "web_search", necessity: "required" },
			{ name: "write", necessity: "required" },
			{ name: "artifact_render", necessity: "required" },
		]);
	} finally {
		runtime.dispose();
	}
});

test("a model-first HTML and PDF report uses Exa when the generic web search provider is not configured", async () => {
	const request = "做一份过去1一个月的黄金交易情况。输出PDF，HTML";
	const tools = [
		{
			name: "capability_discover",
			description: "Discover capabilities",
			beemaxCapabilityPrefetch: async () => ({
				cognitionId: "cap:model-first-exa-html-pdf-report",
				candidates: [{ kind: "tool", name: "artifact_render", confidence: 0.99 }],
				activatedTools: ["artifact_render"],
				skills: [],
			}),
		},
		{ name: "web_search", description: "Search current public web evidence", beemaxToolSpec: { configured: false, health: "configuration_required" }, beemaxPolicy: { sideEffect: "none" } },
		{ name: "exa_web_search", description: "Search current public web evidence through Exa", aliases: ["agent_reach_search"], beemaxToolSpec: { configured: true, health: "ready" }, beemaxPolicy: { sideEffect: "none" } },
		{ name: "write", description: "Write an HTML file in the workspace", beemaxPolicy: { sideEffect: "local" } },
		{ name: "artifact_render", description: "Render HTML into a PDF", beemaxPolicy: { sideEffect: "local" } },
	];
	const activeAtFirstPrompt = await activeToolsAtFirstModelPrompt({ request, chatId: "model-first-exa-html-pdf-report", tools });
	assert.ok(activeAtFirstPrompt.includes("exa_web_search"));
	assert.equal(activeAtFirstPrompt.includes("web_search"), false);
	assert.ok(activeAtFirstPrompt.includes("write"));
	assert.ok(activeAtFirstPrompt.includes("artifact_render"));
});

test("an HTML and PDF report exposes recovery instead of advertising an unconfigured search provider", async () => {
	const request = "做一份过去1一个月的黄金交易情况。输出PDF，HTML";
	const tools = [
		{
			name: "capability_discover",
			description: "Discover capabilities",
			beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:model-first-missing-search", candidates: [{ kind: "tool", name: "artifact_render", confidence: 0.99 }], activatedTools: ["artifact_render"], skills: [] }),
		},
		{ name: "web_search", description: "Search current public web evidence", beemaxToolSpec: { configured: false, health: "configuration_required" }, beemaxPolicy: { sideEffect: "none" } },
		{ name: "exa_web_search", description: "Search current public web evidence through Exa", beemaxToolSpec: { configured: false, health: "configuration_required" }, beemaxPolicy: { sideEffect: "none" } },
		{ name: "write", description: "Write an HTML file in the workspace", beemaxPolicy: { sideEffect: "local" } },
		{ name: "artifact_render", description: "Render HTML into a PDF", beemaxPolicy: { sideEffect: "local" } },
	];
	const activeAtFirstPrompt = await activeToolsAtFirstModelPrompt({ request, chatId: "model-first-missing-search", tools });
	assert.ok(activeAtFirstPrompt.includes("capability_discover"));
	assert.equal(activeAtFirstPrompt.includes("web_search"), false);
	assert.equal(activeAtFirstPrompt.includes("exa_web_search"), false);
	assert.ok(activeAtFirstPrompt.includes("write"));
	assert.ok(activeAtFirstPrompt.includes("artifact_render"));
});

test("trusted dynamic provider health selects the usable search route for an HTML and PDF report", async () => {
	const request = "做一份过去1一个月的黄金交易情况。输出PDF，HTML";
	const capabilityDiscover = attestCapabilityProviderResolutionTool({
		name: "capability_discover",
		description: "Discover capabilities",
		beemaxCapabilityPrefetch: async () => ({
			cognitionId: "cap:model-first-dynamic-search-health",
			candidates: [
				{ kind: "tool", name: "web_search", confidence: 0.95 },
				{ kind: "tool", name: "artifact_render", confidence: 0.99 },
			],
			activatedTools: ["web_search", "artifact_render"],
			skills: [],
			providerResolutions: [
				{ capability: "web_search", status: "blocked", candidates: [{ id: "generic-search", kind: "tool", installed: true, installable: false, health: { status: "unhealthy", reason: "probe failed" } }], blocker: { code: "provider_unhealthy", reason: "generic search probe failed", requiredConfiguration: [] } },
				{ capability: "exa_web_search", status: "ready", selected: { id: "exa-search", kind: "tool", installed: true, health: { status: "ready", evidenceRef: "health:exa-search" } } },
			],
		}),
	});
	const tools = [
		capabilityDiscover,
		{ name: "web_search", description: "Search current public web evidence", beemaxToolSpec: { configured: true, health: "ready" }, beemaxPolicy: { sideEffect: "none" } },
		{ name: "exa_web_search", description: "Search current public web evidence through Exa", beemaxToolSpec: { configured: false, health: "configuration_required" }, beemaxPolicy: { sideEffect: "none" } },
		{ name: "write", description: "Write an HTML file in the workspace", beemaxPolicy: { sideEffect: "local" } },
		{ name: "artifact_render", description: "Render HTML into a PDF", beemaxPolicy: { sideEffect: "local" } },
	];
	const activeAtFirstPrompt = await activeToolsAtFirstModelPrompt({ request, chatId: "model-first-dynamic-search-health", tools });
	assert.ok(activeAtFirstPrompt.includes("exa_web_search"));
	assert.equal(activeAtFirstPrompt.includes("web_search"), false);
	assert.ok(activeAtFirstPrompt.includes("write"));
	assert.ok(activeAtFirstPrompt.includes("artifact_render"));
});

test("discussing HTML and PDF does not activate an artifact creation pipeline", async () => {
	const tools = [
		{ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:model-first-provider-question", candidates: [], activatedTools: [], skills: [] }) },
		{ name: "write", description: "Write an HTML file in the workspace", beemaxPolicy: { sideEffect: "local" } },
		{ name: "artifact_render", description: "Render HTML into a PDF", triggers: ["PDF", "HTML to PDF"], beemaxPolicy: { sideEffect: "local" } },
	];
	for (const [index, request] of ["Which provider supports PDF and HTML?", "Write a comparison of PDF and HTML", "Write a report comparing PDF and HTML formats"].entries()) {
		const activeAtFirstPrompt = await activeToolsAtFirstModelPrompt({ request, chatId: `model-first-artifact-discussion-${index}`, tools });
		assert.equal(activeAtFirstPrompt.includes("write"), false, request);
		assert.equal(activeAtFirstPrompt.includes("artifact_render"), false, request);
	}
});

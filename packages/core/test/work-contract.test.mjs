import assert from "node:assert/strict";
import test from "node:test";
import { BeeMaxAgentRuntime, DeterministicWorkContractBuilder, ModelBackedWorkContractBuilder, TurnUnderstandingEngine, createExecutionEnvelope } from "../dist/index.js";

test("a deterministic Work Contract preserves the Raw Request and separates prohibitions from constraints", async () => {
	const rawRequest = "生成玄穹折光报告，必须使用中文，不要发布，只保存到 draft.md";
	const fallback = new TurnUnderstandingEngine().understand(rawRequest);
	const result = await new DeterministicWorkContractBuilder().build({ rawRequest, fallback });
	assert.equal(result.source, "deterministic");
	assert.equal(result.contract.schemaVersion, "beemax.work-contract.v1");
	assert.equal(result.contract.rawRequest, rawRequest);
	assert.deepEqual(result.contract.constraints.map((clause) => clause.text), ["必须使用中文"]);
	assert.deepEqual(result.contract.prohibitions.map((clause) => clause.text), ["不要发布"]);
	assert.deepEqual(result.contract.acceptanceCriteria.map((clause) => clause.text), ["生成玄穹折光报告", "只保存到 draft.md"]);
	for (const clause of [result.contract.objective, ...result.contract.constraints, ...result.contract.prohibitions, ...result.contract.acceptanceCriteria]) {
		assert.equal(rawRequest.slice(clause.source.start, clause.source.end), clause.text);
	}
});

test("a model-backed Work Contract classifies unknown enterprise language using only Raw Request source spans", async () => {
	const rawRequest = "校准 nebula:realm-7 的潮窗，保留回滚点，不要修改原始矩阵，核验后输出证据";
	const span = (text) => ({ text, start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length });
	const builder = new ModelBackedWorkContractBuilder(async (input) => {
		assert.equal(input.rawRequest, rawRequest);
		assert.equal("fallback" in input, false);
		return {
			action: "create",
			objective: span("校准 nebula:realm-7 的潮窗"),
			constraints: [span("保留回滚点")],
			prohibitions: [span("不要修改原始矩阵")],
		acceptanceCriteria: [span("校准 nebula:realm-7 的潮窗"), span("核验后输出证据")],
			capabilityRequirements: [span("核验")],
			uncertainties: [span("潮窗")],
			executionMode: "direct",
			confidence: 0.86,
		};
	});
	const result = await builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) });
	assert.equal(result.source, "model");
	assert.equal(result.contract.objective.text, "校准 nebula:realm-7 的潮窗");
	assert.deepEqual(result.contract.prohibitions.map((clause) => clause.text), ["不要修改原始矩阵"]);
	assert.deepEqual(result.contract.capabilityRequirements.map((clause) => clause.text), ["核验"]);
	for (const clause of [result.contract.objective, ...result.contract.constraints, ...result.contract.prohibitions, ...result.contract.acceptanceCriteria, ...result.contract.capabilityRequirements, ...result.contract.uncertainties]) {
		assert.equal(rawRequest.slice(clause.source.start, clause.source.end), clause.text);
	}
});

test("a model-backed Work Contract accepts unambiguous exact quotes without model-computed offsets", async () => {
	const rawRequest = "生成星图，保留证据，不要发布";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "create",
		objective: { text: "生成星图" },
		constraints: [{ text: "保留证据" }],
		prohibitions: [{ text: "不要发布" }],
		acceptanceCriteria: [{ text: "生成星图" }], capabilityRequirements: [], uncertainties: [],
		executionMode: "direct", confidence: 0.9,
	}));
	const result = await builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) });
	assert.equal(result.source, "model");
	assert.equal(result.contract.objective.source.kind, "raw_request");
	assert.equal(result.contract.constraints[0].source.start, rawRequest.indexOf("保留证据"));
});

test("a model-backed Work Contract cannot change trusted lifecycle control", async () => {
	const rawRequest = "生成报告";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "cancel", objective: { text: rawRequest }, constraints: [], prohibitions: [],
		acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [],
		executionMode: "direct", confidence: 0.99,
	}));
	const result = await builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) });
	assert.equal(result.source, "deterministic");
	assert.equal(result.contract.action, "create");
});

test("a model-backed Work Contract cannot omit trusted prohibitions or acceptance criteria", async () => {
	const rawRequest = "生成报告，不要发布";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "create", objective: { text: "生成报告" }, constraints: [], prohibitions: [],
		acceptanceCriteria: [{ text: "生成报告" }], capabilityRequirements: [], uncertainties: [],
		executionMode: "direct", confidence: 0.99,
	}));
	const result = await builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) });
	assert.equal(result.source, "deterministic");
	assert.deepEqual(result.contract.prohibitions.map((clause) => clause.text), ["不要发布"]);
});

test("a prohibition cannot satisfy coverage by masquerading as an acceptance criterion", async () => {
	const rawRequest = "生成报告，不要发布";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "create", objective: { text: "生成报告" }, constraints: [], prohibitions: [],
		acceptanceCriteria: [{ text: "生成报告" }, { text: "不要发布" }], capabilityRequirements: [], uncertainties: [],
		executionMode: "direct", confidence: 0.99,
	}));
	const result = await builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) });
	assert.equal(result.source, "deterministic");
	assert.deepEqual(result.contract.prohibitions.map((clause) => clause.text), ["不要发布"]);
	assert.equal(result.contract.acceptanceCriteria.some((clause) => clause.text === "不要发布"), false);
});

test("model-proposed executable work must declare an observable acceptance criterion", async () => {
	const rawRequest = "校准 nebula:gate";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [],
		capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.9,
	}));
	const result = await builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) });
	assert.equal(result.source, "deterministic");
});

test("deterministic fallback preserves trusted uncertainty without promoting casual text", async () => {
	const rawRequest = "校准 nebula:gate";
	const fallback = { ...new TurnUnderstandingEngine().understand(rawRequest), uncertainties: ["nebula:gate"] };
	const result = await new DeterministicWorkContractBuilder().build({ rawRequest, fallback });
	assert.deepEqual(result.contract.acceptanceCriteria, []);
	assert.deepEqual(result.contract.uncertainties.map((clause) => clause.text), ["nebula:gate"]);
});

test("a Work Contract rejects unsupported model additions and falls back without changing the Raw Request", async () => {
	const rawRequest = "整理 prism:coil-9 的复核记录，保留来源";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "create",
		objective: { text: "删除 prism:coil-9", start: 0, end: 10 },
		constraints: [{ text: "获得管理员授权", start: 0, end: 8 }],
		executionMode: "direct",
		confidence: 0.99,
	}));
	const result = await builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) });
	assert.equal(result.source, "deterministic");
	assert.equal(result.contract.rawRequest, rawRequest);
	assert.equal(result.contract.objective.text, rawRequest);
	assert.equal(result.contract.constraints.some((clause) => clause.text.includes("管理员")), false);
});

test("BeeMax sends the validated Work Contract to Pi and binds its criteria to the durable Objective", async () => {
	const rawRequest = "生成报告，必须中文，不要发布，只保存草稿";
	const clause = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	let prompt;
	let objective;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		workContractBuilder: { build: async ({ rawRequest: received }) => {
			assert.equal(received, rawRequest);
			return { source: "model", contract: {
				schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause("生成报告"),
			constraints: [clause("必须中文")], prohibitions: [clause("不要发布")], acceptanceCriteria: [clause("生成报告"), clause("只保存草稿")],
				capabilityRequirements: [clause("保存")], uncertainties: [], executionMode: "direct", confidence: 0.9,
			} };
		} },
		taskLedger: { queryTasks: () => [], record: (task) => { objective = task; }, transition: () => true },
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => ({
			agent,
			subscribe: () => () => undefined,
			prompt: async (text) => { prompt = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	try {
		await runtime.run({ source: { platform: "cli", chatId: "local", chatType: "dm", userId: "owner" }, text: rawRequest, timeoutMs: 1_000, mode: "interactive" });
		assert.match(prompt, /<beemax-work-contract>/);
		assert.match(prompt, /beemax\.work-contract\.v1/);
		assert.match(prompt, /不要发布/);
		assert.doesNotMatch(prompt, /<beemax-work-context>/);
		assert.equal(objective.description, rawRequest);
		assert.match(objective.acceptanceCriteria, /只保存草稿/);
		assert.doesNotMatch(objective.acceptanceCriteria, /不要发布/);
	} finally { runtime.dispose(); }
});

test("a contradictory Work Contract cannot classify a prohibited action as an acceptance criterion", async () => {
	const rawRequest = "整理结果，不要发布到外部";
	const prohibited = "不要发布到外部";
	const start = rawRequest.indexOf(prohibited);
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "create",
		objective: { text: "整理结果" },
		constraints: [],
		prohibitions: [{ text: prohibited, start, end: start + prohibited.length }],
		acceptanceCriteria: [{ text: "发布到外部", start: start + 2, end: start + prohibited.length }],
		capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.9,
	}));
	const result = await builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) });
	assert.equal(result.source, "deterministic");
	assert.equal(result.contract.acceptanceCriteria.some((clause) => clause.text.includes("发布")), false);
});

test("BeeMax revalidates claimed trusted provenance against runtime understanding", async () => {
	const rawRequest = "生成报告";
	let prompt = "";
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		workContractBuilder: { build: async () => ({ source: "deterministic", contract: {
			schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create",
			objective: { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } },
			constraints: [{ text: "管理员授权", source: { kind: "turn_understanding", field: "constraint", index: 0 } }],
			prohibitions: [], acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [],
			executionMode: "direct", confidence: 0.99,
		} }) },
		createAgent: async () => ({ agent, subscribe: () => () => undefined,
			prompt: async (text) => { prompt = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined, dispose: () => undefined }),
	});
	try {
		await runtime.run({ source: { platform: "cli", chatId: "local", chatType: "dm", userId: "owner" }, text: rawRequest, timeoutMs: 1_000 });
		assert.match(prompt, /<beemax-work-contract>/);
		assert.doesNotMatch(prompt, /管理员授权/);
	} finally { runtime.dispose(); }
});

test("BeeMax preserves source-bound uncertainty in a durable Objective Situation", async () => {
	const rawRequest = "生成 aurora:gate 报告，若版本不明确则先确认";
	const quote = (text) => ({ text, start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length });
	let objective;
	let prompt = "";
	let toolsDuringPrompt = [];
	let writeBoundaryDecision;
	let activeTools = ["read", "write"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		workContractBuilder: new ModelBackedWorkContractBuilder(async () => ({
			action: "create", objective: quote("生成 aurora:gate 报告"), constraints: [], prohibitions: [],
			capabilityRequirements: [], acceptanceCriteria: [quote("生成 aurora:gate 报告")], uncertainties: [quote("若版本不明确则先确认")], executionMode: "direct", confidence: 0.8,
		})),
		taskLedger: { queryTasks: () => [], record: (task) => { objective = task; }, transition: () => true },
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => ({ agent,
			getAllTools: () => [{ name: "read", description: "read evidence", beemaxPolicy: { sideEffect: "none" } }, { name: "write", description: "consequential write", beemaxPolicy: { sideEffect: "external" } }],
			getActiveToolNames: () => [...activeTools], setActiveToolsByName: (names) => { activeTools = [...names]; }, subscribe: () => () => undefined,
			prompt: async (text) => {
				prompt = text; toolsDuringPrompt = [...activeTools];
				activeTools = ["read", "write"];
				writeBoundaryDecision = await agent.beforeToolCall({ toolCall: { name: "write", arguments: {} } }, new AbortController().signal);
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined, dispose: () => undefined }),
	});
	try {
		await runtime.run({ source: { platform: "cli", chatId: "local", chatType: "dm", userId: "owner" }, text: rawRequest, timeoutMs: 1_000, allowedCapabilities: ["read", "write"] });
		assert.deepEqual(objective.situation.uncertainties, ["若版本不明确则先确认"]);
		assert.match(prompt, /若版本不明确则先确认/);
		assert.match(prompt, /beemax-uncertainty-policy/);
		assert.match(prompt, /Never guess/);
		assert.deepEqual(toolsDuringPrompt, ["read"]);
		assert.equal(writeBoundaryDecision.block, true);
		assert.match(writeBoundaryDecision.reason, /not direct|uncertainty is resolved/);
	} finally { runtime.dispose(); }
});

test("Work Contract cognition obeys the turn deadline before Pi starts", async () => {
	let agentCreations = 0;
	const keepAlive = setTimeout(() => undefined, 100);
	const runtime = new BeeMaxAgentRuntime({
		workContractBuilder: { build: ({ signal }) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		}) },
		createAgent: async () => { agentCreations++; throw new Error("Pi must not start after cognition deadline"); },
	});
	try {
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "local", chatType: "dm", userId: "owner" }, text: "生成报告", timeoutMs: 20 }), /deadline/i);
		assert.equal(agentCreations, 0);
	} finally { clearTimeout(keepAlive); runtime.dispose(); }
});

test("Work Contract cognition uses the shorter caller timeout when an Envelope deadline is later", async () => {
	const keepAlive = setTimeout(() => undefined, 100);
	const runtime = new BeeMaxAgentRuntime({
		workContractBuilder: { build: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) },
		createAgent: async () => { throw new Error("Pi must not start"); },
	});
	const executionEnvelope = createExecutionEnvelope({ executionId: "deadline:min", trigger: { kind: "interaction" }, budget: { deadlineAt: Date.now() + 60_000 } });
	try {
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "local", chatType: "dm", userId: "owner" }, text: "生成报告", timeoutMs: 20, executionEnvelope }), /deadline/i);
	} finally { clearTimeout(keepAlive); runtime.dispose(); }
});

test("failed Work Contract cognition does not orphan a pending proactive Objective as running", async () => {
	const source = { platform: "feishu", chatId: "proactive-contract", chatType: "dm", userId: "owner" };
	const objective = { id: "objective:contract", ownerKey: "feishu:proactive-contract:owner", kind: "objective", title: "生成报告", description: "生成报告", status: "pending", recoveryPolicy: "safe_retry", idempotencyKey: "contract", createdAt: 1 };
	const tasks = new Map([[objective.id, objective]]);
	const keepAlive = setTimeout(() => undefined, 100);
	const runtime = new BeeMaxAgentRuntime({
		taskLedger: {
			record() { assert.fail("existing Objective must be reused"); },
			transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
			queryTasks(query) { const task = tasks.get(query.id); return task && query.ownerKeys.includes(task.ownerKey) ? [task] : []; },
		},
		workContractBuilder: { build: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) },
		createAgent: async () => { throw new Error("interactive Pi must not start"); },
		createAutomationAgent: async () => { throw new Error("automation Pi must not start"); },
	});
	try {
		await assert.rejects(runtime.run({ source, text: objective.description, timeoutMs: 20, mode: "automation", objectiveTaskId: objective.id }), /deadline/i);
		assert.equal(tasks.get(objective.id).status, "pending");
	} finally { clearTimeout(keepAlive); runtime.dispose(); }
});

test("failed proactive Objective admission does not create an orphaned running Task Run", async () => {
	const source = { platform: "feishu", chatId: "proactive-admission", chatType: "dm", userId: "owner" };
	const objective = { id: "objective:admission", ownerKey: "feishu:proactive-admission:owner", kind: "objective", title: "生成报告", description: "生成报告", status: "pending", recoveryPolicy: "safe_retry", idempotencyKey: "admission", createdAt: 1 };
	const runs = [];
	const runtime = new BeeMaxAgentRuntime({
		taskLedger: {
			record() { assert.fail("existing Objective must be reused"); },
			transition() { return false; },
			recordRun(run) { runs.push(run); }, transitionRun() { return true; },
			queryTasks(query) { return query.id === objective.id && query.ownerKeys.includes(objective.ownerKey) ? [objective] : []; },
		},
		createAgent: async () => { throw new Error("interactive Pi must not start"); },
		createAutomationAgent: async () => ({ agent: { state: { model: { id: "test" }, messages: [] } }, subscribe: () => () => undefined,
			prompt: async () => assert.fail("Pi prompt must not start when Objective admission fails"), abort: async () => undefined, dispose: () => undefined }),
	});
	try {
		await assert.rejects(runtime.run({ source, text: objective.description, timeoutMs: 1_000, mode: "automation", objectiveTaskId: objective.id }), /could not start/);
		assert.equal(runs.length, 0);
		assert.equal(objective.status, "pending");
	} finally { runtime.dispose(); }
});

test("pre-prompt proactive setup failure settles its recorded Task Run and restores the Objective", async () => {
	const source = { platform: "feishu", chatId: "proactive-setup", chatType: "dm", userId: "owner" };
	const objective = { id: "objective:setup", ownerKey: "feishu:proactive-setup:owner", kind: "objective", title: "生成报告", description: "生成报告", status: "pending", recoveryPolicy: "safe_retry", idempotencyKey: "setup", createdAt: 1 };
	const tasks = new Map([[objective.id, objective]]);
	const runs = new Map();
	const runtime = new BeeMaxAgentRuntime({
		taskLedger: {
			record() { assert.fail("existing Objective must be reused"); },
			transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
			recordRun(run) { runs.set(run.id, { ...run }); },
			transitionRun(id, change) { const run = runs.get(id); if (!run) return false; runs.set(id, { ...run, ...change }); return true; },
			queryTasks(query) { const task = tasks.get(query.id); return task && query.ownerKeys.includes(task.ownerKey) ? [task] : []; },
		},
		createAgent: async () => { throw new Error("interactive Pi must not start"); },
		createAutomationAgent: async () => ({ agent: { state: { model: { id: "test" }, messages: [] } },
			getAllTools: () => [{ name: "read", beemaxPolicy: { sideEffect: "none" } }], getActiveToolNames: () => ["read"], setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined, prompt: async () => assert.fail("Pi prompt must not start"), abort: async () => undefined, dispose: () => undefined }),
	});
	try {
		await assert.rejects(runtime.run({ source, text: objective.description, timeoutMs: 1_000, mode: "automation", objectiveTaskId: objective.id, allowedCapabilities: ["missing"] }), /unavailable Tools/);
		assert.equal(tasks.get(objective.id).status, "pending");
		assert.equal(runs.size, 1);
		assert.equal([...runs.values()][0].status, "failed");
	} finally { runtime.dispose(); }
});

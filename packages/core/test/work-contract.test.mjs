import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousPlanningPolicy, BeeMaxAgentRuntime, DeterministicWorkContractBuilder, ModelBackedWorkContractBuilder, TurnUnderstandingEngine, WorkContractCognitionError, createExecutionEnvelope } from "../dist/index.js";
import { attestCapabilityProviderResolutionTool } from "../dist/capability-provider.js";

const createRuntime = (options) => new BeeMaxAgentRuntime({ profileId: "profile:test", ...options });
const semanticReview = Object.freeze({ schemaVersion: "beemax.work-contract-adjudication.v1", inventorySchemaVersion: "beemax.semantic-inventory.v1", primaryModelIdentity: "test/primary/test", reviewerModelIdentity: "test/reviewer/test", reviewMode: "different_models", independentSamples: true, cognitionUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: ["test/primary/test", "test/reviewer/test"] }, cognitionBudgetChargeTokens: 1 });

test("runtime without semantic Work Contract cognition blocks instead of silently using regex", async () => {
	let agents = 0;
	const runtime = new BeeMaxAgentRuntime({ profileId: "profile:test", createAgent: async () => { agents++; throw new Error("Pi must not start"); } });
	try {
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "no-cognition", userId: "user" }, text: "不要取消，继续做", timeoutMs: 1_000 }), /MODEL_UNAVAILABLE/i);
		assert.equal(agents, 0);
	} finally { runtime.dispose(); }
});

test("runtime rejects a model Contract builder that bypasses independent semantic adjudication", async () => {
	const rawRequest = "生成报告";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	let agents = 0;
	const runtime = createRuntime({
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } }) },
		createAgent: async () => { agents++; throw new Error("Pi must not start"); },
	});
	try {
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "unreviewed", userId: "user" }, text: rawRequest, timeoutMs: 1_000 }), /missing independent semantic adjudication/i);
		assert.equal(agents, 0);
	} finally { runtime.dispose(); }
});

test("runtime rejects a deterministic Builder that issues unreviewed Capability obligations", async () => {
	const rawRequest = "查询并归档";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	let agents = 0;
	const runtime = createRuntime({
		workContractBuilder: { build: async () => ({ source: "deterministic", contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [clause], uncertainties: [], executionMode: "direct", confidence: 1 } }) },
		createAgent: async () => { agents++; throw new Error("Pi must not start"); },
	});
	try {
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "unreviewed-capability", userId: "user" }, text: rawRequest, timeoutMs: 1_000 }), /missing independent semantic adjudication/i);
		assert.equal(agents, 0);
	} finally { runtime.dispose(); }
});

test("runtime cancellation retains Work Contract cognition usage already measured before abort", async () => {
	const controller = new AbortController();
	const cognitionUsage = { inputTokens: 2, outputTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.25, modelIdentities: ["test/primary/test"] };
	const runtime = createRuntime({
		workContractBuilder: { build: async () => { controller.abort(new Error("cancelled during review")); throw new WorkContractCognitionError("cancelled during review", cognitionUsage, controller.signal.reason); } },
		createAgent: async () => assert.fail("cancelled admission must not start Pi"),
	});
	try {
		const error = await runtime.run({ source: { platform: "cli", chatId: "cancel-usage", userId: "user" }, text: "生成报告", timeoutMs: 1_000, signal: controller.signal }).then(() => assert.fail("cancelled cognition must reject"), (cause) => cause);
		assert.deepEqual(error.cognitionUsage, cognitionUsage);
	} finally { runtime.dispose(); }
});

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

test("a validated semantic Work Contract owns lifecycle when compatibility classification disagrees", async () => {
	const rawRequest = "不要取消，继续做";
	const fallback = { ...new TurnUnderstandingEngine().understand(rawRequest), action: "cancel" };
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "continue", targetObjectiveId: "objective-a", objective: { text: "继续做" }, constraints: [], prohibitions: [{ text: "不要取消" }],
		acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [],
		executionMode: "direct", confidence: 0.99,
	}));
	const result = await builder.build({ rawRequest, fallback, activeObjectives: [{ id: "objective-a", title: "生成报告" }] });
	assert.equal(result.source, "model");
	assert.equal(result.contract.action, "continue");
	assert.deepEqual(result.contract.targetObjective, { kind: "active_objective", id: "objective-a" });
	assert.deepEqual(result.contract.prohibitions.map((clause) => clause.text), ["不要取消"]);
});

test("semantic Work Contracts preserve cross-language negation, reversal, and draft-only intent", async () => {
	const cases = [
		{ rawRequest: "Do not cancel X; continue Y", action: "continue", targetObjectiveId: "objective-y", objective: "continue Y", constraints: [], prohibitions: ["Do not cancel X"], acceptanceCriteria: [] },
		{ rawRequest: "Don't change the goal; revise Y", action: "correct", targetObjectiveId: "objective-y", objective: "revise Y", constraints: [], prohibitions: ["Don't change the goal"], acceptanceCriteria: ["revise Y"] },
		{ rawRequest: "无需发布，只保存草稿", action: "create", objective: "只保存草稿", constraints: [], prohibitions: ["无需发布"], acceptanceCriteria: ["只保存草稿"] },
		{ rawRequest: "不是不要继续，接着做", action: "continue", targetObjectiveId: "objective-y", objective: "接着做", constraints: ["不是不要继续"], prohibitions: [], acceptanceCriteria: [] },
	];
	for (const item of cases) {
		const quote = (text) => ({ text });
		const builder = new ModelBackedWorkContractBuilder(async () => ({
			action: item.action, ...(item.targetObjectiveId ? { targetObjectiveId: item.targetObjectiveId } : {}), objective: quote(item.objective),
			constraints: item.constraints.map(quote), prohibitions: item.prohibitions.map(quote), acceptanceCriteria: item.acceptanceCriteria.map(quote),
			capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.97,
		}));
		const result = await builder.build({ rawRequest: item.rawRequest, fallback: new TurnUnderstandingEngine().understand(item.rawRequest), activeObjectives: [{ id: "objective-y", title: "Y" }] });
		assert.equal(result.contract.action, item.action);
		assert.deepEqual(result.contract.targetObjective?.id, item.targetObjectiveId);
		assert.deepEqual(result.contract.constraints.map(({ text }) => text), item.constraints);
		assert.deepEqual(result.contract.prohibitions.map(({ text }) => text), item.prohibitions);
	}
});

test("an invalid semantic Objective target is a blocker rather than a compatibility fallback", async () => {
	const rawRequest = "继续做";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "continue", targetObjectiveId: "objective-b", objective: { text: rawRequest }, constraints: [], prohibitions: [],
		acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99,
	}));
	await assert.rejects(
		builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest, { activeObjective: "生成报告" }), activeObjectives: [{ id: "objective-a", title: "生成报告" }] }),
		/target does not match an active Objective/i,
	);
});

test("unavailable semantic Work Contract cognition is reported instead of executing a compatibility fallback", async () => {
	const rawRequest = "继续做";
	const builder = new ModelBackedWorkContractBuilder(async () => { throw new Error("semantic provider unavailable"); });
	await assert.rejects(
		builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest, { activeObjective: "生成报告" }), activeObjectives: [{ id: "objective-a", title: "生成报告" }] }),
		/semantic provider unavailable/i,
	);
});

test("a model-backed Work Contract cannot silently omit an uncovered user prohibition", async () => {
	const rawRequest = "生成报告，不要发布";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "create", objective: { text: "生成报告" }, constraints: [], prohibitions: [],
		acceptanceCriteria: [{ text: "生成报告" }], capabilityRequirements: [], uncertainties: [],
		executionMode: "direct", confidence: 0.99,
	}));
	await assert.rejects(builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) }), /semantic coverage is incomplete/i);
});

test("a prohibition cannot satisfy coverage by masquerading as an acceptance criterion", async () => {
	const rawRequest = "生成报告，不要发布";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "create", objective: { text: "生成报告" }, constraints: [], prohibitions: [],
		acceptanceCriteria: [{ text: "生成报告" }, { text: "不要发布" }], capabilityRequirements: [], uncertainties: [],
		executionMode: "direct", confidence: 0.99,
	}));
	await assert.rejects(builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) }), /omitted or misclassified|acceptance criterion cannot be a prohibition/i);
});

test("model-proposed executable work must declare an observable acceptance criterion", async () => {
	const rawRequest = "校准 nebula:gate";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [],
		capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.9,
	}));
	await assert.rejects(builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) }), /requires an observable acceptance criterion/i);
});

test("deterministic fallback preserves trusted uncertainty without promoting casual text", async () => {
	const rawRequest = "校准 nebula:gate";
	const fallback = { ...new TurnUnderstandingEngine().understand(rawRequest), uncertainties: ["nebula:gate"] };
	const result = await new DeterministicWorkContractBuilder().build({ rawRequest, fallback });
	assert.deepEqual(result.contract.acceptanceCriteria, []);
	assert.deepEqual(result.contract.uncertainties.map((clause) => clause.text), ["nebula:gate"]);
});

test("a Work Contract rejects unsupported model additions without executing a compatibility fallback", async () => {
	const rawRequest = "整理 prism:coil-9 的复核记录，保留来源";
	const builder = new ModelBackedWorkContractBuilder(async () => ({
		action: "create",
		objective: { text: "删除 prism:coil-9", start: 0, end: 10 },
		constraints: [{ text: "获得管理员授权", start: 0, end: 8 }],
		executionMode: "direct",
		confidence: 0.99,
	}));
	await assert.rejects(builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) }), /not supported by its Raw Request source span/i);
});

test("BeeMax sends the validated Work Contract to Pi and binds its criteria to the durable Objective", async () => {
	const rawRequest = "生成报告，必须中文，不要发布，只保存草稿";
	const clause = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	let prompt;
	let objective;
	let listener;
	const tasks = new Map();
	const runs = new Map();
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		attestCapabilityProviderResolutionTool({ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:save-draft", candidates: [{ kind: "tool", name: "save_draft", confidence: 0.99 }], activatedTools: ["save_draft"], skills: [] }) }),
		{ name: "save_draft", description: "Persist a draft", beemaxPolicy: { sideEffect: "local" } },
	];
	const runtime = createRuntime({
		workContractBuilder: { build: async ({ rawRequest: received }) => {
			assert.equal(received, rawRequest);
			return { source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: {
				schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause("生成报告"),
			constraints: [clause("必须中文")], prohibitions: [clause("不要发布")], acceptanceCriteria: [clause("生成报告"), clause("只保存草稿")],
				capabilityRequirements: [clause("保存")], uncertainties: [], executionMode: "direct", confidence: 0.9,
			} };
		} },
		taskLedger: {
			queryTasks: () => [],
			record: (task) => { objective = task; tasks.set(task.id, { ...task }); },
			transition: (id, change) => { const task = tasks.get(id); if (!task) return false; tasks.set(id, { ...task, ...change }); return true; },
			recordRun: (run) => { runs.set(run.id, { ...run }); },
			transitionRun: (id, change) => { const run = runs.get(id); if (!run) return false; runs.set(id, { ...run, ...change }); return true; },
			isTaskRunExecutionActive: (ownerKey, objectiveId, taskId, taskRunId) => {
				const task = tasks.get(taskId); const run = runs.get(taskRunId);
				return task?.ownerKey === ownerKey && task?.id === objectiveId && taskId === objectiveId && task?.status === "running"
					&& run?.taskId === taskId && run?.status === "running";
			},
			settleDirectObjectiveCompletion: (settlement) => {
				const task = tasks.get(settlement.objectiveId); const run = runs.get(settlement.taskRunId);
				if (!task || task.status !== "running" || !run || run.status !== "running") return false;
				tasks.set(task.id, { ...task, verificationStatus: "accepted", candidateResult: settlement.candidateResult });
				runs.set(run.id, { ...run, status: "succeeded" });
				return true;
			},
		},
		verifyObjectiveCandidate: async () => ({ accepted: true, evidence: "draft receipt" }),
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => ({
			agent,
			getAllTools: () => tools, getActiveToolNames: () => tools.map((tool) => tool.name), setActiveToolsByName: () => undefined,
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async (text) => {
				prompt = text;
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:save", content: [{ type: "toolCall", id: "save", name: "save_draft", arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				listener({ type: "tool_execution_start", toolCallId: "save", toolName: "save_draft", args: {} });
				assert.equal(await agent.beforeToolCall({ toolCall: { id: "save", name: "save_draft", arguments: {} }, args: {}, context: {} }, new AbortController().signal), undefined);
				listener({ type: "tool_execution_end", toolCallId: "save", toolName: "save_draft", isError: false, result: { content: [{ type: "text", text: "draft saved" }] } });
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:done", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
			},
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
	await assert.rejects(builder.build({ rawRequest, fallback: new TurnUnderstandingEngine().understand(rawRequest) }), /overlap/i);
});

test("BeeMax revalidates claimed trusted provenance against runtime understanding", async () => {
	const rawRequest = "生成报告";
	let prompt = "";
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
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
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "local", chatType: "dm", userId: "owner" }, text: rawRequest, timeoutMs: 1_000 }), /Work Contract admission blocked/i);
		assert.equal(prompt, "");
	} finally { runtime.dispose(); }
});

test("BeeMax blocks a low-confidence semantic Contract before Pi or Task mutation", async () => {
	const rawRequest = "生成报告";
	let agents = 0;
	let mutations = 0;
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	const runtime = createRuntime({
		minimumWorkContractConfidence: 0.75,
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.74 } }) },
		taskLedger: { queryTasks: () => [], record: () => { mutations++; }, transition: () => { mutations++; return true; } },
		createAgent: async () => { agents++; throw new Error("Pi must not start"); },
	});
	try {
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "low-confidence", userId: "user" }, text: rawRequest, timeoutMs: 1_000 }), /below the admission threshold/i);
		assert.equal(agents, 0);
		assert.equal(mutations, 0);
	} finally { runtime.dispose(); }
});

test("BeeMax charges auxiliary Work Contract cognition to the Execution Envelope before Pi", async () => {
	const rawRequest = "生成报告";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	let agents = 0;
	const runtime = createRuntime({
		workContractBuilder: { build: async () => { const cognitionUsage = { inputTokens: 4, outputTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 1, costUsd: 0.01, modelIdentities: ["test/primary/test", "test/reviewer/test"] }; return { source: "model", cognitionBudgetChargeTokens: 8, semanticAdjudication: { ...semanticReview, cognitionUsage, cognitionBudgetChargeTokens: 8 }, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.9 }, cognitionUsage }; } },
		createAgent: async () => { agents++; throw new Error("Pi must not start"); },
	});
	try {
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "cognition-budget", userId: "user" }, text: rawRequest, timeoutMs: 1_000, executionEnvelope: createExecutionEnvelope({ executionId: "cognition-budget", trigger: { kind: "interaction" }, budget: { maxTokens: 7 } }) }), /cognition exceeded.*token budget/i);
		assert.equal(agents, 0);
	} finally { runtime.dispose(); }
});

test("BeeMax does not start Pi when Work Contract cognition exactly exhausts the Execution Envelope", async () => {
	const rawRequest = "生成报告";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	const cognitionUsage = { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, modelIdentities: ["test/primary/test", "test/reviewer/test"] };
	let agents = 0;
	const runtime = createRuntime({
		workContractBuilder: { build: async () => ({ source: "model", cognitionUsage, cognitionBudgetChargeTokens: 10, semanticAdjudication: { ...semanticReview, cognitionUsage, cognitionBudgetChargeTokens: 10 }, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } }) },
		createAgent: async () => { agents++; throw new Error("Pi must not start"); },
	});
	try {
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "cognition-exhausted", userId: "user" }, text: rawRequest, timeoutMs: 1_000, executionEnvelope: createExecutionEnvelope({ executionId: "cognition-exhausted", trigger: { kind: "interaction" }, budget: { maxTokens: 10 } }) }), /exhausted.*token budget/i);
		assert.equal(agents, 0);
	} finally { runtime.dispose(); }
});

test("semantic admission and autonomous Pi execution use separate token budgets without hiding total usage", async () => {
	const rawRequest = "生成报告";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	const cognitionUsage = { inputTokens: 9_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1, modelIdentities: ["test/primary/test", "test/reviewer/test"] };
	let receivedCognitionLimit = "unset";
	let listener;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		planningPolicy: new AutonomousPlanningPolicy({ maxTokens: 12_000 }),
		workContractBuilder: { build: async ({ maxCognitionTokens }) => {
			receivedCognitionLimit = maxCognitionTokens;
			return { source: "model", cognitionUsage, cognitionBudgetChargeTokens: 1, semanticAdjudication: { ...semanticReview, cognitionUsage }, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } };
		} },
		createAgent: async () => ({
			agent,
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1_500, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1_500, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } }];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	try {
		const result = await runtime.run({ source: { platform: "cli", chatId: "split-budget", userId: "user" }, text: rawRequest, timeoutMs: 1_000 });
		assert.equal(receivedCognitionLimit, undefined, "the autonomous 12k Pi budget must not constrain semantic admission");
		assert.equal(result.answer, "done");
		assert.equal(result.usage.input_tokens, 10_500);
		assert.equal(result.usage.output_tokens, 1_500);
	} finally { runtime.dispose(); }
});

test("BeeMax preserves source-bound uncertainty in a durable Objective Situation", async () => {
	const rawRequest = "生成 aurora:gate 报告，若版本不明确则先确认";
	const quote = (text) => ({ text, start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length });
	let objective;
	let prompt = "";
	let toolsDuringPrompt = [];
	let writeBoundaryDecision;
	let listener;
	let activeTools = ["read", "write"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		workContractBuilder: { build: async (input) => ({ ...await new ModelBackedWorkContractBuilder(async () => ({
				action: "create", objective: quote("生成 aurora:gate 报告"), constraints: [], prohibitions: [],
				capabilityRequirements: [], acceptanceCriteria: [quote("生成 aurora:gate 报告")], uncertainties: [quote("若版本不明确则先确认")], executionMode: "direct", confidence: 0.8,
			})).build(input), cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview }) },
		taskLedger: { queryTasks: () => [], record: (task) => { objective = task; }, transition: () => true },
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) },
		createAgent: async () => ({ agent,
			getAllTools: () => [{ name: "read", description: "read evidence", beemaxPolicy: { sideEffect: "none" } }, { name: "write", description: "consequential write", beemaxPolicy: { sideEffect: "external" } }],
			getActiveToolNames: () => [...activeTools], setActiveToolsByName: (names) => { activeTools = [...names]; }, subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async (text) => {
				prompt = text; toolsDuringPrompt = [...activeTools];
				activeTools = ["read", "write"];
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:uncertain-write", content: [{ type: "toolCall", id: "write:uncertain", name: "write", arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				listener({ type: "tool_execution_start", toolCallId: "write:uncertain", toolName: "write", args: {} });
				writeBoundaryDecision = await agent.beforeToolCall({ toolCall: { id: "write:uncertain", name: "write", arguments: {} }, args: {}, context: {} }, new AbortController().signal);
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
	const runtime = createRuntime({
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
	const runtime = createRuntime({
		workContractBuilder: { build: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) },
		createAgent: async () => { throw new Error("Pi must not start"); },
	});
	const executionEnvelope = createExecutionEnvelope({ executionId: "deadline:min", trigger: { kind: "interaction" }, budget: { deadlineAt: Date.now() + 60_000 } });
	try {
		await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "local", chatType: "dm", userId: "owner" }, text: "生成报告", timeoutMs: 20, executionEnvelope }), /deadline/i);
	} finally { clearTimeout(keepAlive); runtime.dispose(); }
});

test("an admitted proactive Objective executes its durable meaning without fresh lifecycle cognition", async () => {
	const source = { platform: "feishu", chatId: "proactive-contract", chatType: "dm", userId: "owner" };
	const objective = { id: "objective:contract", ownerKey: "feishu:proactive-contract:owner", kind: "objective", title: "取消旧报告并保存证据", description: "取消旧报告并保存证据", status: "pending", recoveryPolicy: "safe_retry", idempotencyKey: "contract", createdAt: 1 };
	const tasks = new Map([[objective.id, objective]]);
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		taskLedger: {
			record() { assert.fail("existing Objective must be reused"); },
			transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
			queryTasks(query) { const task = tasks.get(query.id); return task && query.ownerKeys.includes(task.ownerKey) ? [task] : []; },
		},
		workContractBuilder: { build: async () => assert.fail("the admitted proactive Objective must not be reclassified") },
		createAgent: async () => { throw new Error("interactive Pi must not start"); },
		createAutomationAgent: async () => ({ agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "evidence saved" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }),
	});
	try {
		const result = await runtime.run({ source, text: objective.description, timeoutMs: 1_000, mode: "automation", objectiveTaskId: objective.id });
		assert.match(result.answer, /Verification|evidence saved/i);
		assert.equal(tasks.get(objective.id).status, "running");
	} finally { runtime.dispose(); }
});

test("proactive execution compiles the latest Objective revision as its effective Contract", async () => {
	const source = { platform: "feishu", chatId: "proactive-revision", chatType: "dm", userId: "owner" };
	const ownerKey = "feishu:proactive-revision:owner";
	const originalRaw = "Publish the report in English";
	const correctionRaw = "Do not publish; produce a Chinese draft";
	const original = { schemaVersion: "beemax.work-contract.v1", rawRequest: originalRaw, action: "create", objective: { text: originalRaw, source: { kind: "raw_request", start: 0, end: originalRaw.length } }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: originalRaw, source: { kind: "raw_request", start: 0, end: originalRaw.length } }], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.95 };
	const correctionObjective = "produce a Chinese draft";
	const correction = { schemaVersion: "beemax.work-contract.v1", rawRequest: correctionRaw, action: "correct", targetObjective: { kind: "active_objective", id: "objective:revision" }, objective: { text: correctionObjective, source: { kind: "raw_request", start: correctionRaw.indexOf(correctionObjective), end: correctionRaw.length } }, constraints: [], prohibitions: [{ text: "Do not publish", source: { kind: "raw_request", start: 0, end: 14 } }], acceptanceCriteria: [{ text: correctionObjective, source: { kind: "raw_request", start: correctionRaw.indexOf(correctionObjective), end: correctionRaw.length } }], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.98 };
	const situation = { summary: correctionObjective, goals: [correctionObjective], constraints: ["Do not publish"], uncertainties: [], observations: [], possibleActions: [], relevantMemoryIds: [], relevantTaskIds: ["objective:revision"], confidence: 0.98 };
	const objective = { id: "objective:revision", ownerKey, kind: "objective", title: "Report", description: originalRaw, workContract: original, objectiveRevisions: [{ id: "objective:revision:revision:1", workContract: correction, situation, createdAt: 2 }], situation, status: "running", createdAt: 1 };
	let prompt = "";
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		taskLedger: { queryTasks: (query) => query.id === objective.id && query.ownerKeys.includes(ownerKey) ? [objective] : [], transition: () => true },
		workContractBuilder: { build: async () => assert.fail("durable revision must be used without reclassification") },
		createAgent: async () => assert.fail("interactive Pi must not start"),
		createAutomationAgent: async () => ({ agent, subscribe: () => () => undefined, prompt: async (text) => { prompt = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "draft ready" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }),
	});
	try {
		await runtime.run({ source, text: originalRaw, timeoutMs: 1_000, mode: "automation", objectiveTaskId: objective.id });
		const effective = prompt.match(/<beemax-work-contract>\n([\s\S]*?)\n<\/beemax-work-contract>/)?.[1];
		assert.ok(effective);
		const contract = JSON.parse(effective);
		assert.equal(contract.action, "create");
		assert.equal(contract.targetObjective, undefined);
		assert.equal(contract.objective.text, correctionObjective);
		assert.deepEqual(contract.prohibitions.map(({ text }) => text), ["Do not publish"]);
	} finally { runtime.dispose(); }
});

test("failed proactive Objective admission does not create an orphaned running Task Run", async () => {
	const source = { platform: "feishu", chatId: "proactive-admission", chatType: "dm", userId: "owner" };
	const objective = { id: "objective:admission", ownerKey: "feishu:proactive-admission:owner", kind: "objective", title: "生成报告", description: "生成报告", status: "pending", recoveryPolicy: "safe_retry", idempotencyKey: "admission", createdAt: 1 };
	const runs = [];
	const runtime = createRuntime({
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
	const runtime = createRuntime({
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

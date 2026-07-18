import assert from "node:assert/strict";
import test from "node:test";
import {
	AutonomousPlanningPolicy,
	BeeMaxAgentRuntime,
	OPEN_WORLD_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
	WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
	WORK_CONTRACT_SCHEMA_VERSION,
	createContractAdmissionReceiptIntegrity,
	createExecutionEnvelope,
	createOpenWorldContract,
} from "../dist/index.js";
import { createAdmittedWorkContractPlanningInput } from "../dist/contract-planning-admission.js";

const rawRequest = "并行深入调研过去一周黄金走势，输出 HTML 和 PDF";
const runtimeGoldRequest = "调研过去一周黄金走势；输出 HTML；PDF";

function clause(text) {
	const start = rawRequest.indexOf(text);
	return { text, source: { kind: "raw_request", start, end: start + text.length } };
}

function runtimeGoldWorkContract() {
	const localClause = (text) => {
		const start = runtimeGoldRequest.indexOf(text);
		return { text, source: { kind: "raw_request", start, end: start + text.length } };
	};
	return workContract({
		rawRequest: runtimeGoldRequest,
		objective: localClause("调研过去一周黄金走势"),
		acceptanceCriteria: [localClause("调研过去一周黄金走势"), localClause("输出 HTML"), localClause("PDF")],
		capabilityRequirements: [],
		executionMode: "direct",
	});
}

function workContract(overrides = {}) {
	return {
		schemaVersion: WORK_CONTRACT_SCHEMA_VERSION,
		rawRequest,
		action: "create",
		objective: clause(rawRequest),
		constraints: [],
		prohibitions: [],
		acceptanceCriteria: [clause("过去一周黄金走势")],
		capabilityRequirements: [clause("调研过去一周黄金走势")],
		uncertainties: [],
		executionMode: "plan",
		confidence: 0.98,
		...overrides,
	};
}

function admission(contract) {
	const cognitionUsage = { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, modelIdentities: ["primary/model", "reviewer/model"] };
	return {
		contract,
		source: "model",
		cognitionUsage,
		cognitionBudgetChargeTokens: 100,
		semanticAdjudication: {
			schemaVersion: WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
			inventorySchemaVersion: "beemax.semantic-inventory.v1",
			primaryModelIdentity: "primary/model",
			reviewerModelIdentity: "reviewer/model",
			reviewMode: "different_models",
			independentSamples: true,
			cognitionUsage,
			cognitionBudgetChargeTokens: 100,
		},
	};
}

function planningAdmission(contract) {
	return createAdmittedWorkContractPlanningInput(admission(contract));
}

test("an admitted atomic Work Contract, not raw prompt keywords, determines execution shape", () => {
	const policy = new AutonomousPlanningPolicy();
	const contract = workContract();
	assert.throws(() => policy.decide(contract), /admitted Work Contract/i);
	assert.throws(() => policy.decide(admission(contract)), /admitted Work Contract/i);
	assert.throws(() => policy.decide(null), /admitted Work Contract/i);
	assert.throws(() => policy.decide({ source: "model", contract: undefined }), /admitted Work Contract/i);
	const decision = policy.decide(planningAdmission(contract));

	assert.equal(decision.basis, "work_contract");
	assert.equal(decision.mode, "direct");
	assert.equal(decision.suggestedConcurrency, 1);
	assert.equal(decision.budget.maxSubagents, 0);
	assert.equal(decision.verificationDepth, "criterion");
	assert.deepEqual(decision.contractCoverage?.outcomeIds, ["criterion:0"]);
	assert.deepEqual(decision.contractCoverage?.capabilityRequirementIds, ["capability:0"]);
});

test("an admitted compatibility Work Contract preserves temporal research routing without raw-prompt planning", () => {
	const request = "查一下今天的天气";
	const contract = workContract({
		rawRequest: request,
		action: "query",
		objective: { text: request, source: { kind: "raw_request", start: 0, end: request.length } },
		acceptanceCriteria: [],
		capabilityRequirements: [],
		executionMode: "direct",
	});
	const decision = new AutonomousPlanningPolicy().decide(planningAdmission(contract));

	assert.equal(decision.basis, "work_contract");
	assert.equal(decision.signals.requiresResearch, true);
	assert.equal(decision.mode, "direct");
});

test("an admitted direct execution boundary cannot be escalated to delegation", () => {
	const contract = workContract({
		acceptanceCriteria: [clause("过去一周黄金走势"), clause("输出 HTML"), clause("PDF")],
		capabilityRequirements: [clause("调研过去一周黄金走势"), clause("输出 HTML"), clause("PDF")],
		executionMode: "direct",
	});
	const decision = new AutonomousPlanningPolicy().decide(planningAdmission(contract));

	assert.equal(decision.mode, "direct");
	assert.equal(decision.budget.maxSubagents, 0);
	assert.deepEqual(decision.requiredTools, []);
	assert.match(decision.reason, /direct execution boundary/i);
});

test("an admitted prohibition against delegation keeps planned work in the parent Agent", () => {
	const request = `${rawRequest}，不得使用子代理`;
	const sourceClause = (text) => {
		const start = request.indexOf(text);
		return { text, source: { kind: "raw_request", start, end: start + text.length } };
	};
	const contract = workContract({
		rawRequest: request,
		objective: sourceClause(request),
		prohibitions: [sourceClause("不得使用子代理")],
		acceptanceCriteria: [sourceClause("过去一周黄金走势"), sourceClause("输出 HTML"), sourceClause("PDF")],
		capabilityRequirements: [sourceClause("调研过去一周黄金走势"), sourceClause("输出 HTML"), sourceClause("PDF")],
		executionMode: "plan",
	});
	const decision = new AutonomousPlanningPolicy().decide(planningAdmission(contract));

	assert.equal(decision.mode, "direct");
	assert.equal(decision.budget.maxSubagents, 0);
	assert.match(decision.reason, /prohibits delegation/i);
});

test("parent-only execution constraints keep planned work in the parent Agent across natural phrasings", () => {
	for (const parentOnlyConstraint of ["所有工作必须由父代理执行", "只能由主代理执行", "must be executed by the parent agent", "This task should be handled solely by the parent agent", "任务应由父代理独立完成", "由主代理直接完成，不启用子任务"]) {
		const request = `${rawRequest}，${parentOnlyConstraint}`;
		const sourceClause = (text) => {
			const start = request.indexOf(text);
			return { text, source: { kind: "raw_request", start, end: start + text.length } };
		};
		const contract = workContract({
			rawRequest: request,
			objective: sourceClause(request),
			constraints: [sourceClause(parentOnlyConstraint)],
			acceptanceCriteria: [sourceClause("过去一周黄金走势"), sourceClause("输出 HTML"), sourceClause("PDF")],
			capabilityRequirements: [sourceClause("调研过去一周黄金走势"), sourceClause("输出 HTML"), sourceClause("PDF")],
			executionMode: "plan",
		});
		const decision = new AutonomousPlanningPolicy().decide(planningAdmission(contract));

		assert.equal(decision.mode, "direct", parentOnlyConstraint);
		assert.equal(decision.budget.maxSubagents, 0, parentOnlyConstraint);
		assert.match(decision.reason, /prohibits delegation/i);
	}
});

test("an explicit no-Sub-Task clause remains binding when fused into a broader constraint", () => {
	const constraint = "新建一个独立验收目标，不启用子任务。使用现有文件";
	const request = `${rawRequest}，${constraint}`;
	const sourceClause = (text) => {
		const start = request.indexOf(text);
		return { text, source: { kind: "raw_request", start, end: start + text.length } };
	};
	const contract = workContract({
		rawRequest: request,
		objective: sourceClause(request),
		constraints: [sourceClause(constraint)],
		acceptanceCriteria: [sourceClause("过去一周黄金走势"), sourceClause("输出 HTML"), sourceClause("PDF")],
		capabilityRequirements: [sourceClause("调研过去一周黄金走势"), sourceClause("输出 HTML"), sourceClause("PDF")],
		executionMode: "plan",
	});

	const decision = new AutonomousPlanningPolicy().decide(planningAdmission(contract));
	assert.equal(decision.mode, "direct");
	assert.equal(decision.budget.maxSubagents, 0);
	assert.deepEqual(decision.requiredTools, []);
	assert.match(decision.reason, /prohibits delegation/i);
});

test("a parent Agent reviewing Sub-Agent work does not prohibit delegation", () => {
	for (const reviewConstraint of [
		"The parent agent must review work completed by subagents",
		"父代理必须审核子代理完成的工作",
		"Only the parent agent may review results; subagents can execute tasks",
		"仅父代理负责审核，子代理执行任务",
		"由父代理负责审核子代理完成的工作",
	]) {
		const request = `${rawRequest}，${reviewConstraint}`;
		const sourceClause = (text) => {
			const start = request.indexOf(text);
			return { text, source: { kind: "raw_request", start, end: start + text.length } };
		};
		const contract = workContract({
			rawRequest: request,
			objective: sourceClause(request),
			constraints: [sourceClause(reviewConstraint)],
			acceptanceCriteria: [sourceClause("过去一周黄金走势"), sourceClause("输出 HTML"), sourceClause("PDF")],
			capabilityRequirements: [sourceClause("调研过去一周黄金走势"), sourceClause("输出 HTML"), sourceClause("PDF")],
			executionMode: "plan",
		});
		const decision = new AutonomousPlanningPolicy().decide(planningAdmission(contract));

		assert.equal(decision.mode, "delegate", reviewConstraint);
		assert.equal(decision.budget.maxSubagents, 1, reviewConstraint);
	}
});

test("an explicit outcome dependency graph derives DAG parallelism and independent artifact verification", () => {
	const contract = workContract({
		acceptanceCriteria: [clause("调研过去一周黄金走势"), clause("输出 HTML"), clause("PDF")],
		capabilityRequirements: [clause("调研过去一周黄金走势"), clause("输出 HTML"), clause("PDF")],
	});
	const openWorld = createOpenWorldContract({
		id: "contract:gold-report",
		admission: planningAdmission(contract),
		outcomes: [
			{ id: "outcome:research", acceptanceCriterionIndex: 0, capabilityRequirementIds: ["capability:research"], evidenceRequirementIds: ["evidence:sources"] },
			{ id: "outcome:html", acceptanceCriterionIndex: 1, dependsOnOutcomeIds: ["outcome:research"], capabilityRequirementIds: ["capability:html"], artifactRequirementIds: ["artifact:html"], evidenceRequirementIds: ["evidence:html"] },
			{ id: "outcome:pdf", acceptanceCriterionIndex: 2, dependsOnOutcomeIds: ["outcome:research"], capabilityRequirementIds: ["capability:pdf"], artifactRequirementIds: ["artifact:pdf"], evidenceRequirementIds: ["evidence:pdf"] },
		],
		capabilityRequirements: [
			{ id: "capability:research", workContractClauseIndex: 0, operation: "observe", expectedOutputs: ["market-source-records"] },
			{ id: "capability:html", workContractClauseIndex: 1, operation: "transform", expectedOutputs: ["text/html"] },
			{ id: "capability:pdf", workContractClauseIndex: 2, operation: "transform", expectedOutputs: ["application/pdf"] },
		],
		artifactRequirements: [
			{ id: "artifact:html", mediaType: "text/html", role: "deliverable", verification: ["integrity", "semantic", "render", "consistency"] },
			{ id: "artifact:pdf", mediaType: "application/pdf", role: "deliverable", verification: ["integrity", "semantic", "render", "consistency"] },
		],
		evidenceRequirements: [
			{ id: "evidence:sources", kinds: ["observation", "freshness", "semantic"] },
			{ id: "evidence:html", kinds: ["artifact", "render", "consistency"] },
			{ id: "evidence:pdf", kinds: ["artifact", "render", "consistency"] },
		],
	});

	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 4, maxSubagents: 5 });
	assert.throws(() => policy.decide(structuredClone(openWorld)), /factory-admitted Open-World Contract/i);
	const decision = policy.decide(openWorld);

	assert.equal(decision.basis, "open_world_contract");
	assert.equal(decision.mode, "dag");
	assert.equal(decision.suggestedConcurrency, 2);
	assert.equal(decision.verificationDepth, "independent");
	assert.equal(decision.signals.requiresResearch, true);
	assert.equal(decision.contractCoverage?.parallelWidth, 2);
	assert.deepEqual(decision.contractCoverage?.outcomeIds, ["outcome:research", "outcome:html", "outcome:pdf"]);
	assert.match(decision.directive("objective:gold"), /contract:gold-report/);
});

test("a simple conversational query uses the direct lane without semantic Work Contract cognition", async () => {
	const request = "解释合同驱动";
	let contractCognitionCalls = 0;
	let promptText = "";
	const runEvents = [];
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:test",
		turnUnderstanding: { understand: () => ({ action: "query", goal: request, constraints: [], acceptanceCriteria: [], uncertainties: [], memoryQuery: request, capabilityQuery: request, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => { contractCognitionCalls++; throw new Error("simple direct queries must not invoke semantic Contract cognition"); } },
		planningPolicy: new AutonomousPlanningPolicy(),
		createAgent: async () => ({
			agent,
			getAllTools: () => [],
			getActiveToolNames: () => [],
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			prompt: async (text) => {
				promptText = text;
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "合同驱动解释" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	try {
		const result = await runtime.run({ source: { platform: "cli", chatId: "adaptive-direct", chatType: "dm", userId: "local" }, text: request, timeoutMs: 1_000 }, (event) => { runEvents.push(event); });

		assert.equal(result.answer, "合同驱动解释");
		assert.equal(contractCognitionCalls, 0);
		assert.match(promptText, /basis=raw_prompt/);
		assert.deepEqual(runEvents.filter((event) => event.type === "planning_decision").map((event) => ({ basis: event.basis, mode: event.mode })), [{ basis: "raw_prompt", mode: "direct" }]);
	} finally { runtime.dispose(); }
});

test("ordinary interactive queries remain model-first across dynamic and composite language", async () => {
	const requests = [
		"What happened in the stock market yesterday?",
		"Find sources about post-quantum migration",
		"Which studies support this claim?",
		"How did revenue change last quarter?",
		"Explain idempotency and delete all files",
		"What is Apple's stock price?",
		"Explain whether flight BA123 is delayed",
		"Explain idempotency plus purge the database",
		"Explain my recent transactions",
		"解释我的最近交易",
		"Explain idempotency versus deduplication",
		"解释幂等性与去重",
	];
	let contractCognitionCalls = 0;
	const planningBases = [];
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:test",
		turnUnderstanding: { understand: (request) => ({ action: "query", goal: request, constraints: [], acceptanceCriteria: [], uncertainties: [], memoryQuery: request, capabilityQuery: request, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => { contractCognitionCalls++; assert.fail("ordinary interactive work must reach the main model directly"); } },
		planningPolicy: new AutonomousPlanningPolicy(),
		createAgent: async () => ({
			agent,
			getAllTools: () => [],
			getActiveToolNames: () => [],
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			prompt: async () => {
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "model-first result" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	try {
		for (const [index, request] of requests.entries()) {
			await runtime.run({ source: { platform: "cli", chatId: `adaptive-fail-closed-${index}`, chatType: "dm", userId: "local" }, text: request, timeoutMs: 1_000 }, (event) => {
				if (event.type === "planning_decision") planningBases.push(event.basis);
			});
		}

		assert.equal(contractCognitionCalls, 0);
		assert.deepEqual(planningBases, requests.map(() => "raw_prompt"));
	} finally { runtime.dispose(); }
});

test("a research query is model-first interactively while Automation remains Contract-governed", async () => {
	const request = "查一下今天的天气";
	const requestClause = { text: request, source: { kind: "raw_request", start: 0, end: request.length } };
	const contract = workContract({
		rawRequest: request,
		action: "query",
		objective: requestClause,
		acceptanceCriteria: [],
		capabilityRequirements: [],
		executionMode: "direct",
	});
	let semanticallyAdmitted = false;
	let planningInput;
	let promptText = "";
	const runEvents = [];
	const policy = new AutonomousPlanningPolicy();
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:test",
		turnUnderstanding: { understand: () => ({ action: "query", goal: request, constraints: [], acceptanceCriteria: [], uncertainties: [], memoryQuery: request, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => { semanticallyAdmitted = true; return admission(contract); } },
		planningPolicy: { decide: (input) => {
			planningInput = input;
			return policy.decide(input);
		} },
		createAgent: async () => ({
			agent,
			getAllTools: () => [],
			getActiveToolNames: () => [],
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			prompt: async (text) => {
				promptText = text;
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "天气查询结果" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	await runtime.run({ source: { platform: "cli", chatId: "contract-plan", chatType: "dm", userId: "local" }, text: request, timeoutMs: 1_000 }, (event) => { runEvents.push(event); });

	assert.equal(semanticallyAdmitted, false);
	assert.equal(planningInput, request);
	assert.match(promptText, /basis=raw_prompt/);
	assert.doesNotMatch(promptText, /basis=work_contract/);
	assert.deepEqual(runEvents.filter((event) => event.type === "planning_decision"), [{
		type: "planning_decision",
		mode: "direct",
		basis: "raw_prompt",
		verificationDepth: "none",
		concurrency: 1,
		maxSubagents: 0,
		requiredTools: [],
	}]);

	const automationEvents = [];
	await runtime.run({
		source: { platform: "cli", chatId: "contract-plan-automation", chatType: "dm", userId: "local" },
		text: request,
		timeoutMs: 1_000,
		mode: "automation",
		executionEnvelope: createExecutionEnvelope({ executionId: "execution:contract-plan-automation", trigger: { kind: "automation", id: "schedule:contract-plan" } }),
	}, (event) => { automationEvents.push(event); });
	assert.equal(semanticallyAdmitted, true);
	assert.deepEqual(automationEvents.filter((event) => event.type === "planning_decision").map((event) => event.basis), ["work_contract"]);
	runtime.dispose();
});

test("Agent runtime compiles a reviewed OpenWorld graph without imposing an execution token ceiling on cognition", async () => {
	const contract = runtimeGoldWorkContract();
	let compilerBudget;
	let planningInput;
	let promptText = "";
	const policy = new AutonomousPlanningPolicy();
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:test",
		interactiveAdmission: "contract_first",
		turnUnderstanding: { understand: () => ({ action: "create", goal: runtimeGoldRequest, constraints: [], acceptanceCriteria: ["调研过去一周黄金走势", "输出 HTML", "PDF"], uncertainties: [], memoryQuery: runtimeGoldRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => admission(contract) },
		openWorldContractCompiler: { compile: async ({ admission: admitted, maxCognitionTokens }) => {
			compilerBudget = maxCognitionTokens;
			return reviewedOpenWorldCompilation(admitted);
		} },
		planningPolicy: { decide: (input) => { planningInput = input; return policy.decide(input); } },
		createAgent: async () => ({
			agent,
			getAllTools: () => [],
			getActiveToolNames: () => [],
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			prompt: async (text) => {
				promptText = text;
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "已完成" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	const result = await runtime.run({
		source: { platform: "cli", chatId: "open-world-plan", chatType: "dm", userId: "local" },
		text: runtimeGoldRequest,
		timeoutMs: 1_000,
		executionEnvelope: createExecutionEnvelope({ executionId: "execution:open-world-plan", trigger: { kind: "interaction" }, budget: { maxTokens: 1_000 } }),
	});

	assert.equal(compilerBudget, undefined);
	assert.equal(planningInput.schemaVersion, "beemax.open-world-contract.v1");
	assert.match(promptText, /basis=open_world_contract/);
	assert.match(promptText, /verificationDepth=independent/);
	assert.deepEqual(result.usage, { input_tokens: 25, output_tokens: 13 });
	runtime.dispose();
});

test("a restarted runtime revalidates the durable OpenWorld admission without rerunning cognition and rejects expiry before Pi", async () => {
	const contract = runtimeGoldWorkContract();
	const tasks = new Map();
	const contractAdmissionIntegrity = createContractAdmissionReceiptIntegrity({ key: Buffer.alloc(32, 5), profileId: "profile:test" });
	const ledger = {
		record(task) { tasks.set(task.id, structuredClone(task)); },
		transition(id, change) { const task = tasks.get(id); if (!task) return false; tasks.set(id, { ...task, ...structuredClone(change) }); return true; },
		queryTasks(query) {
			return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey)
				&& (!query.id || task.id === query.id)
				&& (!query.kinds || query.kinds.includes(task.kind))
				&& (!query.statuses || query.statuses.includes(task.status)));
		},
	};
	const source = { platform: "cli", chatId: "durable-open-world", chatType: "dm", userId: "local" };
	const agentFactory = () => {
		const agent = { state: { model: { id: "test/model" }, messages: [] } };
		return {
			agent,
			getAllTools: () => [],
			getActiveToolNames: () => [],
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "已执行" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined,
			dispose: () => undefined,
		};
	};
	const first = new BeeMaxAgentRuntime({
		profileId: "profile:test",
		interactiveAdmission: "contract_first",
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy(),
		turnUnderstanding: { understand: () => ({ action: "create", goal: runtimeGoldRequest, constraints: [], acceptanceCriteria: ["调研过去一周黄金走势", "输出 HTML", "PDF"], uncertainties: [], memoryQuery: runtimeGoldRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => admission(contract) },
		openWorldContractCompiler: { compile: async ({ admission: admitted }) => reviewedOpenWorldCompilation(admitted) },
		contractAdmissionIntegrity,
		createAgent: async () => agentFactory(),
	});
	await first.run({ source, text: runtimeGoldRequest, timeoutMs: 1_000 });
	first.dispose();
	const objective = [...tasks.values()][0];
	assert.equal(objective.contractAdmission.schemaVersion, "beemax.durable-contract-admission.v2");
	assert.equal(objective.contractAdmission.openWorld.snapshot.id, "contract:runtime-gold-report");

	let cognitionCalls = 0;
	let piCalls = 0;
	const restoredEvents = [];
	const restored = new BeeMaxAgentRuntime({
		profileId: "profile:test",
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy(),
		turnUnderstanding: { understand: () => ({ action: "continue", goal: runtimeGoldRequest, constraints: [], acceptanceCriteria: [], uncertainties: [], memoryQuery: runtimeGoldRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => { cognitionCalls++; throw new Error("must not rebuild an admitted Objective"); } },
		openWorldContractCompiler: { compile: async () => { cognitionCalls++; throw new Error("must not recompile an admitted Objective"); } },
		contractAdmissionIntegrity,
		createAgent: async () => { piCalls++; return agentFactory(); },
	});
	await restored.run({
		source,
		text: runtimeGoldRequest,
		timeoutMs: 1_000,
		mode: "automation",
		objectiveTaskId: objective.id,
		executionEnvelope: createExecutionEnvelope({ executionId: "execution:durable-restore", trigger: { kind: "automation", id: "schedule:durable-restore" } }),
	}, (event) => { restoredEvents.push(event); });
	assert.equal(cognitionCalls, 0);
	assert.equal(piCalls, 1);
	assert.deepEqual(restoredEvents.filter((event) => event.type === "planning_decision").map((event) => event.basis), ["open_world_contract"]);
	restored.dispose();

	const current = tasks.get(objective.id);
	tasks.set(objective.id, { ...current, contractAdmission: { ...structuredClone(current.contractAdmission), admittedAt: 0, expiresAt: 1 } });
	let expiredPiCalls = 0;
	const expired = new BeeMaxAgentRuntime({
		profileId: "profile:test",
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy(),
		contractAdmissionIntegrity,
		turnUnderstanding: { understand: () => ({ action: "continue", goal: runtimeGoldRequest, constraints: [], acceptanceCriteria: [], uncertainties: [], memoryQuery: runtimeGoldRequest, executionMode: "direct", confidence: 1 }) },
		createAgent: async () => { expiredPiCalls++; return agentFactory(); },
	});
	await assert.rejects(expired.run({
		source,
		text: runtimeGoldRequest,
		timeoutMs: 1_000,
		mode: "automation",
		objectiveTaskId: objective.id,
		executionEnvelope: createExecutionEnvelope({ executionId: "execution:expired-restore", trigger: { kind: "automation", id: "schedule:expired-restore" } }),
	}), /admission authentication failed/i);
	assert.equal(expiredPiCalls, 0);
	expired.dispose();
});

test("a signed correction admission binds every earlier Objective revision before restarted Pi execution", async () => {
	const tasks = new Map();
	const integrity = createContractAdmissionReceiptIntegrity({ key: Buffer.alloc(32, 6), profileId: "profile:revision-chain" });
	const ledger = {
		record(task) { tasks.set(task.id, structuredClone(task)); },
		transition(id, change) { const task = tasks.get(id); if (!task) return false; tasks.set(id, { ...task, ...structuredClone(change) }); return true; },
		queryTasks(query) {
			return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey)
				&& (!query.id || task.id === query.id)
				&& (!query.kinds || query.kinds.includes(task.kind))
				&& (!query.statuses || query.statuses.includes(task.status)));
		},
		reviseObjective(ownerKey, id, revision, now) {
			const task = tasks.get(id);
			if (!task || task.ownerKey !== ownerKey) return undefined;
			const revisions = [...(task.objectiveRevisions ?? []), { id: `${id}:revision:${(task.objectiveRevisions?.length ?? 0) + 1}`, workContract: structuredClone(revision.workContract), situation: structuredClone(revision.situation), createdAt: now }];
			const updated = { ...task, objectiveRevisions: revisions, situation: structuredClone(revision.situation), ...(revision.contractAdmission ? { contractAdmission: structuredClone(revision.contractAdmission) } : { contractAdmission: undefined }) };
			tasks.set(id, updated);
			return { originalWorkContract: task.workContract, revision: revisions.at(-1), revisions };
		},
	};
	const source = { platform: "cli", chatId: "revision-chain", chatType: "dm", userId: "local" };
	const agentFactory = () => {
		const agent = { state: { model: { id: "test/model" }, messages: [] } };
		return {
			agent,
			getAllTools: () => [], getActiveToolNames: () => [], setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "已执行" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined, dispose: () => undefined,
		};
	};
	const createRuntime = (contract, understood) => new BeeMaxAgentRuntime({
		profileId: "profile:revision-chain",
		interactiveAdmission: "contract_first",
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy(),
		turnUnderstanding: { understand: () => understood },
		workContractBuilder: { build: async () => admission(contract) },
		contractAdmissionIntegrity: integrity,
		createAgent: async () => agentFactory(),
	});
	const initialContract = workContract({ acceptanceCriteria: [clause(rawRequest)], capabilityRequirements: [], executionMode: "direct" });
	const initial = createRuntime(initialContract, { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, executionMode: "direct", confidence: 1 });
	await initial.run({ source, text: rawRequest, timeoutMs: 1_000 });
	initial.dispose();
	const objectiveId = [...tasks.keys()][0];
	const correction = (text) => ({
		schemaVersion: WORK_CONTRACT_SCHEMA_VERSION,
		rawRequest: text,
		action: "correct",
		targetObjective: { kind: "active_objective", id: objectiveId },
		objective: { text, source: { kind: "raw_request", start: 0, end: text.length } },
		constraints: [], prohibitions: [],
		acceptanceCriteria: [{ text, source: { kind: "raw_request", start: 0, end: text.length } }],
		capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.98,
	});
	for (const text of ["第一版修订：输出中文", "第二版修订：增加来源日期"]) {
		const runtime = createRuntime(correction(text), { action: "correct", goal: "继续原目标", constraints: [], acceptanceCriteria: [text], uncertainties: [], memoryQuery: text, executionMode: "direct", confidence: 1 });
		await runtime.run({ source, text, timeoutMs: 1_000 });
		runtime.dispose();
	}
	const corrected = tasks.get(objectiveId);
	assert.equal(corrected.objectiveRevisions.length, 2);
	assert.ok(corrected.contractAdmission);
	corrected.objectiveRevisions[0].situation.summary = "被篡改的早期修订";

	let piCalls = 0;
	const restored = new BeeMaxAgentRuntime({
		profileId: "profile:revision-chain",
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy(),
		contractAdmissionIntegrity: integrity,
		turnUnderstanding: { understand: () => ({ action: "continue", goal: rawRequest, constraints: [], acceptanceCriteria: [], uncertainties: [], memoryQuery: rawRequest, executionMode: "direct", confidence: 1 }) },
		createAgent: async () => { piCalls++; return agentFactory(); },
	});
	await assert.rejects(restored.run({ source, text: rawRequest, timeoutMs: 1_000, mode: "automation", objectiveTaskId: objectiveId }), /revision chain digest mismatch/i);
	assert.equal(piCalls, 0);
	restored.dispose();
});

test("a production runtime without a Profile integrity key blocks durable model work before Pi", async () => {
	let piCalls = 0;
	const tasks = [];
	const contract = workContract({ acceptanceCriteria: [clause(rawRequest)], capabilityRequirements: [], executionMode: "direct" });
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:missing-integrity",
		interactiveAdmission: "contract_first",
		taskLedger: { record: (task) => tasks.push(task), transition: () => true, queryTasks: () => [], reviseObjective: () => undefined },
		planningPolicy: new AutonomousPlanningPolicy(),
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => admission(contract) },
		requireContractAdmissionIntegrity: true,
		createAgent: async () => { piCalls++; throw new Error("Pi must not start"); },
	});

	await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "missing-integrity", chatType: "dm", userId: "local" }, text: rawRequest, timeoutMs: 1_000 }), /integrity authority is unavailable/i);
	assert.equal(piCalls, 0);
	assert.equal(tasks.length, 0);
	runtime.dispose();
});

test("the contract-derived correction budget bounds the real Objective verification loop", async () => {
	const contract = workContract({ acceptanceCriteria: [clause(rawRequest)], capabilityRequirements: [], executionMode: "direct" });
	const tasks = new Map();
	const runs = new Map();
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); },
		transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks: () => [],
	};
	let prompts = 0;
	let verifications = 0;
	const executionEnvelopes = [];
	const agent = { state: { model: { id: "test/model" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:test",
		interactiveAdmission: "contract_first",
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy({ maxCorrectiveAttempts: 0 }),
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => admission(contract) },
		verifyObjectiveCandidate: async () => { verifications++; return { accepted: false, feedback: "缺少来源证据" }; },
		createAgent: async () => ({
			agent,
			subscribe: () => () => undefined,
			prompt: async () => {
				prompts++;
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "未验证草稿" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	const result = await runtime.run({ source: { platform: "cli", chatId: "contract-correction-budget", chatType: "dm", userId: "local" }, text: rawRequest, timeoutMs: 1_000 }, (event) => {
		if (event.type === "execution_started") executionEnvelopes.push(event.executionEnvelope);
	});

	assert.equal(prompts, 1, "a zero correction budget must not create a correction Turn");
	assert.equal(verifications, 1);
	assert.equal(executionEnvelopes[0]?.budget?.maxCorrectiveAttempts, 0);
	assert.equal([...tasks.values()][0]?.correctiveAttempts, 0);
	assert.equal([...tasks.values()][0]?.verificationStatus, "rejected");
	assert.equal([...runs.values()][0]?.status, "failed");
	assert.match(result.answer, /未通过独立 Verification/);
	runtime.dispose();
});

test("an action or delivery outcome stays inside the parent authority boundary", () => {
	const contract = workContract({
		acceptanceCriteria: [clause("输出 HTML")],
		capabilityRequirements: [clause("输出 HTML")],
	});
	const openWorld = createOpenWorldContract({
		id: "contract:publish-report",
		admission: planningAdmission(contract),
		outcomes: [{ id: "outcome:deliver", acceptanceCriterionIndex: 0, capabilityRequirementIds: ["capability:deliver"], artifactRequirementIds: ["artifact:html"], evidenceRequirementIds: ["evidence:delivery"] }],
		capabilityRequirements: [{ id: "capability:deliver", workContractClauseIndex: 0, operation: "deliver", expectedOutputs: ["delivery-receipt"] }],
		artifactRequirements: [{ id: "artifact:html", mediaType: "text/html", role: "deliverable", verification: ["integrity", "delivery"] }],
		evidenceRequirements: [{ id: "evidence:delivery", kinds: ["artifact", "delivery"] }],
	});

	const decision = new AutonomousPlanningPolicy().decide(openWorld);

	assert.equal(decision.mode, "direct");
	assert.equal(decision.budget.maxSubagents, 0);
	assert.deepEqual(decision.requiredTools, []);
	assert.match(decision.reason, /parent Agent authority boundary/i);
});

function reviewedOpenWorldCompilation(admitted) {
	const contract = createOpenWorldContract({
		id: "contract:runtime-gold-report",
		admission: admitted,
		outcomes: [
			{ id: "outcome:research", acceptanceCriterionIndex: 0, capabilityRequirementIds: [], evidenceRequirementIds: ["evidence:sources"] },
			{ id: "outcome:html", acceptanceCriterionIndex: 1, dependsOnOutcomeIds: ["outcome:research"], capabilityRequirementIds: [], artifactRequirementIds: ["artifact:html"], evidenceRequirementIds: ["evidence:html"] },
			{ id: "outcome:pdf", acceptanceCriterionIndex: 2, dependsOnOutcomeIds: ["outcome:research"], capabilityRequirementIds: [], artifactRequirementIds: ["artifact:pdf"], evidenceRequirementIds: ["evidence:pdf"] },
		],
		capabilityRequirements: [],
		artifactRequirements: [
			{ id: "artifact:html", mediaType: "text/html", role: "deliverable", verification: ["integrity", "semantic", "render"] },
			{ id: "artifact:pdf", mediaType: "application/pdf", role: "deliverable", verification: ["integrity", "semantic", "render"] },
		],
		evidenceRequirements: [
			{ id: "evidence:sources", kinds: ["observation", "freshness"] },
			{ id: "evidence:html", kinds: ["artifact", "integrity", "semantic", "render"] },
			{ id: "evidence:pdf", kinds: ["artifact", "integrity", "semantic", "render"] },
		],
	});
	const cognitionUsage = { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, modelIdentities: ["test/openworld-primary/test", "test/openworld-reviewer/test"] };
	return {
		contract,
		source: "model",
		cognitionUsage,
		cognitionBudgetChargeTokens: 50,
		semanticAdjudication: {
			schemaVersion: OPEN_WORLD_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
			primaryModelIdentity: "test/openworld-primary/test",
			reviewerModelIdentity: "test/openworld-reviewer/test",
			reviewMode: "different_models",
			independentSamples: true,
			cognitionUsage,
			cognitionBudgetChargeTokens: 50,
		},
	};
}

import assert from "node:assert/strict";
import test from "node:test";
import {
	AutonomousPlanningPolicy,
	BeeMaxAgentRuntime,
	WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
	WORK_CONTRACT_SCHEMA_VERSION,
	createExecutionEnvelope,
	createOpenWorldContract,
} from "../dist/index.js";
import { createAdmittedWorkContractPlanningInput } from "../dist/contract-planning-admission.js";

const rawRequest = "并行深入调研过去一周黄金走势，输出 HTML 和 PDF";

function clause(text) {
	const start = rawRequest.indexOf(text);
	return { text, source: { kind: "raw_request", start, end: start + text.length } };
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
	for (const parentOnlyConstraint of ["所有工作必须由父代理执行", "只能由主代理执行", "must be executed by the parent agent", "This task should be handled solely by the parent agent", "任务应由父代理独立完成"]) {
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

test("Agent runtime plans only after model Work Contract semantic admission", async () => {
	const request = "解释合同驱动";
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
			assert.equal(semanticallyAdmitted, true);
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
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "合同驱动解释" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});

	await runtime.run({ source: { platform: "cli", chatId: "contract-plan", chatType: "dm", userId: "local" }, text: request, timeoutMs: 1_000 }, (event) => { runEvents.push(event); });

	assert.equal(planningInput.admission.source, "model");
	assert.deepEqual(planningInput.contract, contract);
	assert.match(promptText, /basis=work_contract/);
	assert.doesNotMatch(promptText, /basis=raw_prompt/);
	assert.deepEqual(runEvents.filter((event) => event.type === "planning_decision"), [{
		type: "planning_decision",
		mode: "direct",
		basis: "work_contract",
		verificationDepth: "none",
		contractIdSha256: "sha256:38043e0acec4ca928dd5c55a00b0ec8286da910a6331e19a192d7442a5574967",
		outcomeCount: 0,
		capabilityRequirementCount: 0,
		artifactRequirementCount: 0,
		evidenceRequirementCount: 0,
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
	assert.deepEqual(automationEvents.filter((event) => event.type === "planning_decision").map((event) => event.basis), ["work_contract"]);
	runtime.dispose();
});

test("the contract-derived correction budget bounds the real Objective verification loop", async () => {
	const contract = workContract({ capabilityRequirements: [], executionMode: "direct" });
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
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy({ maxCorrectiveAttempts: 0 }),
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: ["过去一周黄金走势"], uncertainties: [], memoryQuery: rawRequest, executionMode: "direct", confidence: 1 }) },
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

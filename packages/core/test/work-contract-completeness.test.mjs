import assert from "node:assert/strict";
import test from "node:test";
import { PiWorkContractBuilder, SEMANTIC_INVENTORY_SYSTEM_PROMPT, WORK_CONTRACT_SYSTEM_PROMPT, WorkContractCognitionError, adjudicateWorkContract, decodeSemanticInventory, hasSemanticWorkContractAdjudication, resolveSemanticOccurrence } from "../dist/index.js";

const activeObjectives = [{ id: "market", title: "市场分析" }, { id: "report", title: "周报" }];

test("semantic adjudication blocks an Objective that swallows a distinct prohibition", () => {
	const rawRequest = "不要取消市场分析，取消周报";
	const inventory = decode(rawRequest, {
		action: "cancel", targetObjectiveId: "report", confidence: 0.98,
		segments: [
			{ text: "不要取消市场分析", occurrence: 0, roles: ["prohibition"] },
			{ text: "取消周报", occurrence: 0, roles: ["objective"] },
		],
	});
	const result = adjudicateWorkContract({ contract: contract(rawRequest, { action: "cancel", targetObjectiveId: "report", objectiveText: rawRequest }), inventory, minimumConfidence: 0.6 });
	assert.equal(result.kind, "blocked");
	assert.equal(result.code, "ROLE_COVERAGE_INCOMPLETE");
	assert.deepEqual(result.missing.map(({ role, text }) => ({ role, text })), [{ role: "prohibition", text: "不要取消市场分析" }]);
});

test("semantic adjudication accepts one comma-bearing list Objective", () => {
	const rawRequest = "整理客户、供应商和合作伙伴名单";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.97,
		segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, { objectiveText: rawRequest, acceptanceTexts: [rawRequest] }), inventory, minimumConfidence: 0.6 });
	assert.deepEqual(result, { kind: "accepted" });
});

test("semantic adjudication blocks action and target disagreement", () => {
	const rawRequest = "继续周报";
	const inventory = decode(rawRequest, { action: "continue", targetObjectiveId: "report", confidence: 0.9, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective"] }] });
	assert.equal(adjudicateWorkContract({ contract: contract(rawRequest, { action: "correct", targetObjectiveId: "report" }), inventory }).code, "ACTION_DISAGREEMENT");
	assert.equal(adjudicateWorkContract({ contract: contract(rawRequest, { action: "continue", targetObjectiveId: "market" }), inventory }).code, "TARGET_DISAGREEMENT");
});

test("semantic adjudication requires every material role to use its matching Contract field", () => {
	const rawRequest = "生成报告，使用中文，保存草稿";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.9,
		segments: [
			{ text: "生成报告", occurrence: 0, roles: ["objective"] },
			{ text: "使用中文", occurrence: 0, roles: ["constraint"] },
			{ text: "保存草稿", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
		],
	}, []);
	const weak = contract(rawRequest, { objectiveText: rawRequest, acceptanceTexts: ["保存草稿"] });
	const result = adjudicateWorkContract({ contract: weak, inventory });
	assert.equal(result.code, "ROLE_COVERAGE_INCOMPLETE");
	assert.deepEqual(result.missing.map(({ role }) => role).sort(), ["capability_requirement", "constraint"]);
});

test("semantic adjudication atomizes one compound Capability clause from independently inventoried outcomes", () => {
	const rawRequest = "查询当前来源并归档结果";
	const inventory = decode(rawRequest, {
		action: "create", confidence: 0.99,
		segments: [
			{ text: "查询当前来源", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: "并", occurrence: 0, roles: ["context"] },
			{ text: "归档结果", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
		],
	}, []);
	const result = adjudicateWorkContract({ contract: contract(rawRequest, {
		objectiveText: rawRequest,
		acceptanceTexts: [rawRequest],
		capabilityTexts: [rawRequest],
	}), inventory });
	assert.deepEqual(result, { kind: "accepted", normalizedCapabilityRequirements: [
		{ text: "查询当前来源", source: { kind: "raw_request", start: 0, end: 6 } },
		{ text: "归档结果", source: { kind: "raw_request", start: 7, end: 11 } },
	] });
});

test("Pi Work Contract issues normalized atomic Capability requirements before routing", async () => {
	const rawRequest = "查询当前来源并归档结果";
	const complete = async (_candidate, context) => response(context.systemPrompt.includes("Independently inventory") ? {
		schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99,
		segments: [
			{ text: "查询当前来源", occurrence: 0, roles: ["objective", "acceptance_criterion", "capability_requirement"] },
			{ text: "并", occurrence: 0, roles: ["context"] },
			{ text: "归档结果", occurrence: 0, roles: ["acceptance_criterion", "capability_requirement"] },
		],
	} : {
		action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [],
		acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [{ text: rawRequest }],
		uncertainties: [], executionMode: "direct", confidence: 0.99,
	});
	const result = await new PiWorkContractBuilder({ models: [{ model: model("atomic") }], complete }).build({
		rawRequest,
		fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.contract.capabilityRequirements.map(({ text }) => text), ["查询当前来源", "归档结果"]);
});

test("semantic adjudication blocks low primary or inventory confidence", () => {
	const rawRequest = "生成报告";
	const inventory = decode(rawRequest, { action: "create", confidence: 0.59, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }, []);
	assert.equal(adjudicateWorkContract({ contract: contract(rawRequest, { confidence: 0.9 }), inventory, minimumConfidence: 0.6 }).code, "LOW_INVENTORY_CONFIDENCE");
	assert.equal(adjudicateWorkContract({ contract: contract(rawRequest, { confidence: 0.59 }), inventory: { ...inventory, confidence: 0.9 }, minimumConfidence: 0.6 }).code, "LOW_PRIMARY_CONFIDENCE");
});

test("occurrence resolution distinguishes repeated phrases and rejects a missing occurrence", () => {
	assert.deepEqual(resolveSemanticOccurrence("保存草稿，然后再次保存草稿", "保存草稿", 1), { start: 9, end: 13 });
	assert.throws(() => resolveSemanticOccurrence("保存草稿", "保存草稿", 1), /occurrence/i);
});

test("semantic inventory decoder rejects invalid ordering, overlap, target, roles, and confidence", () => {
	assert.throws(() => decode("甲乙", { action: "create", confidence: 1, segments: [{ text: "乙", occurrence: 0, roles: ["objective"] }, { text: "甲", occurrence: 0, roles: ["context"] }] }, []), /ordered/i);
	assert.throws(() => decode("甲乙", { action: "create", confidence: 1, segments: [{ text: "甲乙", occurrence: 0, roles: ["objective"] }, { text: "乙", occurrence: 0, roles: ["context"] }] }, []), /overlap/i);
	assert.throws(() => decode("继续", { action: "continue", targetObjectiveId: "missing", confidence: 1, segments: [{ text: "继续", occurrence: 0, roles: ["objective"] }] }), /active Objective/i);
	assert.throws(() => decode("生成", { action: "create", confidence: 1, segments: [{ text: "生成", occurrence: 0, roles: [] }] }, []), /roles/i);
	assert.throws(() => decode("生成", { action: "create", confidence: 2, segments: [{ text: "生成", occurrence: 0, roles: ["objective"] }] }, []), /confidence/i);
});

test("semantic inventory decoder rejects uncovered meaningful Raw Request spans and invented text", () => {
	assert.throws(() => decode("生成报告，不要发布", { action: "create", confidence: 1, segments: [{ text: "生成报告", occurrence: 0, roles: ["objective"] }] }, []), /coverage/i);
	assert.throws(() => decode("生成报告", { action: "create", confidence: 1, segments: [{ text: "删除报告", occurrence: 0, roles: ["objective"] }] }, []), /occurrence/i);
});

test("semantic inventory cannot make adjudication vacuous by classifying the whole request as context", () => {
	assert.throws(() => decode("不要取消市场分析，取消周报", {
		action: "cancel", targetObjectiveId: "report", confidence: 0.99,
		segments: [{ text: "不要取消市场分析，取消周报", occurrence: 0, roles: ["context"] }],
	}), /material Objective/i);
	assert.throws(() => decode("生成报告", {
		action: "create", confidence: 0.99,
		segments: [{ text: "生成报告", occurrence: 0, roles: ["objective"] }],
	}, []), /acceptance criterion/i);
});

test("Pi Work Contract cognition falls back on invalid schema while retaining an independent reviewer", async () => {
	const rawRequest = "不要取消市场分析，取消周报";
	const models = [model("a"), model("b")];
	const calls = [];
	const complete = async (candidate, context) => {
		const inventory = context.systemPrompt.includes("Independently inventory");
		calls.push(`${candidate.id}:${inventory ? "inventory" : "contract"}`);
		if (!inventory && candidate.id === "a") return response({ invalid: true });
		return response(inventory ? {
			schemaVersion: "beemax.semantic-inventory.v1", action: "cancel", targetObjectiveId: "report", confidence: 0.99,
			segments: [{ text: "不要取消市场分析", occurrence: 0, roles: ["prohibition"] }, { text: "取消周报", occurrence: 0, roles: ["objective"] }],
		} : {
			action: "cancel", targetObjectiveId: "report", objective: { text: "取消周报" }, constraints: [], prohibitions: [{ text: "不要取消市场分析" }],
			acceptanceCriteria: [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99,
		});
	};
	const result = await new PiWorkContractBuilder({ models: models.map((candidate) => ({ model: candidate })), complete }).build({
		rawRequest, fallback: { action: "query", goal: rawRequest, constraints: [], acceptanceCriteria: [], memoryQuery: rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.5 },
		activeObjectives,
	});
	assert.equal(result.contract.action, "cancel");
	assert.equal(result.cognitionUsage.inputTokens, 4);
	assert.equal(result.cognitionUsage.outputTokens, 4);
	assert.equal(result.cognitionUsage.modelIdentities.length, 4);
	assert.ok(calls.includes("a:contract") && calls.includes("b:contract"), "invalid primary schema must use the next Provider");
	assert.ok(calls.includes("a:inventory") && calls.includes("b:inventory"), "same-model convergence must trigger an independent reviewer");
});

test("Pi Work Contract cognition aborts its sibling request when one lane fails closed", async () => {
	let reviewerAborted = false;
	const complete = async (_candidate, context, options) => {
		if (!context.systemPrompt.includes("Independently inventory")) return response({ invalid: true });
		return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { reviewerAborted = true; reject(options.signal.reason); }, { once: true }));
	};
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], complete, timeoutMs: 1_000 });
	await assert.rejects(builder.build({ rawRequest: "生成报告", fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }), /Work Contract/i);
	assert.equal(reviewerAborted, true);
});

test("Pi Work Contract cognition never propagates malformed Provider usage into execution budgets", async () => {
	const rawRequest = "生成报告";
	const complete = async (_candidate, context) => {
		const value = context.systemPrompt.includes("Independently inventory")
			? { schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }
			: { action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 };
		return { ...response(value), usage: { input: Number.NaN, output: Number.POSITIVE_INFINITY, cacheRead: -1, cacheWrite: Number.NaN, totalTokens: Number.NaN, cost: { total: Number.NaN } } };
	};
	const result = await new PiWorkContractBuilder({ models: [{ model: model("only") }], complete }).build({
		rawRequest, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.9 },
	});
	assert.deepEqual(result.cognitionUsage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: ["test/only/test", "test/only/test"] });
	assert.ok(result.cognitionBudgetChargeTokens >= 3_072, "the hard budget charge must retain at least both reserved completion allowances");
	assert.equal(result.semanticAdjudication.reviewMode, "same_model_independent_samples");
	assert.equal(result.semanticAdjudication.cognitionBudgetChargeTokens, result.cognitionBudgetChargeTokens);
	assert.equal(hasSemanticWorkContractAdjudication(result), true);
});

test("Pi Work Contract never invokes a Provider when dynamic Profile credentials are empty", async () => {
	const previous = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "process-global-key-that-must-not-be-used";
	let completeCalls = 0;
	try {
		const openaiModel = (id) => ({ ...model(id), provider: "openai", api: "openai-responses" });
		const builder = new PiWorkContractBuilder({
			models: [
				{ model: openaiModel("undefined-credential"), getApiKey: async () => undefined },
				{ model: openaiModel("blank-credential"), getApiKey: async () => "  " },
			],
			complete: async () => { completeCalls++; return response({ invalid: true }); },
		});
		await assert.rejects(builder.build({
			rawRequest: "生成报告",
			fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 },
		}), /credential.*unavailable/i);
		assert.equal(completeCalls, 0, "an absent Profile credential must not reach Pi's environment fallback");
	} finally {
		if (previous === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous;
	}
});

test("Pi Work Contract resolves OAuth credentials for every Provider attempt", async () => {
	const rawRequest = "生成报告";
	let credentialReads = 0;
	const apiKeys = [];
	const complete = async (_candidate, context, options) => {
		apiKeys.push(options.apiKey);
		return response(context.systemPrompt.includes("Independently inventory")
			? { schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }
			: { action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 });
	};
	await new PiWorkContractBuilder({ models: [{ model: model("only"), getApiKey: async () => `oauth-${++credentialReads}` }], complete }).build({
		rawRequest, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.9 },
	});
	assert.equal(credentialReads, 2);
	assert.deepEqual(apiKeys.sort(), ["oauth-1", "oauth-2"]);
});

test("Pi Work Contract prefers an explicit API key and does not resolve credentials after abort", async () => {
	let credentialReads = 0;
	const apiKeys = [];
	const complete = async (_candidate, context, options) => {
		apiKeys.push(options.apiKey);
		return response(context.systemPrompt.includes("Independently inventory")
		? { schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99, segments: [{ text: "生成报告", occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }
		: { action: "create", objective: { text: "生成报告" }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: "生成报告" }], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 });
	};
	const fallback = { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 };
	await new PiWorkContractBuilder({ models: [{ model: model("only"), apiKey: "static", getApiKey: async () => `oauth-${++credentialReads}` }], complete }).build({ rawRequest: "生成报告", fallback });
	assert.equal(credentialReads, 0);
	assert.deepEqual(apiKeys, ["static", "static"]);

	const controller = new AbortController();
	controller.abort(new Error("cancelled before cognition"));
	await assert.rejects(new PiWorkContractBuilder({ models: [{ model: model("only"), getApiKey: async () => `oauth-${++credentialReads}` }], complete }).build({ rawRequest: "生成报告", fallback, signal: controller.signal }), /cancelled before cognition/i);
	assert.equal(credentialReads, 0);
});

test("semantic adjudication evidence rejects contradictory identity topology and missing usage", () => {
	const rawRequest = "生成报告";
	const base = {
		source: "model", cognitionBudgetChargeTokens: 1, contract: contract(rawRequest, { objectiveText: rawRequest, acceptanceTexts: [rawRequest] }),
		semanticAdjudication: {
			schemaVersion: "beemax.work-contract-adjudication.v1", inventorySchemaVersion: "beemax.semantic-inventory.v1",
			primaryModelIdentity: "test/only/test", reviewerModelIdentity: "test/only/test", reviewMode: "different_models", independentSamples: true,
			cognitionUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: ["test/only/test", "test/only/test"] }, cognitionBudgetChargeTokens: 1,
		},
	};
	assert.equal(hasSemanticWorkContractAdjudication(base), false);
	assert.equal(hasSemanticWorkContractAdjudication({ ...base, semanticAdjudication: { ...base.semanticAdjudication, reviewMode: "same_model_independent_samples", cognitionUsage: undefined } }), false);
});

test("Pi Work Contract deadline settles even when a Provider ignores AbortSignal", async () => {
	const never = new Promise(() => undefined);
	const complete = async (_candidate, context) => context.systemPrompt.includes("Independently inventory") ? never : response({ invalid: true });
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], complete, timeoutMs: 1_000 });
	const startedAt = Date.now();
	await assert.rejects(builder.build({ rawRequest: "生成报告", fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }), /Work Contract/i);
	assert.ok(Date.now() - startedAt < 500, "a sibling Provider that ignores cancellation must not hold the Turn open");
});

test("Pi Work Contract reserves the shared cognition budget before calling a Provider", async () => {
	let calls = 0;
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], complete: async () => { calls++; return response({ invalid: true }); } });
	await assert.rejects(builder.build({ rawRequest: "生成报告", maxCognitionTokens: 1, fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }), /shared token budget/i);
	assert.equal(calls, 0);
});

test("Pi Work Contract reserves both mandatory lanes before starting either Provider", async () => {
	const calls = [];
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], complete: async (candidate, context) => { calls.push(`${candidate.id}:${context.systemPrompt.includes("Independently inventory") ? "inventory" : "contract"}`); return response({ invalid: true }); } });
	await assert.rejects(builder.build({ rawRequest: "生成报告", maxCognitionTokens: 4_000, fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }), /Semantic Inventory cognition would exceed/i);
	assert.deepEqual(calls, []);
});

test("Pi Work Contract reserves chat framing beyond raw UTF-8 content before calling a Provider", async () => {
	const rawRequest = "生成报告";
	const payload = JSON.stringify({ rawRequest });
	const outputTokensPerLane = 256;
	const rawContentOnlyBudget = Buffer.byteLength(WORK_CONTRACT_SYSTEM_PROMPT, "utf8") + Buffer.byteLength(payload, "utf8") + outputTokensPerLane
		+ Buffer.byteLength(SEMANTIC_INVENTORY_SYSTEM_PROMPT, "utf8") + Buffer.byteLength(payload, "utf8") + outputTokensPerLane;
	let calls = 0;
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], maxTokens: outputTokensPerLane, complete: async () => { calls++; return response({ invalid: true }); } });
	await assert.rejects(builder.build({ rawRequest, maxCognitionTokens: rawContentOnlyBudget, fallback: { action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }), /cognition would exceed the shared token budget/i);
	assert.equal(calls, 0);
});

test("Pi Work Contract sends all one hundred long Objectives to both semantic lanes without an execution-envelope cognition cap", async () => {
	const targetIndex = 73;
	const targetMarker = "玄穹迁移计划第七十三阶段";
	const objectives = Array.from({ length: 100 }, (_, index) => ({
		id: `objective:${index}:${"ledger-identity-".repeat(3)}`,
		title: `${"跨区域多团队协同执行与持续验证".repeat(5)}${index === targetIndex ? targetMarker : `常规维护阶段${index}`}${"保留审计证据并等待最终确认".repeat(5)}`,
	}));
	for (const scenario of [
		{ action: "cancel", rawRequest: `取消${targetMarker}` },
		{ action: "correct", rawRequest: `将${targetMarker}修正为仅保留验证草稿` },
	]) {
		const calls = [];
		const complete = async (_candidate, context) => {
			const inventory = context.systemPrompt.includes("Independently inventory");
			const payload = JSON.parse(context.messages[0].content);
			const target = payload.activeObjectives.find(({ title }) => title.includes(targetMarker));
			assert.ok(target, "the explicitly referenced target must be present in the complete Objective catalog");
			assert.deepEqual(payload.activeObjectives, objectives);
			calls.push({ inventory, candidateCount: payload.activeObjectives.length });
			return response(inventory ? {
				schemaVersion: "beemax.semantic-inventory.v1", action: scenario.action, targetObjectiveId: target.id, confidence: 0.99,
				segments: [{ text: scenario.rawRequest, occurrence: 0, roles: scenario.action === "correct" ? ["objective", "acceptance_criterion"] : ["objective"] }],
			} : {
				action: scenario.action, targetObjectiveId: target.id, objective: { text: scenario.rawRequest }, constraints: [], prohibitions: [],
				acceptanceCriteria: scenario.action === "correct" ? [{ text: scenario.rawRequest }] : [], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99,
			});
		};
		const result = await new PiWorkContractBuilder({ models: [{ model: model("only") }], complete }).build({
			rawRequest: scenario.rawRequest,
			fallback: { action: scenario.action, goal: scenario.rawRequest, constraints: [], acceptanceCriteria: scenario.action === "correct" ? [scenario.rawRequest] : [], memoryQuery: scenario.rawRequest, capabilityQuery: "", executionMode: "direct", confidence: 0.9 },
			activeObjectives: objectives,
		});
		assert.equal(result.contract.targetObjective.id, objectives[targetIndex].id);
		assert.equal(calls.length, 2);
		assert.ok(calls.every(({ candidateCount }) => candidateCount === objectives.length));
	}
});

test("failed Work Contract cognition retains measured usage and cost evidence", async () => {
	const complete = async () => ({ ...response({ invalid: true }), usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: { total: 0.25 } } });
	const builder = new PiWorkContractBuilder({ models: [{ model: model("only") }], complete });
	const error = await builder.build({ rawRequest: "生成报告", fallback: { action: "create", goal: "生成报告", constraints: [], acceptanceCriteria: ["生成报告"], memoryQuery: "生成报告", capabilityQuery: "", executionMode: "direct", confidence: 0.9 } }).then(() => assert.fail("invalid cognition must fail"), (cause) => cause);
	assert.ok(error instanceof WorkContractCognitionError);
	assert.deepEqual(error.cognitionUsage, { inputTokens: 4, outputTokens: 6, cacheReadTokens: 8, cacheWriteTokens: 10, costUsd: 0.5, modelIdentities: ["test/only/test", "test/only/test"] });
	assert.ok(error.cognitionBudgetChargeTokens >= 3_072);
});

function decode(rawRequest, value, candidates = activeObjectives) {
	return decodeSemanticInventory({ schemaVersion: "beemax.semantic-inventory.v1", ...value }, { rawRequest, activeObjectives: candidates });
}

function contract(rawRequest, options = {}) {
	const action = options.action ?? "create";
	const objectiveText = options.objectiveText ?? rawRequest;
	return {
		schemaVersion: "beemax.work-contract.v1", rawRequest, action,
		...(options.targetObjectiveId ? { targetObjective: { kind: "active_objective", id: options.targetObjectiveId } } : {}),
		objective: clause(rawRequest, objectiveText),
		constraints: (options.constraintTexts ?? []).map((text) => clause(rawRequest, text)),
		prohibitions: (options.prohibitionTexts ?? []).map((text) => clause(rawRequest, text)),
		acceptanceCriteria: (options.acceptanceTexts ?? []).map((text) => clause(rawRequest, text)),
		capabilityRequirements: (options.capabilityTexts ?? []).map((text) => clause(rawRequest, text)),
		uncertainties: (options.uncertaintyTexts ?? []).map((text) => clause(rawRequest, text)),
		executionMode: "direct", confidence: options.confidence ?? 0.9,
	};
}

function clause(rawRequest, text) {
	const start = rawRequest.indexOf(text);
	return { text, source: { kind: "raw_request", start, end: start + text.length } };
}

function model(id) { return { id, provider: "test", api: "test", name: id, contextWindow: 16_000, maxTokens: 2_000 }; }
function response(value) {
	return { role: "assistant", content: [{ type: "text", text: JSON.stringify(value) }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}

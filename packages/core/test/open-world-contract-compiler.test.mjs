import assert from "node:assert/strict";
import test from "node:test";
import {
	OPEN_WORLD_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
	PiOpenWorldContractCompiler,
	WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
	WORK_CONTRACT_SCHEMA_VERSION,
	hasSemanticOpenWorldContractAdjudication,
} from "../dist/index.js";
import { createAdmittedWorkContractPlanningInput } from "../dist/contract-planning-admission.js";
import { isAdmittedOpenWorldContract } from "../dist/open-world-contract.js";

const rawRequest = "调研过去一周黄金走势，输出 HTML 和 PDF";

test("Pi OpenWorld compilation independently reviews and factory-admits the complete outcome graph", async () => {
	const calls = [];
	const compiler = new PiOpenWorldContractCompiler({
		models: [{ model: model("primary") }, { model: model("reviewer") }],
		complete: async (candidate, context) => {
			calls.push({ model: candidate.id, systemPrompt: context.systemPrompt });
			return response(context.systemPrompt.includes("Independently review") ? acceptedReview() : goldProposal());
		},
	});

	const result = await compiler.compile({ admission: planningAdmission(goldWorkContract()) });

	assert.equal(result.contract.outcomes.length, 3);
	assert.equal(result.contract.capabilityRequirements.length, 3);
	assert.deepEqual(result.contract.capabilityRequirements.map((requirement) => requirement.expectedOutputs), [
		["observation receipt"], ["transformation result"], ["transformation result"],
	]);
	assert.deepEqual(result.contract.outcomes.map((outcome) => outcome.dependsOnOutcomeIds), [[], ["outcome:0"], ["outcome:0"]]);
	assert.deepEqual(result.contract.outcomes.map((outcome) => outcome.artifactRequirementIds), [
		["artifact:0", "artifact:1"], ["artifact:0", "artifact:1"], ["artifact:0", "artifact:1"],
	]);
	assert.deepEqual(result.contract.artifactRequirements.map((artifact) => artifact.mediaType), ["text/html", "application/pdf"]);
	assert.deepEqual(result.contract.artifactRequirements.map((artifact) => artifact.verification), [
		["existence", "integrity", "semantic", "render", "consistency"],
		["existence", "integrity", "semantic", "render", "consistency"],
	]);
	assert.deepEqual(result.contract.evidenceRequirements.map((evidence) => evidence.kinds), [
		["observation", "artifact", "integrity", "semantic", "render", "consistency", "freshness"],
		["artifact", "integrity", "semantic", "render", "consistency"],
		["artifact", "integrity", "semantic", "render", "consistency"],
	]);
	assert.equal(isAdmittedOpenWorldContract(result.contract), true);
	assert.equal(hasSemanticOpenWorldContractAdjudication(result), true);
	assert.equal(result.semanticAdjudication.schemaVersion, OPEN_WORLD_CONTRACT_ADJUDICATION_SCHEMA_VERSION);
	assert.equal(result.semanticAdjudication.reviewMode, "different_models");
	assert.deepEqual(calls.map((call) => call.model), ["primary", "reviewer"]);
});

test("OpenWorld compilation fails closed when independent review does not accept every declared relation", async () => {
	const review = acceptedReview();
	review.artifactRequirements[1].accepted = false;
	review.issues = ["PDF render verification is incomplete"];
	const compiler = new PiOpenWorldContractCompiler({
		models: [{ model: model("primary") }, { model: model("reviewer") }],
		complete: async (_candidate, context) => response(context.systemPrompt.includes("Independently review") ? review : goldProposal()),
	});

	await assert.rejects(
		compiler.compile({ admission: planningAdmission(goldWorkContract()) }),
		/OPEN_WORLD_COMPILATION_BLOCKED.*PDF render verification is incomplete/i,
	);
});

test("OpenWorld compilation performs one bounded graph repair and requires a fresh independent acceptance", async () => {
	const calls = [];
	let repaired = false;
	const rejected = acceptedReview();
	rejected.accepted = false;
	rejected.issues = [`Remove an invented intermediate artifact and bind semantic evidence to the report outcome: ${"detail ".repeat(45)}`];
	const compiler = new PiOpenWorldContractCompiler({
		models: [{ model: { ...model("only"), maxTokens: 8_192 } }],
		complete: async (_candidate, context) => {
			const review = context.systemPrompt.includes("Independently review");
			const repair = context.systemPrompt.includes("Independent OpenWorld review rejected");
			calls.push(review ? "review" : repair ? "repair" : "compilation");
			if (repair) { repaired = true; return response(goldProposal()); }
			return response(review ? (repaired ? acceptedReview() : rejected) : goldProposal());
		},
	});

	const result = await compiler.compile({ admission: planningAdmission(goldWorkContract()) });

	assert.equal(hasSemanticOpenWorldContractAdjudication(result), true);
	assert.deepEqual(calls, ["compilation", "review", "repair", "review"]);
});

test("OpenWorld compilation reserves both cognition lanes before calling a Provider", async () => {
	let calls = 0;
	const compiler = new PiOpenWorldContractCompiler({
		models: [{ model: model("only") }],
		complete: async () => { calls++; return response(goldProposal()); },
	});

	await assert.rejects(
		compiler.compile({ admission: planningAdmission(goldWorkContract()), maxCognitionTokens: 1 }),
		/shared token budget/i,
	);
	assert.equal(calls, 0);
});

test("single-model OpenWorld cognition retries EOF-truncated compilation and review samples with bounded larger allowances", async () => {
	const calls = [];
	let compilationAttempts = 0;
	let reviewAttempts = 0;
	const compiler = new PiOpenWorldContractCompiler({
		models: [{ model: { ...model("only"), maxTokens: 8_192 } }],
		complete: async (_candidate, context, options) => {
			const review = context.systemPrompt.includes("Independently review");
			calls.push({ lane: review ? "review" : "compilation", maxTokens: options.maxTokens });
			if (!review && compilationAttempts++ === 0) return rawResponse('{"outcomes":[{"acceptanceCriterionIndex":0', "stop");
			if (review && reviewAttempts++ === 0) return rawResponse('{"accepted":true,"confidence":0.99,"issues":[]', "stop");
			return response(review ? acceptedReview() : goldProposal());
		},
	});

	const result = await compiler.compile({ admission: planningAdmission(goldWorkContract()) });

	assert.equal(hasSemanticOpenWorldContractAdjudication(result), true);
	assert.deepEqual(calls, [
		{ lane: "compilation", maxTokens: 1_024 },
		{ lane: "compilation", maxTokens: 8_192 },
		{ lane: "review", maxTokens: 768 },
		{ lane: "review", maxTokens: 8_192 },
	]);
});

test("multi-model OpenWorld cognition keeps the recovery allowance after an intervening invalid candidate", async () => {
	const compilationMaxTokens = [];
	let compilationAttempts = 0;
	const compiler = new PiOpenWorldContractCompiler({
		models: [{ model: { ...model("primary"), maxTokens: 8_192 } }, { model: { ...model("alternate"), maxTokens: 8_192 } }],
		complete: async (_candidate, context, options) => {
			if (context.systemPrompt.includes("Independently review")) return response(acceptedReview());
			compilationMaxTokens.push(options.maxTokens);
			compilationAttempts++;
			if (compilationAttempts === 1) return rawResponse('{"outcomes":[{"acceptanceCriterionIndex":0', "length");
			if (compilationAttempts === 2) return response({ invalid: true });
			return response(goldProposal());
		},
	});

	const result = await compiler.compile({ admission: planningAdmission(goldWorkContract()) });

	assert.equal(hasSemanticOpenWorldContractAdjudication(result), true);
	assert.deepEqual(compilationMaxTokens, [1_024, 8_192, 8_192]);
});

function goldWorkContract() {
	return {
		schemaVersion: WORK_CONTRACT_SCHEMA_VERSION,
		rawRequest,
		action: "create",
		objective: clause(rawRequest),
		constraints: [],
		prohibitions: [],
		acceptanceCriteria: [clause("过去一周黄金走势"), clause("HTML"), clause("PDF")],
		capabilityRequirements: [clause("调研过去一周黄金走势"), clause("输出 HTML"), clause("PDF")],
		uncertainties: [],
		executionMode: "plan",
		confidence: 0.98,
	};
}

function planningAdmission(contract) {
	const cognitionUsage = { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, modelIdentities: ["test/contract-primary/test", "test/contract-reviewer/test"] };
	return createAdmittedWorkContractPlanningInput({
		contract,
		source: "model",
		cognitionUsage,
		cognitionBudgetChargeTokens: 100,
		semanticAdjudication: {
			schemaVersion: WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
			inventorySchemaVersion: "beemax.semantic-inventory.v1",
			primaryModelIdentity: "test/contract-primary/test",
			reviewerModelIdentity: "test/contract-reviewer/test",
			reviewMode: "different_models",
			independentSamples: true,
			cognitionUsage,
			cognitionBudgetChargeTokens: 100,
		},
	});
}

function goldProposal() {
	return {
		outcomes: [
			{ acceptanceCriterionIndex: 0, dependsOnAcceptanceCriterionIndexes: [], capabilityRequirementIndexes: [0], artifactRequirementIndexes: [] },
			{ acceptanceCriterionIndex: 1, dependsOnAcceptanceCriterionIndexes: [0], capabilityRequirementIndexes: [1], artifactRequirementIndexes: [0] },
			{ acceptanceCriterionIndex: 2, dependsOnAcceptanceCriterionIndexes: [0], capabilityRequirementIndexes: [2], artifactRequirementIndexes: [1] },
		],
		capabilityRequirements: [
			{ workContractClauseIndex: 0, operation: "observe" },
			{ workContractClauseIndex: 1, operation: "transform" },
			{ workContractClauseIndex: 2, operation: "transform" },
		],
		artifactRequirements: [
			{ mediaType: "text/html", role: "deliverable" },
			{ mediaType: "application/pdf", role: "deliverable" },
		],
	};
}

function acceptedReview() {
	return {
		accepted: true,
		confidence: 0.99,
		issues: [],
		outcomes: [0, 1, 2].map((index) => ({ index, accepted: true })),
		capabilityRequirements: [0, 1, 2].map((index) => ({ index, accepted: true })),
		artifactRequirements: [0, 1].map((index) => ({ index, accepted: true })),
		evidenceRequirements: [0, 1, 2].map((index) => ({ index, accepted: true })),
	};
}

function clause(text) {
	const start = rawRequest.indexOf(text);
	return { text, source: { kind: "raw_request", start, end: start + text.length } };
}

function model(id) { return { id, provider: "test", api: "test", name: id, contextWindow: 16_000, maxTokens: 2_000 }; }
function response(value) {
	return { role: "assistant", content: [{ type: "text", text: JSON.stringify(value) }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}
function rawResponse(text, stopReason = "length") {
	return { role: "assistant", content: [{ type: "text", text }], stopReason, usage: { input: 1, output: 1_024, cacheRead: 0, cacheWrite: 0, totalTokens: 1_025, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}

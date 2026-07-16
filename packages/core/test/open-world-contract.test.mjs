import assert from "node:assert/strict";
import test from "node:test";
import {
	OPEN_WORLD_CONTRACT_SCHEMA_VERSION,
	WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
	WORK_CONTRACT_SCHEMA_VERSION,
	createOpenWorldContract,
} from "../dist/index.js";

const rawRequest = "研究过去一周黄金走势，输出 HTML 和 PDF";

function clause(text) {
	const start = rawRequest.indexOf(text);
	return { text, source: { kind: "raw_request", start, end: start + text.length } };
}

function workContract() {
	return {
		schemaVersion: WORK_CONTRACT_SCHEMA_VERSION,
		rawRequest,
		action: "create",
		objective: clause(rawRequest),
		constraints: [],
		prohibitions: [],
		acceptanceCriteria: [clause("研究过去一周黄金走势"), clause("输出 HTML"), clause("PDF")],
		capabilityRequirements: [clause("研究过去一周黄金走势"), clause("输出 HTML"), clause("PDF")],
		uncertainties: [],
		executionMode: "plan",
		confidence: 0.98,
	};
}

function admittedWorkContract() {
	const cognitionUsage = { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, modelIdentities: ["primary/model", "reviewer/model"] };
	return {
		contract: workContract(), source: "model", cognitionUsage, cognitionBudgetChargeTokens: 100,
		semanticAdjudication: {
			schemaVersion: WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
			inventorySchemaVersion: "beemax.semantic-inventory.v1",
			primaryModelIdentity: "primary/model", reviewerModelIdentity: "reviewer/model", reviewMode: "different_models", independentSamples: true,
			cognitionUsage, cognitionBudgetChargeTokens: 100,
		},
	};
}

test("an open-world contract binds every atomic outcome to capabilities, evidence, and requested artifacts", () => {
	const contract = createOpenWorldContract({
		id: "contract:gold-weekly-report",
		admission: admittedWorkContract(),
		outcomes: [
			{ id: "outcome:research", acceptanceCriterionIndex: 0, capabilityRequirementIds: ["capability:research"], evidenceRequirementIds: ["evidence:sources"] },
			{ id: "outcome:html", acceptanceCriterionIndex: 1, capabilityRequirementIds: ["capability:html"], artifactRequirementIds: ["artifact:html"], evidenceRequirementIds: ["evidence:html"] },
			{ id: "outcome:pdf", acceptanceCriterionIndex: 2, capabilityRequirementIds: ["capability:pdf"], artifactRequirementIds: ["artifact:pdf"], evidenceRequirementIds: ["evidence:pdf"] },
		],
		capabilityRequirements: [
			{ id: "capability:research", workContractClauseIndex: 0, operation: "observe", expectedOutputs: ["market-source-records"] },
			{ id: "capability:html", workContractClauseIndex: 1, operation: "transform", expectedOutputs: ["text/html"] },
			{ id: "capability:pdf", workContractClauseIndex: 2, operation: "transform", expectedOutputs: ["application/pdf"] },
		],
		artifactRequirements: [
			{ id: "artifact:html", mediaType: "text/html", role: "deliverable", verification: ["integrity", "semantic", "render", "delivery"] },
			{ id: "artifact:pdf", mediaType: "application/pdf", role: "deliverable", verification: ["integrity", "semantic", "render", "delivery"] },
		],
		evidenceRequirements: [
			{ id: "evidence:sources", kinds: ["observation", "freshness", "semantic"] },
			{ id: "evidence:html", kinds: ["artifact", "render", "delivery"] },
			{ id: "evidence:pdf", kinds: ["artifact", "render", "delivery"] },
		],
	});

	assert.equal(contract.schemaVersion, OPEN_WORLD_CONTRACT_SCHEMA_VERSION);
	assert.equal(contract.outcomes.length, 3);
	assert.equal(contract.outcomes[2].acceptanceCriterion.text, "PDF");
	assert.equal(contract.capabilityRequirements[2].requirement.text, "PDF");
	assert.deepEqual(contract.outcomes[1].artifactRequirementIds, ["artifact:html"]);
	assert.equal(Object.isFrozen(contract), true);
	assert.equal(Object.isFrozen(contract.outcomes[0]), true);
});

test("an open-world contract rejects an omitted atomic outcome", () => {
	const base = {
		id: "contract:incomplete",
		admission: admittedWorkContract(),
		outcomes: [
			{ id: "outcome:research", acceptanceCriterionIndex: 0, capabilityRequirementIds: ["capability:research"], evidenceRequirementIds: ["evidence:sources"] },
			{ id: "outcome:html", acceptanceCriterionIndex: 1, capabilityRequirementIds: ["capability:html"], evidenceRequirementIds: ["evidence:html"] },
		],
		capabilityRequirements: [
			{ id: "capability:research", workContractClauseIndex: 0, operation: "observe", expectedOutputs: ["market-source-records"] },
			{ id: "capability:html", workContractClauseIndex: 1, operation: "transform", expectedOutputs: ["text/html"] },
			{ id: "capability:pdf", workContractClauseIndex: 2, operation: "transform", expectedOutputs: ["application/pdf"] },
		],
		artifactRequirements: [],
		evidenceRequirements: [
			{ id: "evidence:sources", kinds: ["observation"] },
			{ id: "evidence:html", kinds: ["artifact"] },
		],
	};

	assert.throws(() => createOpenWorldContract(base), /every Work Contract acceptance criterion/i);
});

test("one Capability requirement cannot be assigned to multiple atomic outcomes", () => {
	const input = {
		id: "contract:duplicate-capability-binding",
		admission: admittedWorkContract(),
		outcomes: [
			{ id: "outcome:research", acceptanceCriterionIndex: 0, capabilityRequirementIds: ["capability:research"], evidenceRequirementIds: ["evidence:sources"] },
			{ id: "outcome:html", acceptanceCriterionIndex: 1, capabilityRequirementIds: ["capability:research", "capability:html"], evidenceRequirementIds: ["evidence:html"] },
			{ id: "outcome:pdf", acceptanceCriterionIndex: 2, capabilityRequirementIds: ["capability:pdf"], evidenceRequirementIds: ["evidence:pdf"] },
		],
		capabilityRequirements: [
			{ id: "capability:research", workContractClauseIndex: 0, operation: "observe", expectedOutputs: ["market-source-records"] },
			{ id: "capability:html", workContractClauseIndex: 1, operation: "transform", expectedOutputs: ["text/html"] },
			{ id: "capability:pdf", workContractClauseIndex: 2, operation: "transform", expectedOutputs: ["application/pdf"] },
		],
		artifactRequirements: [],
		evidenceRequirements: [
			{ id: "evidence:sources", kinds: ["observation"] },
			{ id: "evidence:html", kinds: ["artifact"] },
			{ id: "evidence:pdf", kinds: ["artifact"] },
		],
	};

	assert.throws(() => createOpenWorldContract(input), /capability requirement.*exactly once/i);
});

test("an open-world outcome dependency graph must be acyclic", () => {
	assert.throws(() => createOpenWorldContract({
		id: "contract:cyclic-outcomes",
		admission: admittedWorkContract(),
		outcomes: [
			{ id: "outcome:research", acceptanceCriterionIndex: 0, dependsOnOutcomeIds: ["outcome:pdf"], capabilityRequirementIds: ["capability:research"], evidenceRequirementIds: ["evidence:sources"] },
			{ id: "outcome:html", acceptanceCriterionIndex: 1, dependsOnOutcomeIds: ["outcome:research"], capabilityRequirementIds: ["capability:html"], evidenceRequirementIds: ["evidence:html"] },
			{ id: "outcome:pdf", acceptanceCriterionIndex: 2, dependsOnOutcomeIds: ["outcome:html"], capabilityRequirementIds: ["capability:pdf"], evidenceRequirementIds: ["evidence:pdf"] },
		],
		capabilityRequirements: [
			{ id: "capability:research", workContractClauseIndex: 0, operation: "observe", expectedOutputs: ["market-source-records"] },
			{ id: "capability:html", workContractClauseIndex: 1, operation: "transform", expectedOutputs: ["text/html"] },
			{ id: "capability:pdf", workContractClauseIndex: 2, operation: "transform", expectedOutputs: ["application/pdf"] },
		],
		artifactRequirements: [],
		evidenceRequirements: [
			{ id: "evidence:sources", kinds: ["observation"] },
			{ id: "evidence:html", kinds: ["artifact"] },
			{ id: "evidence:pdf", kinds: ["artifact"] },
		],
	}), /outcome dependency cycle/i);
});

test("a structurally valid but semantically unadmitted Work Contract cannot enter the open-world graph", () => {
	const deterministic = { ...workContract(), capabilityRequirements: [] };
	assert.throws(() => createOpenWorldContract({
		id: "contract:unadmitted",
		admission: { contract: deterministic, source: "deterministic" },
		outcomes: [], capabilityRequirements: [], artifactRequirements: [], evidenceRequirements: [],
	}), /admitted Work Contract/i);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
	AutonomousPlanningPolicy,
	OPEN_WORLD_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
	WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
	WORK_CONTRACT_SCHEMA_VERSION,
	createDurableContractAdmissionReceipt,
	createOpenWorldContract,
	decodeDurableContractAdmissionReceipt,
	restoreDurableContractPlanningInput,
} from "../dist/index.js";
import { createAdmittedWorkContractPlanningInput } from "../dist/contract-planning-admission.js";
import { isAdmittedOpenWorldContract } from "../dist/open-world-contract.js";

const rawRequest = "调研黄金并输出 HTML";

test("a serialized durable admission receipt rebrands the exact reviewed OpenWorld contract on resume", () => {
	const contract = workContract();
	const admission = planningAdmission(contract);
	const compilation = reviewedCompilation(admission);
	const receipt = createDurableContractAdmissionReceipt({ admission, openWorldCompilation: compilation, admittedAt: 100, ttlMs: 1_000 });
	const decoded = decodeDurableContractAdmissionReceipt(JSON.parse(JSON.stringify(receipt)));
	const restored = restoreDurableContractPlanningInput(decoded, contract, 500);

	assert.equal(receipt.expiresAt, 1_100);
	assert.equal(isAdmittedOpenWorldContract(restored), true);
	assert.equal(new AutonomousPlanningPolicy().decide(restored).basis, "open_world_contract");
	assert.notEqual(restored, compilation.contract, "resume must re-admit a fresh in-process branded object");
});

test("durable admission restoration rejects Work Contract or graph snapshot tampering", () => {
	const contract = workContract();
	const admission = planningAdmission(contract);
	const receipt = createDurableContractAdmissionReceipt({ admission, openWorldCompilation: reviewedCompilation(admission), admittedAt: 100, ttlMs: 1_000 });
	const changedContract = { ...contract, rawRequest: `${contract.rawRequest}!` };
	assert.throws(() => restoreDurableContractPlanningInput(receipt, changedContract, 500), /Work Contract digest/i);

	const tampered = structuredClone(receipt);
	tampered.openWorld.snapshot.artifactRequirements[0].mediaType = "application/pdf";
	assert.throws(() => restoreDurableContractPlanningInput(tampered, contract, 500), /snapshot digest/i);
});

test("durable admission restoration fails closed after receipt expiry", () => {
	const contract = workContract();
	const admission = planningAdmission(contract);
	const receipt = createDurableContractAdmissionReceipt({ admission, openWorldCompilation: reviewedCompilation(admission), admittedAt: 100, ttlMs: 1_000 });

	assert.throws(() => restoreDurableContractPlanningInput(receipt, contract, 1_100), /expired/i);
});

function workContract() {
	return {
		schemaVersion: WORK_CONTRACT_SCHEMA_VERSION,
		rawRequest,
		action: "create",
		objective: clause(rawRequest),
		constraints: [],
		prohibitions: [],
		acceptanceCriteria: [clause("调研黄金"), clause("输出 HTML")],
		capabilityRequirements: [clause("调研黄金"), clause("输出 HTML")],
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

function reviewedCompilation(admission) {
	const contract = createOpenWorldContract({
		id: "contract:gold-html",
		admission,
		outcomes: [
			{ id: "outcome:research", acceptanceCriterionIndex: 0, capabilityRequirementIds: ["capability:research"], evidenceRequirementIds: ["evidence:research"] },
			{ id: "outcome:html", acceptanceCriterionIndex: 1, dependsOnOutcomeIds: ["outcome:research"], capabilityRequirementIds: ["capability:html"], artifactRequirementIds: ["artifact:html"], evidenceRequirementIds: ["evidence:html"] },
		],
		capabilityRequirements: [
			{ id: "capability:research", workContractClauseIndex: 0, operation: "observe", expectedOutputs: ["source observations"] },
			{ id: "capability:html", workContractClauseIndex: 1, operation: "transform", expectedOutputs: ["HTML artifact"] },
		],
		artifactRequirements: [{ id: "artifact:html", mediaType: "text/html", role: "deliverable", verification: ["integrity", "semantic", "render"] }],
		evidenceRequirements: [
			{ id: "evidence:research", kinds: ["observation", "freshness"] },
			{ id: "evidence:html", kinds: ["artifact", "integrity", "semantic", "render"] },
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

function clause(text) {
	const start = rawRequest.indexOf(text);
	return { text, source: { kind: "raw_request", start, end: start + text.length } };
}

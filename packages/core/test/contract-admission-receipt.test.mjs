import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as publicCore from "../dist/index.js";
import {
	AutonomousPlanningPolicy,
	OPEN_WORLD_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
	WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
	WORK_CONTRACT_SCHEMA_VERSION,
	createContractAdmissionReceiptIntegrity,
	createOpenWorldContract,
} from "../dist/index.js";
import { createAdmittedWorkContractPlanningInput } from "../dist/contract-planning-admission.js";
import { createDurableContractAdmissionReceipt, decodeDurableContractAdmissionReceipt, restoreDurableContractPlanningInput } from "../dist/contract-admission-receipt.js";
import { isAdmittedOpenWorldContract } from "../dist/open-world-contract.js";

const rawRequest = "调研黄金并输出 HTML";
const integrity = createContractAdmissionReceiptIntegrity({ key: Buffer.alloc(32, 7), profileId: "profile:test" });

test("public Core cannot mint or restore process-local Contract admission brands", () => {
	assert.equal(publicCore.createAdmittedWorkContractPlanningInput, undefined);
	assert.equal(publicCore.isAdmittedWorkContractPlanningInput, undefined);
	assert.equal(publicCore.createDurableContractAdmissionReceipt, undefined);
	assert.equal(publicCore.restoreDurableContractPlanningInput, undefined);
});

test("a serialized durable admission receipt rebrands the exact reviewed OpenWorld contract on resume", () => {
	const contract = workContract();
	const admission = planningAdmission(contract);
	const compilation = reviewedCompilation(admission);
	const binding = objectiveBinding(contract);
	const receipt = createDurableContractAdmissionReceipt({ admission, openWorldCompilation: compilation, objectiveBinding: binding, integrity, admittedAt: 100, ttlMs: 1_000 });
	const decoded = decodeDurableContractAdmissionReceipt(JSON.parse(JSON.stringify(receipt)));
	const restored = restoreDurableContractPlanningInput({ receipt: decoded, workContract: contract, objectiveBinding: binding, integrity, now: 500 });

	assert.equal(receipt.expiresAt, 1_100);
	assert.equal(isAdmittedOpenWorldContract(restored), true);
	assert.equal(new AutonomousPlanningPolicy().decide(restored).basis, "open_world_contract");
	assert.notEqual(restored, compilation.contract, "resume must re-admit a fresh in-process branded object");
});

test("a durable admission receipt preserves the one-model inventory compiler topology honestly", () => {
	const contract = workContract();
	const admission = inventoryCompilerAdmission(contract);
	const binding = objectiveBinding(contract);
	const receipt = createDurableContractAdmissionReceipt({ admission, objectiveBinding: binding, integrity, admittedAt: 100, ttlMs: 1_000 });
	const decoded = decodeDurableContractAdmissionReceipt(JSON.parse(JSON.stringify(receipt)));
	const restored = restoreDurableContractPlanningInput({ receipt: decoded, workContract: contract, objectiveBinding: binding, integrity, now: 500 });

	assert.equal(decoded.workContract.semanticAdjudication.reviewMode, "inventory_with_deterministic_compiler");
	assert.equal(decoded.workContract.semanticAdjudication.independentSamples, false);
	assert.equal(restored.contract.rawRequest, rawRequest);
});

test("durable admission restoration rejects Work Contract or graph snapshot tampering", () => {
	const contract = workContract();
	const admission = planningAdmission(contract);
	const binding = objectiveBinding(contract);
	const receipt = createDurableContractAdmissionReceipt({ admission, openWorldCompilation: reviewedCompilation(admission), objectiveBinding: binding, integrity, admittedAt: 100, ttlMs: 1_000 });
	const changedContract = { ...contract, rawRequest: `${contract.rawRequest}!` };
	assert.throws(() => restoreDurableContractPlanningInput({ receipt, workContract: changedContract, objectiveBinding: { ...binding, originalWorkContract: changedContract }, integrity, now: 500 }), /Work Contract digest|authentication/i);

	const tampered = structuredClone(receipt);
	tampered.openWorld.snapshot.artifactRequirements[0].mediaType = "application/pdf";
	assert.throws(() => restoreDurableContractPlanningInput({ receipt: tampered, workContract: contract, objectiveBinding: binding, integrity, now: 500 }), /snapshot digest|authentication/i);
});

test("coordinated rehashing, expiry extension, and correction-chain rewriting cannot forge a durable admission", () => {
	const contract = workContract();
	const admission = planningAdmission(contract);
	const firstRevision = { id: "objective:test:revision:1", workContract: contract, situation: situation("第一版"), createdAt: 101 };
	const secondRevision = { id: "objective:test:revision:2", workContract: contract, situation: situation("第二版"), createdAt: 102 };
	const binding = objectiveBinding(contract, [firstRevision, secondRevision]);
	const receipt = createDurableContractAdmissionReceipt({ admission, openWorldCompilation: reviewedCompilation(admission), objectiveBinding: binding, integrity, admittedAt: 100, ttlMs: 1_000 });

	const contractForgery = structuredClone(receipt);
	const changedContract = { ...contract, executionMode: "direct" };
	const changedBinding = objectiveBinding(changedContract, [{ ...firstRevision, workContract: changedContract }, { ...secondRevision, workContract: changedContract }]);
	contractForgery.workContractSha256 = digest(changedContract);
	contractForgery.objectiveBindingSha256 = digest(changedBinding);
	assert.throws(() => restoreDurableContractPlanningInput({ receipt: contractForgery, workContract: changedContract, objectiveBinding: changedBinding, integrity, now: 500 }), /authentication/i);

	const graphForgery = structuredClone(receipt);
	graphForgery.openWorld.snapshot.artifactRequirements[0].mediaType = "application/pdf";
	graphForgery.openWorld.snapshotSha256 = digest(graphForgery.openWorld.snapshot);
	assert.throws(() => restoreDurableContractPlanningInput({ receipt: graphForgery, workContract: contract, objectiveBinding: binding, integrity, now: 500 }), /authentication/i);

	const expiryForgery = { ...structuredClone(receipt), expiresAt: 10_000 };
	assert.throws(() => restoreDurableContractPlanningInput({ receipt: expiryForgery, workContract: contract, objectiveBinding: binding, integrity, now: 2_000 }), /authentication/i);

	const chainForgery = structuredClone(binding);
	chainForgery.revisions[0].situation.summary = "被篡改的第一版";
	const chainReceiptForgery = { ...structuredClone(receipt), objectiveBindingSha256: digest(chainForgery) };
	assert.throws(() => restoreDurableContractPlanningInput({ receipt: chainReceiptForgery, workContract: contract, objectiveBinding: chainForgery, integrity, now: 500 }), /authentication/i);
});

test("durable admission restoration fails closed after receipt expiry", () => {
	const contract = workContract();
	const admission = planningAdmission(contract);
	const binding = objectiveBinding(contract);
	const receipt = createDurableContractAdmissionReceipt({ admission, openWorldCompilation: reviewedCompilation(admission), objectiveBinding: binding, integrity, admittedAt: 100, ttlMs: 1_000 });

	assert.throws(() => restoreDurableContractPlanningInput({ receipt, workContract: contract, objectiveBinding: binding, integrity, now: 1_100 }), /expired/i);
});

test("a receipt cannot cross Profile integrity boundaries", () => {
	const contract = workContract();
	const admission = planningAdmission(contract);
	const binding = objectiveBinding(contract);
	const receipt = createDurableContractAdmissionReceipt({ admission, objectiveBinding: binding, integrity, admittedAt: 100, ttlMs: 1_000 });
	const otherProfile = createContractAdmissionReceiptIntegrity({ key: Buffer.alloc(32, 7), profileId: "profile:other" });

	assert.throws(() => restoreDurableContractPlanningInput({ receipt, workContract: contract, objectiveBinding: binding, integrity: otherProfile, now: 500 }), /authentication/i);
});

test("the storage decoder rejects missing, malformed, and structurally abusive nested fields before restoration", () => {
	const contract = workContract();
	const admission = planningAdmission(contract);
	const receipt = createDurableContractAdmissionReceipt({ admission, openWorldCompilation: reviewedCompilation(admission), objectiveBinding: objectiveBinding(contract), integrity, admittedAt: 100, ttlMs: 1_000 });

	const missing = structuredClone(receipt);
	delete missing.openWorld.snapshot.outcomes[0].id;
	assert.throws(() => decodeDurableContractAdmissionReceipt(missing), /missing required fields/i);

	const malformed = structuredClone(receipt);
	malformed.workContract.semanticAdjudication.cognitionUsage.inputTokens = 0.5;
	assert.throws(() => decodeDurableContractAdmissionReceipt(malformed), /cognition usage/i);

	const abusive = structuredClone(receipt);
	let nested = {};
	for (let index = 0; index < 70; index++) nested = { nested };
	abusive.openWorld.snapshot.outcomes[0].dependsOnOutcomeIds = [nested];
	assert.throws(() => decodeDurableContractAdmissionReceipt(abusive), /structural bounds/i);
});

function objectiveBinding(originalWorkContract, revisions = []) {
	return { objectiveId: "objective:test", originalWorkContract, revisions };
}

function situation(summary) {
	return { summary, goals: ["完成报告"], constraints: [], uncertainties: [], observations: [], possibleActions: [], relevantMemoryIds: [], relevantTaskIds: [], confidence: 1 };
}

function digest(value) {
	return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

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

function inventoryCompilerAdmission(contract) {
	const primaryModelIdentity = "test/contract-inventory/test";
	const reviewerModelIdentity = "beemax/deterministic-semantic-inventory-compiler/v1";
	const cognitionUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, modelIdentities: [primaryModelIdentity] };
	return createAdmittedWorkContractPlanningInput({
		contract,
		source: "model",
		cognitionUsage,
		cognitionBudgetChargeTokens: 50,
		semanticAdjudication: {
			schemaVersion: WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION,
			inventorySchemaVersion: "beemax.semantic-inventory.v1",
			primaryModelIdentity,
			reviewerModelIdentity,
			reviewMode: "inventory_with_deterministic_compiler",
			independentSamples: false,
			cognitionUsage,
			cognitionBudgetChargeTokens: 50,
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

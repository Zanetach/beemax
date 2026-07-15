import assert from "node:assert/strict";
import test from "node:test";
import { capabilityInventory, capabilityRankingCases } from "../../../evals/capability-ranking-corpus.mjs";
import { activatedCapabilitiesFromTrace, executeOutcomeBoundCapabilityTask } from "../../../scripts/capability-outcome-harness.mjs";

test("Capability outcome evidence binds each selected Skill to its own completion receipt", () => {
	const candidates = [
		{ kind: "skill", name: "skill-a", version: "eval:1" },
		{ kind: "skill", name: "skill-b", version: "eval:1" },
	];
	const events = [
		{ type: "tool.settled", toolName: "skill_complete", status: "succeeded", capabilityReceipt: { id: "receipt:skill-a", kind: "skill", name: "skill-a", version: "eval:1", sourceTool: "skill_complete" } },
	];
	assert.deepEqual(activatedCapabilitiesFromTrace(candidates, events), ["skill-a"]);
});

test("accepted Capability execution remains accepted when its Objective enters the Completion Outbox", async () => {
	const scenario = capabilityRankingCases.find(({ id }) => id === "zh-web");
	const receipt = await executeOutcomeBoundCapabilityTask({
		scenario,
		cognitionId: "eval:completion-outbox",
		candidates: [{ kind: "tool", name: "web_search", version: "eval:1", confidence: 1, strategy: "semantic" }],
		inventory: capabilityInventory,
		threshold: 0.5,
	});
	assert.equal(receipt.verificationStatus, "accepted");
	assert.equal(receipt.downstreamOutcome, "accepted");
	assert.equal(receipt.executionTrace.filter(({ type }) => type === "verification.settled").length, 1);
});

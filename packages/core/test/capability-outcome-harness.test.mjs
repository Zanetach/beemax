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

test("Capability outcome maps a semantic MCP identity to its executable Tool name", async () => {
	const scenario = capabilityRankingCases.find(({ id }) => id === "zh-meeting");
	const receipt = await executeOutcomeBoundCapabilityTask({
		scenario,
		cognitionId: "eval:mcp-tool-name",
		candidates: [{ kind: "mcp", name: "meeting_schedule", version: "eval:1", confidence: 1, strategy: "semantic" }],
		inventory: capabilityInventory,
		threshold: 0.5,
	});
	assert.equal(receipt.verificationStatus, "accepted");
	assert.deepEqual(receipt.activatedCapabilities, ["meeting_schedule"]);
	assert.ok(receipt.executionTrace.some(({ type, toolName }) => type === "tool.settled" && toolName === "mcp_meeting_schedule"));
});

test("negative Capability outcome does not invent a Work Contract requirement", async () => {
	const scenario = capabilityRankingCases.find(({ id }) => id === "negative-chat");
	const receipt = await executeOutcomeBoundCapabilityTask({
		scenario,
		cognitionId: "eval:negative-no-requirement",
		candidates: [],
		inventory: capabilityInventory,
		threshold: 0.5,
	});
	assert.equal(receipt.verificationStatus, "accepted");
	assert.deepEqual(receipt.activatedCapabilities, []);
});

test("missing required Capability becomes a failed outcome receipt instead of crashing calibration", async () => {
	const scenario = capabilityRankingCases.find(({ id }) => id === "semantic-web-paraphrase");
	const receipt = await executeOutcomeBoundCapabilityTask({
		scenario,
		cognitionId: "eval:missing-required",
		candidates: [],
		inventory: capabilityInventory,
		threshold: 0.5,
	});
	assert.equal(receipt.status, "failed");
	assert.notEqual(receipt.verificationStatus, "accepted");
	assert.match(receipt.runtimeError, /required Capability resolution produced no trusted selection evidence/i);
});

test("Capability outcome separates a negated boundary from its positive file requirement", async () => {
	const scenario = capabilityRankingCases.find(({ id }) => id === "zh-file");
	const receipt = await executeOutcomeBoundCapabilityTask({
		scenario,
		cognitionId: "eval:file-with-prohibition",
		candidates: [{ kind: "tool", name: "file_read", version: "eval:1", confidence: 1, strategy: "semantic" }],
		inventory: capabilityInventory,
		threshold: 0.5,
	});
	assert.equal(receipt.verificationStatus, "accepted");
	assert.deepEqual(receipt.activatedCapabilities, ["file_read"]);
	const decision = receipt.executionTrace.find(({ type }) => type === "capability.decision");
	assert.equal(decision.candidates[0].name, "file_read");
	assert.ok(receipt.executionTrace.some(({ type, toolName }) => type === "tool.settled" && toolName === "read"));
});

test("Capability outcome accepts a positive result that follows an initial prohibition", async () => {
	const scenario = capabilityRankingCases.find(({ id }) => id === "negative-negated-memory");
	const receipt = await executeOutcomeBoundCapabilityTask({
		scenario,
		cognitionId: "eval:leading-prohibition",
		candidates: [],
		inventory: capabilityInventory,
		threshold: 0.5,
	});
	assert.equal(receipt.verificationStatus, "accepted");
	assert.deepEqual(receipt.activatedCapabilities, []);
});

test("Capability outcome maps multiple required capabilities to distinct source-bound requirements", async () => {
	const scenario = capabilityRankingCases.find(({ id }) => id === "multi-research-data");
	const receipt = await executeOutcomeBoundCapabilityTask({
		scenario,
		cognitionId: "eval:multi-requirement",
		candidates: [
			{ kind: "tool", name: "web_search", version: "eval:1", confidence: 1, strategy: "semantic" },
			{ kind: "tool", name: "data_analyze", version: "eval:1", confidence: 1, strategy: "semantic" },
		],
		inventory: capabilityInventory,
		threshold: 0.5,
	});
	assert.equal(receipt.verificationStatus, "accepted");
	assert.deepEqual(receipt.activatedCapabilities, ["web_search", "data_analyze"]);
});

test("Capability outcome does not turn every acceptance clause into a capability obligation", async () => {
	const scenario = capabilityRankingCases.find(({ id }) => id === "unknown-registry");
	const receipt = await executeOutcomeBoundCapabilityTask({
		scenario,
		cognitionId: "eval:single-capability-multiple-criteria",
		candidates: [{ kind: "mcp", name: "opaque_registry_query", version: "eval:1", confidence: 1, strategy: "semantic" }],
		inventory: capabilityInventory,
		threshold: 0.5,
	});
	assert.equal(receipt.verificationStatus, "accepted");
	assert.deepEqual(receipt.activatedCapabilities, ["opaque_registry_query"]);
});

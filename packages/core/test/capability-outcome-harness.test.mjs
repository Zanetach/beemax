import assert from "node:assert/strict";
import test from "node:test";
import { activatedCapabilitiesFromTrace } from "../../../scripts/capability-outcome-harness.mjs";

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

import assert from "node:assert/strict";
import test from "node:test";
import { ActionGovernance, MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY } from "../dist/index.js";

const base = { actionId: "call:1", toolName: "investigate", effectStatus: "none", reliability: "unknown", at: 100 };

test("Action Governance decides each action independently instead of using a global autonomy switch", () => {
	const governance = new ActionGovernance();
	const read = governance.decide({ ...base, toolPolicy: READ_ONLY_TOOL_POLICY });
	const mutation = governance.decide({ ...base, actionId: "call:2", toolName: "publish", toolPolicy: MUTATING_TOOL_POLICY });
	assert.equal(read.outcome, "allow");
	assert.equal(mutation.outcome, "require_approval");
	assert.notEqual(read.id, mutation.id);
});

test("unknown high-risk actions fail safely without blocking low-risk investigation", () => {
	const governance = new ActionGovernance();
	assert.equal(governance.decide({ ...base, toolPolicy: READ_ONLY_TOOL_POLICY }).outcome, "allow");
	const highRisk = governance.decide({ ...base, toolName: "unknown_external_action", toolPolicy: { ...MUTATING_TOOL_POLICY, approval: "never" } });
	assert.equal(highRisk.outcome, "require_approval");
	assert.equal(highRisk.reasonCode, "high_risk_requires_authority");
});

test("Enterprise allow cannot make high-risk or irreversible mutations autonomous", () => {
	const governance = new ActionGovernance();
	const enterprisePolicy = { disposition: "allow", id: "enterprise:allow", reason: "Enterprise permits the operation" };
	const highRisk = governance.decide({ ...base, toolName: "high_risk_update", toolPolicy: { ...MUTATING_TOOL_POLICY, approval: "never", reversible: true }, enterprisePolicy });
	const irreversible = governance.decide({ ...base, toolName: "irreversible_update", toolPolicy: { ...MUTATING_TOOL_POLICY, risk: "low", approval: "never", reversible: false }, enterprisePolicy });
	assert.equal(highRisk.outcome, "require_approval");
	assert.equal(highRisk.reasonCode, "high_risk_requires_authority");
	assert.equal(irreversible.outcome, "require_approval");
	assert.equal(irreversible.reasonCode, "irreversible_requires_authority");
	assert.equal(governance.decide({ ...base, toolName: "high_risk_update", toolPolicy: { ...MUTATING_TOOL_POLICY, approval: "never", reversible: true }, enterprisePolicy, approval: "approved" }).outcome, "allow");
});

test("Governance combines Enterprise Policy, Effect state, approval, and Execution Grant in one explainable result", () => {
	const governance = new ActionGovernance();
	const denied = governance.decide({ ...base, toolPolicy: READ_ONLY_TOOL_POLICY, enterprisePolicy: { disposition: "deny", id: "freeze", reason: "freeze" } });
	assert.equal(denied.outcome, "deny");
	const unresolved = governance.decide({ ...base, toolPolicy: MUTATING_TOOL_POLICY, effectStatus: "unknown", approval: "approved" });
	assert.equal(unresolved.reasonCode, "effect_reconciliation_required");
	const granted = governance.decide({ ...base, toolName: "publish", toolPolicy: MUTATING_TOOL_POLICY, executionGrant: { id: "grant:task", status: "active", allowedCapabilities: ["publish"] } });
	assert.equal(granted.outcome, "allow");
	assert.equal(granted.reasonCode, "execution_grant");
	for (const decision of [denied, unresolved, granted]) {
		assert.equal(typeof decision.explanation, "string");
		assert.equal(Array.isArray(decision.factors), true);
		assert.doesNotThrow(() => structuredClone(decision));
	}
});

test("degraded measured reliability raises mutation authority without penalizing read-only work", () => {
	const governance = new ActionGovernance();
	assert.equal(governance.decide({ ...base, reliability: "degraded", toolPolicy: READ_ONLY_TOOL_POLICY }).outcome, "allow");
	const mutation = governance.decide({ ...base, reliability: "degraded", toolPolicy: { ...MUTATING_TOOL_POLICY, risk: "medium", approval: "never", reversible: true } });
	assert.equal(mutation.outcome, "require_approval");
	assert.equal(mutation.reasonCode, "degraded_reliability");
});

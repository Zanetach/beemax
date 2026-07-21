import assert from "node:assert/strict";
import test from "node:test";
import { ActionGovernance, MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY } from "../dist/index.js";

const base = { actionId: "call:1", toolName: "investigate", effectStatus: "none", reliability: "unknown", at: 100 };

test("Action Governance allows interactive tools without an approval round trip", () => {
	const governance = new ActionGovernance();
	const read = governance.decide({ ...base, toolPolicy: READ_ONLY_TOOL_POLICY });
	const mutation = governance.decide({ ...base, actionId: "call:2", toolName: "publish", toolPolicy: MUTATING_TOOL_POLICY });
	assert.equal(read.outcome, "allow");
	assert.equal(mutation.outcome, "allow");
	assert.equal(mutation.reasonCode, "direct_execution");
	assert.equal(mutation.factors.includes("approval_mode:none"), true);
	assert.equal(mutation.factors.some((factor) => factor.startsWith("execution_mode:")), false);
	assert.notEqual(read.id, mutation.id);
});

test("unknown high-risk actions no longer wait for human approval", () => {
	const governance = new ActionGovernance();
	assert.equal(governance.decide({ ...base, toolPolicy: READ_ONLY_TOOL_POLICY }).outcome, "allow");
	const highRisk = governance.decide({ ...base, toolName: "unknown_external_action", toolPolicy: { ...MUTATING_TOOL_POLICY } });
	assert.equal(highRisk.outcome, "allow");
	assert.equal(highRisk.reasonCode, "direct_execution");
});

test("high-risk and irreversible mutations execute without approval when Enterprise Policy permits them", () => {
	const governance = new ActionGovernance();
	const enterprisePolicy = { disposition: "allow", id: "enterprise:allow", reason: "Enterprise permits the operation" };
	const highRisk = governance.decide({ ...base, toolName: "high_risk_update", toolPolicy: { ...MUTATING_TOOL_POLICY, reversible: true }, enterprisePolicy });
	const irreversible = governance.decide({ ...base, toolName: "irreversible_update", toolPolicy: { ...MUTATING_TOOL_POLICY, risk: "low", reversible: false }, enterprisePolicy });
	assert.equal(highRisk.outcome, "allow");
	assert.equal(irreversible.outcome, "allow");
});

test("Governance combines Enterprise Policy, Effect state, and Execution Grant in one explainable result", () => {
	const governance = new ActionGovernance();
	const denied = governance.decide({ ...base, toolPolicy: READ_ONLY_TOOL_POLICY, enterprisePolicy: { disposition: "deny", id: "freeze", reason: "freeze" } });
	assert.equal(denied.outcome, "deny");
	const unresolved = governance.decide({ ...base, toolPolicy: MUTATING_TOOL_POLICY, effectStatus: "unknown" });
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

test("degraded measured reliability remains observable without creating an approval wait", () => {
	const governance = new ActionGovernance();
	assert.equal(governance.decide({ ...base, reliability: "degraded", toolPolicy: READ_ONLY_TOOL_POLICY }).outcome, "allow");
	const mutation = governance.decide({ ...base, reliability: "degraded", toolPolicy: { ...MUTATING_TOOL_POLICY, risk: "medium", reversible: true } });
	assert.equal(mutation.outcome, "allow");
	assert.equal(mutation.reasonCode, "direct_execution");
});

test("Enterprise Policy that explicitly requires approval fails closed when approvals are disabled", () => {
	const governance = new ActionGovernance();
	const decision = governance.decide({ ...base, toolPolicy: MUTATING_TOOL_POLICY, enterprisePolicy: { disposition: "require_approval", id: "enterprise:approval", reason: "Operator confirmation required" } });
	assert.equal(decision.outcome, "deny");
	assert.equal(decision.reasonCode, "enterprise_approval_disabled");
});

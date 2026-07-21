import assert from "node:assert/strict";
import test from "node:test";
import {
	ReversibleActionAdmission,
	createExecutionEnvelope,
	createReversibleActionMutationAuthority,
	createAccessScopeRef,
	createEnterprisePolicyPublisher,
} from "../dist/index.js";

const accessScopeRef = createAccessScopeRef({ id: "scope:operations", authority: { kind: "enterprise_system", reference: "iam:operations" }, evidenceRef: "iam:audit:1", issuedAt: 100 });
const publisher = createEnterprisePolicyPublisher({ id: "publisher:admin", authority: { kind: "administrator_grant", reference: "admin:1" }, evidenceRef: "admin:audit:1", issuedAt: 100 });
const policy = {
	id: "policy:reversible-low-risk", disposition: "allow", reason: "Authorized reversible action", evidenceRefs: ["policy:1"],
	publisher, version: "v1", effectiveScope: { kind: "access_scope", id: "operations", accessScopeId: accessScopeRef.id },
	effectiveFrom: 100, effectiveUntil: 1_000, evaluatedAt: 500,
};
const capability = {
	name: "external_update",
	policy: { risk: "low", sideEffect: "external", reversible: true, timeoutMs: 1_000, maxAttempts: 1, maxResultBytes: 10_000, impact: "Updates one reversible resource", effectProofProvider: "provider-a" },
	compensation: { id: "compensation:external_update", capability: "external_restore", receiptProofProvider: "provider-a", exercisedAt: 450, validUntil: 900, evidenceRefs: ["drill:450"] },
};

test("a current enterprise-authorized low-risk capability with proven Compensation may enter proactive mutation", () => {
	const decision = new ReversibleActionAdmission().decide({
		actionId: "action:1", capability, enterprisePolicy: policy, accessScopeRef,
		emergencyStop: { status: "running", revision: 3, changedAt: 400 }, at: 500,
	});
	assert.deepEqual(decision, {
		outcome: "allow", reasonCode: "proven_reversible_action", actionId: "action:1", capability: "external_update",
		policyDecisionId: policy.id, compensationId: capability.compensation.id, emergencyStopRevision: 3, decidedAt: 500,
	});
});

test("the Pi Tool boundary rechecks scope, Compensation proof, and Emergency Stop revision", async () => {
	let stop = { scopeId: accessScopeRef.id, status: "running", revision: 3, changedAt: 400 };
	let durableProof = capability.compensation;
	const authority = createReversibleActionMutationAuthority({
		emergencyStop: () => stop,
		compensationProof: () => durableProof,
	}, () => 500);
	const executionEnvelope = createExecutionEnvelope({
		executionId: "execution:forward", trigger: { kind: "enterprise_event" }, accessScopeRef,
		proactiveAction: { phase: "forward", scopeId: accessScopeRef.id, capability: capability.name, forwardCapability: capability.name, policyDecisionId: policy.id, compensationId: capability.compensation.id, emergencyStopRevision: 3 },
	});
	const input = { source: { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" }, executionEnvelope, toolName: capability.name, policy: capability.policy, enterprisePolicy: policy };
	assert.deepEqual(await authority(input), { allowed: true });
	stop = { ...stop, status: "stopped", revision: 4 };
	assert.match((await authority(input)).reason, /stopped|revision changed/i);
	stop = { ...stop, status: "running", revision: 3 };
	durableProof = { ...durableProof, id: "compensation:replaced" };
	assert.match((await authority(input)).reason, /proof is missing or changed/i);
});

test("Emergency Stop, missing authority, stale proof, high risk, and irreversible actions fail closed", () => {
	const admission = new ReversibleActionAdmission();
	const base = { actionId: "action:blocked", capability, enterprisePolicy: policy, accessScopeRef, emergencyStop: { status: "running", revision: 3, changedAt: 400 }, at: 500 };
	const cases = [
		["emergency_stop_active", { emergencyStop: { status: "stopped", revision: 4, changedAt: 499 } }],
		["trusted_scope_required", { accessScopeRef: undefined }],
		["enterprise_policy_required", { enterprisePolicy: undefined }],
		["enterprise_policy_not_current", { at: 1_001 }],
		["enterprise_policy_scope_mismatch", { enterprisePolicy: { ...policy, effectiveScope: { kind: "access_scope", id: "other", accessScopeId: "scope:other" } } }],
		["enterprise_policy_does_not_allow_autonomy", { enterprisePolicy: { ...policy, disposition: "require_approval" } }],
		["low_risk_required", { capability: { ...capability, policy: { ...capability.policy, risk: "high" } } }],
		["proven_reversibility_required", { capability: { ...capability, policy: { ...capability.policy, reversible: false } } }],
		["rollback_exercise_not_current", { capability: { ...capability, compensation: { ...capability.compensation, validUntil: 499 } } }],
		["compensation_receipt_proof_mismatch", { capability: { ...capability, compensation: { ...capability.compensation, receiptProofProvider: "provider-b" } } }],
	];
	for (const [reasonCode, change] of cases) {
		const decision = admission.decide({ ...base, ...change });
		assert.equal(decision.outcome, "deny");
		assert.equal(decision.reasonCode, reasonCode);
	}
});

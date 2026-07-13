import assert from "node:assert/strict";
import test from "node:test";
import {
	ProactiveReversibleActionRuntime,
	ReversibleActionAdmission,
	createAccessScopeRef,
	createEnterprisePolicyPublisher,
	createSituation,
} from "../dist/index.js";

const accessScopeRef = createAccessScopeRef({ id: "scope:operations", authority: { kind: "enterprise_system", reference: "iam:operations" }, issuedAt: 100 });
const publisher = createEnterprisePolicyPublisher({ id: "publisher:admin", authority: { kind: "administrator_grant", reference: "admin:1" }, issuedAt: 100 });
const enterprisePolicy = { id: "policy:1", disposition: "allow", reason: "authorized", evidenceRefs: ["policy:evidence"], publisher, version: "v1", effectiveScope: { kind: "access_scope", id: "operations", accessScopeId: accessScopeRef.id }, effectiveFrom: 100, effectiveUntil: 1_000, evaluatedAt: 500 };
const compensationEnterprisePolicy = { ...enterprisePolicy, id: "policy:compensation", reason: "authorized Compensation", evidenceRefs: ["policy:compensation:evidence"] };
const proof = { id: "compensation:update:v1", capability: "external_restore", receiptProofProvider: "provider-a", exercisedAt: 400, validUntil: 900, evidenceRefs: ["drill:400"] };
const capability = { name: "external_update", policy: { risk: "low", sideEffect: "external", approval: "never", reversible: true, timeoutMs: 1_000, maxAttempts: 1, maxResultBytes: 10_000, impact: "Updates one reversible resource", effectProofProvider: "provider-a" }, compensation: proof };
const compensationCapability = { name: "external_restore", policy: { ...capability.policy, impact: "Restores one resource from a trusted Effect receipt" } };
const observation = { id: "observation:1", dedupeKey: "dedupe:1", triggerKind: "enterprise_event", triggerId: "event:1", scope: { profileId: "profile", platform: "feishu", chatId: "chat", userId: "user" }, situation: createSituation({ summary: "A governed state may need adjustment", observations: [{ statement: "Authoritative state changed", source: { kind: "enterprise_system", reference: "event:1" }, evidenceRef: "event:1", confidence: 0.9, trust: "observed" }], confidence: 0.9 }), action: "Apply the bounded adjustment", expectedValue: 0.9, risk: "low", rationale: "Verified state requires attention", intendedVerification: "The authoritative state matches the intended outcome", evidenceRefs: ["event:1"], confidence: 0.9, mode: "observe_only", disposition: "new_candidate", notificationEmitted: false, observedAt: 500, repeatCount: 1, feedback: "accepted", createdAt: 500, lastObservedAt: 500 };
const executionScope = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };

function controls(status = "running") {
	return { emergencyStop: () => ({ scopeId: accessScopeRef.id, status, revision: 2, changedAt: 450 }), compensationProof: () => proof };
}
const autonomy = { allows: () => ({ allowed: true, level: "reversible_action", reasons: [] }) };

test("an admitted reversible action uses the unified Pi port with bounded capability and authority references", async () => {
	const executions = [];
	const runtime = new ProactiveReversibleActionRuntime({
		autonomy,
		controls: controls(), admission: new ReversibleActionAdmission(),
		execute: async (input) => { executions.push(input); return { status: "succeeded", objectiveId: "objective:1", verification: "accepted", committedEffectIds: ["effect:1"] }; },
		compensate: async () => assert.fail("accepted work must not compensate"),
	});
	const result = await runtime.consider({ observation, executionScope, accessScopeRef, enterprisePolicy, capability, compensationCapability, compensationEnterprisePolicy }, 500);
	assert.deepEqual(result, { kind: "succeeded", objectiveId: "objective:1", committedEffectIds: ["effect:1"], notify: true });
	assert.equal(executions.length, 1);
	assert.deepEqual(executions[0].allowedCapabilities, [capability.name]);
	assert.equal(executions[0].policyDecisionId, enterprisePolicy.id);
	assert.equal(executions[0].emergencyStopRevision, 2);
	assert.deepEqual(executions[0].proactiveAction, { phase: "forward", scopeId: accessScopeRef.id, capability: capability.name, forwardCapability: capability.name, policyDecisionId: enterprisePolicy.id, compensationId: proof.id, emergencyStopRevision: 2 });
	assert.deepEqual(executions[0].budget, { maxToolCalls: 3, maxTokens: 4_000, deadlineAt: 30_500, maxCorrectiveAttempts: 0 });
});

test("rejected Verification compensates every committed Effect through linked Effect execution", async () => {
	const compensations = [];
	const runtime = new ProactiveReversibleActionRuntime({
		autonomy,
		controls: controls(), admission: new ReversibleActionAdmission(),
		execute: async () => ({ status: "succeeded", objectiveId: "objective:2", verification: "rejected", committedEffectIds: ["effect:forward"] }),
		compensate: async (input) => { compensations.push(input); return { status: "committed", effectId: "effect:compensation", verification: "accepted" }; },
	});
	const result = await runtime.consider({ observation, executionScope, accessScopeRef, enterprisePolicy, capability, compensationCapability, compensationEnterprisePolicy }, 500);
	assert.deepEqual(result, { kind: "compensated", objectiveId: "objective:2", originalEffectIds: ["effect:forward"], compensationEffectIds: ["effect:compensation"], notify: true });
	assert.equal(compensations[0].compensatesEffectId, "effect:forward");
	assert.equal(compensations[0].capability, proof.capability);
	assert.deepEqual(compensations[0].allowedCapabilities, [proof.capability]);
	assert.equal(compensations[0].policyDecision.id, compensationEnterprisePolicy.id);
	assert.deepEqual(compensations[0].proactiveAction, { phase: "compensation", scopeId: accessScopeRef.id, capability: proof.capability, forwardCapability: capability.name, policyDecisionId: compensationEnterprisePolicy.id, compensationId: proof.id, emergencyStopRevision: 2 });
});

test("Emergency Stop prevents execution even when the action otherwise has enterprise authority", async () => {
	let executions = 0;
	const runtime = new ProactiveReversibleActionRuntime({ autonomy, controls: controls("stopped"), admission: new ReversibleActionAdmission(), execute: async () => { executions++; throw new Error("must not run"); }, compensate: async () => { throw new Error("must not run"); } });
	const result = await runtime.consider({ observation, executionScope, accessScopeRef, enterprisePolicy, capability, compensationCapability, compensationEnterprisePolicy }, 500);
	assert.equal(result.kind, "rejected");
	assert.equal(result.reason, "emergency_stop_active");
	assert.equal(executions, 0);
});

test("reversible action runtime fails closed when its Profile rollout level is stopped", async () => {
	let executions = 0;
	const runtime = new ProactiveReversibleActionRuntime({
		autonomy: { allows: () => ({ allowed: false, level: "reversible_action", reasons: ["stopped"] }) },
		controls: controls(), admission: new ReversibleActionAdmission(),
		execute: async () => { executions++; throw new Error("must not run"); },
		compensate: async () => { throw new Error("must not run"); },
	});
	const result = await runtime.consider({ observation, executionScope, accessScopeRef, enterprisePolicy, capability, compensationCapability, compensationEnterprisePolicy }, 500);
	assert.deepEqual(result, { kind: "rejected", reason: "autonomy_level_disabled", notify: false });
	assert.equal(executions, 0);
});

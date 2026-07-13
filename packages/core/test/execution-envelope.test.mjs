import assert from "node:assert/strict";
import test from "node:test";
import { createAccessScopeRef, createExecutionEnvelope } from "../dist/index.js";

test("Execution Envelope carries generic durable identity and trusted references without a business ontology", () => {
	const accessScopeRef = createAccessScopeRef({ id: "scope:operations", authority: { kind: "membership_registry", reference: "membership:42" }, issuedAt: 10 });
	const envelope = createExecutionEnvelope({
		executionId: "execution:42",
		trigger: { kind: "interaction", id: "message:9" },
		objectiveId: "objective:7",
		taskId: "task:8",
		taskRunId: "run:3",
		accessScopeRef,
		budget: { maxToolCalls: 12, maxTokens: 20_000, deadlineAt: 50_000 },
		mode: "normal",
	});
	assert.deepEqual(envelope, {
		executionId: "execution:42", trigger: { kind: "interaction", id: "message:9" }, objectiveId: "objective:7", taskId: "task:8", taskRunId: "run:3",
		accessScopeRef, budget: { maxToolCalls: 12, maxTokens: 20_000, deadlineAt: 50_000 }, mode: "normal",
	});
	assert.equal("customer" in envelope, false);
	assert.equal(Object.isFrozen(envelope), true);
	assert.equal(Object.isFrozen(envelope.trigger), true);
	assert.equal(Object.isFrozen(envelope.budget), true);
	assert.equal(Object.isFrozen(envelope.accessScopeRef), true);
	assert.equal(Object.isFrozen(envelope.accessScopeRef.authority), true);
});

test("Execution Envelope rejects Secret material and invalid execution limits", () => {
	assert.throws(() => createExecutionEnvelope({ executionId: "execution:secret", trigger: { kind: "interaction", id: "Bearer sk-secret-value" } }), /credential/i);
	assert.throws(() => createExecutionEnvelope({ executionId: "execution:bad", trigger: { kind: "interaction" }, budget: { maxToolCalls: 0 } }), /maxToolCalls/);
	assert.throws(() => createExecutionEnvelope({ executionId: "execution:bad-trigger", trigger: { kind: "invented" } }), /trigger/i);
	assert.throws(() => createExecutionEnvelope({ executionId: "execution:untrusted", trigger: { kind: "interaction" }, accessScopeRef: { id: "scope:fake", trust: "reported", authority: { kind: "enterprise_system", reference: "iam:fake" }, issuedAt: 1 } }), /trusted|Access Scope/i);
});

test("Execution Envelope binds one proactive mutation capability to durable authority references", () => {
	const accessScopeRef = createAccessScopeRef({ id: "scope:operations", authority: { kind: "enterprise_system", reference: "iam:operations" }, issuedAt: 10 });
	const proactiveAction = { phase: "forward", scopeId: accessScopeRef.id, capability: "state_update", forwardCapability: "state_update", policyDecisionId: "policy:1", compensationId: "compensation:1", emergencyStopRevision: 3 };
	const envelope = createExecutionEnvelope({ executionId: "execution:proactive", trigger: { kind: "enterprise_event" }, accessScopeRef, proactiveAction });
	assert.deepEqual(envelope.proactiveAction, proactiveAction);
	assert.equal(Object.isFrozen(envelope.proactiveAction), true);
	assert.throws(() => createExecutionEnvelope({ ...envelope, proactiveAction: { ...proactiveAction, capability: "different_tool" } }), /must match/i);
	assert.throws(() => createExecutionEnvelope({ ...envelope, proactiveAction: { ...proactiveAction, emergencyStopRevision: -1 } }), /revision/i);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
	MUTATING_TOOL_POLICY,
	READ_ONLY_TOOL_POLICY,
	UnattendedExecutionAdmission,
	createAccessScopeRef,
} from "../dist/index.js";

const accessScopeRef = createAccessScopeRef({
	id: "scope:finance-research",
	authority: { kind: "enterprise_system", reference: "iam:finance-research" },
	evidenceRef: "iam-receipt:finance-research",
	issuedAt: 100,
});

const standingAuthority = {
	id: "authority:profile-research",
	kind: "profile_standing",
	status: "active",
	profileId: "profile:analyst",
	allowedCapabilities: ["market_research"],
	accessScopeIds: ["scope:finance-research"],
	evidenceRefs: ["profile-policy:research-v3"],
	statusRevision: 4,
	statusEvidenceRef: "authority-status:profile-research:4",
	statusCheckedAt: 200,
	issuedAt: 100,
	expiresAt: 1_000,
};

const base = {
	actionId: "action:gold-weekly",
	profileId: "profile:analyst",
	toolName: "market_research",
	toolPolicy: READ_ONLY_TOOL_POLICY,
	effectStatus: "none",
	reliability: "reliable",
	intent: "resolved",
	legalAuthority: "not_required",
	requiresAccessScope: true,
	accessScopeRef,
	credentialRequirements: [{ ref: "cred_11111111-1111-1111-1111-111111111111", status: "available", evidenceRef: "vault-check:market-data", verifiedAt: 190, expiresAt: 900 }],
	standingAuthority,
	enterprisePolicy: { status: "not_applicable", evidenceRef: "policy-check:market-research", evaluatedAt: 200 },
	at: 200,
};

test("a current standing Profile authority admits a scoped read-only action without user interaction", () => {
	const decision = new UnattendedExecutionAdmission().decide(base);

	assert.equal(decision.outcome, "allow");
	assert.equal(decision.reasonCode, "standing_profile_authority");
	assert.equal(decision.authorityKind, "profile_standing");
	assert.equal(decision.authorityId, standingAuthority.id);
	assert.deepEqual(decision.evidenceRefs, ["iam-receipt:finance-research", "vault-check:market-data", "policy-check:market-research", "profile-policy:research-v3", "authority-status:profile-research:4"]);
});

test("standing authority cannot silently authorize a high-risk irreversible action", () => {
	const decision = new UnattendedExecutionAdmission().decide({
		...base,
		toolName: "payment_send",
		toolPolicy: { ...MUTATING_TOOL_POLICY, reversible: false },
		credentialRequirements: [],
		standingAuthority: { ...standingAuthority, allowedCapabilities: ["payment_send"] },
		emergencyStop: { scopeId: "scope:finance-research", status: "running", revision: 7, evidenceRef: "emergency-stop:revision-7", observedAt: 200 },
	});

	assert.equal(decision.outcome, "blocked");
	assert.equal(decision.reasonCode, "scoped_execution_grant_required");
});

test("standing authority requires a current rollback exercise for a reversible mutation", () => {
	const mutation = {
		...base,
		toolName: "profile_update",
		toolPolicy: { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "low", approval: "never", reversible: true },
		credentialRequirements: [],
		standingAuthority: { ...standingAuthority, allowedCapabilities: ["profile_update"] },
		emergencyStop: { scopeId: "scope:finance-research", status: "running", revision: 7, evidenceRef: "emergency-stop:revision-7", observedAt: 200 },
	};

	assert.equal(new UnattendedExecutionAdmission().decide(mutation).reasonCode, "scoped_execution_grant_required");
	const admitted = new UnattendedExecutionAdmission().decide({
		...mutation,
		reversibleCapability: {
			name: "profile_update",
			policy: mutation.toolPolicy,
			compensation: { id: "compensation:profile-update", capability: "profile_update_rollback", exercisedAt: 150, validUntil: 250, evidenceRefs: ["rollback-drill:profile-update"] },
		},
	});
	assert.equal(admitted.reasonCode, "standing_profile_authority");
	assert.equal(admitted.evidenceRefs.includes("rollback-drill:profile-update"), true);
});

test("an exact, current scoped Execution Grant admits pre-authorized high-risk work", () => {
	const decision = new UnattendedExecutionAdmission().decide({
		...base,
		toolName: "payment_send",
		toolPolicy: { ...MUTATING_TOOL_POLICY, reversible: false },
		credentialRequirements: [],
		standingAuthority: undefined,
		emergencyStop: { scopeId: "scope:finance-research", status: "running", revision: 7, evidenceRef: "emergency-stop:revision-7", observedAt: 200 },
		executionGrant: {
			id: "grant:payment-42",
			kind: "scoped_execution",
			status: "active",
			profileId: "profile:analyst",
			allowedCapabilities: ["payment_send"],
			accessScopeIds: ["scope:finance-research"],
			evidenceRefs: ["approval:payment-42"],
			statusRevision: 2,
			statusEvidenceRef: "authority-status:payment-42:2",
			statusCheckedAt: 200,
			issuedAt: 150,
			expiresAt: 250,
		},
	});

	assert.equal(decision.outcome, "allow");
	assert.equal(decision.reasonCode, "scoped_execution_grant");
	assert.equal(decision.authorityKind, "scoped_execution");
});

test("a missing credential fails closed with durable availability evidence", () => {
	const missingCredential = new UnattendedExecutionAdmission().decide({ ...base, credentialRequirements: [{ ...base.credentialRequirements[0], status: "missing" }] });
	assert.equal(missingCredential.reasonCode, "credential_missing");
	assert.equal(missingCredential.evidenceRefs.includes("vault-check:market-data"), true);
});

test("material intent ambiguity fails closed", () => {
	assert.equal(new UnattendedExecutionAdmission().decide({ ...base, intent: "materially_ambiguous" }).reasonCode, "material_intent_ambiguous");
});

test("a revoked standing authority fails closed with status evidence", () => {
	const revoked = new UnattendedExecutionAdmission().decide({ ...base, standingAuthority: { ...standingAuthority, status: "revoked" } });
	assert.equal(revoked.reasonCode, "authority_revoked");
	assert.equal(revoked.evidenceRefs.includes("profile-policy:research-v3"), true);
});

test("an expired credential fails closed", () => {
	assert.equal(new UnattendedExecutionAdmission().decide({ ...base, at: 1_001, enterprisePolicy: { ...base.enterprisePolicy, evaluatedAt: 1_001 } }).reasonCode, "credential_expired");
});

test("a mutation without a current Emergency Stop snapshot cannot run unattended", () => {
	const decision = new UnattendedExecutionAdmission().decide({
		...base,
		toolName: "payment_send",
		toolPolicy: { ...MUTATING_TOOL_POLICY, reversible: false },
		credentialRequirements: [],
		standingAuthority: undefined,
		executionGrant: {
			id: "grant:payment-42", kind: "scoped_execution", status: "active", profileId: "profile:analyst",
			allowedCapabilities: ["payment_send"], accessScopeIds: ["scope:finance-research"], evidenceRefs: ["approval:payment-42"],
			statusRevision: 2, statusEvidenceRef: "authority-status:payment-42:2", statusCheckedAt: 200, issuedAt: 150, expiresAt: 250,
		},
	});

	assert.equal(decision.reasonCode, "emergency_stop_evidence_required");
});

test("reported or model-authored scope data cannot mint unattended authority", () => {
	assert.throws(() => new UnattendedExecutionAdmission().decide({
		...base,
		accessScopeRef: { ...accessScopeRef, trust: "reported" },
	}), /trusted Access Scope/i);
});

test("scope data without a verified trust marker cannot mint unattended authority", () => {
	const { trust: _trust, ...untrustedScope } = accessScopeRef;
	assert.throws(() => new UnattendedExecutionAdmission().decide({
		...base,
		accessScopeRef: untrustedScope,
	}), /trusted Access Scope/i);
});

test("a cached active authority snapshot cannot prove current revocation state", () => {
	const decision = new UnattendedExecutionAdmission().decide({
		...base,
		standingAuthority: { ...standingAuthority, statusCheckedAt: 199 },
	});

	assert.equal(decision.reasonCode, "authority_status_not_current");
});

test("omitting the Enterprise Policy applicability decision fails closed", () => {
	assert.throws(() => new UnattendedExecutionAdmission().decide({
		...base,
		enterprisePolicy: undefined,
	}), /Enterprise Policy applicability/i);
});

test("an Enterprise Policy decision for another Access Scope fails closed", () => {
	assert.throws(() => new UnattendedExecutionAdmission().decide({
		...base,
		enterprisePolicy: {
			status: "decision",
			decision: {
				id: "policy:other-scope", disposition: "allow", reason: "Allowed elsewhere", evidenceRefs: ["policy-evidence:other"],
				publisher: { id: "publisher:policy", trust: "verified", authority: { kind: "enterprise_system", reference: "policy-system" }, issuedAt: 100 },
				version: "v1", effectiveScope: { kind: "access_scope", id: "scope-rule:other", accessScopeId: "scope:other" },
				effectiveFrom: 100, effectiveUntil: 300, evaluatedAt: 200,
			},
		},
	}), /Enterprise Policy.*Access Scope/i);
});

test("an unrelated rollback exercise cannot prove this mutation reversible", () => {
	const toolPolicy = { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "low", approval: "never", reversible: true };
	assert.throws(() => new UnattendedExecutionAdmission().decide({
		...base,
		toolName: "profile_update",
		toolPolicy,
		credentialRequirements: [],
		standingAuthority: { ...standingAuthority, allowedCapabilities: ["profile_update"] },
		emergencyStop: { scopeId: "scope:finance-research", status: "running", revision: 7, evidenceRef: "emergency-stop:revision-7", observedAt: 200 },
		reversibleCapability: {
			name: "another_update",
			policy: toolPolicy,
			compensation: { id: "compensation:other", capability: "another_update_rollback", exercisedAt: 150, validUntil: 250, evidenceRefs: ["rollback-drill:other"] },
		},
	}), /forward Capability.*match/i);
});

test("an Emergency Stop snapshot for another Access Scope fails closed", () => {
	const decision = new UnattendedExecutionAdmission().decide({
		...base,
		toolName: "payment_send",
		toolPolicy: { ...MUTATING_TOOL_POLICY, reversible: false },
		credentialRequirements: [],
		standingAuthority: undefined,
		emergencyStop: { scopeId: "scope:other", status: "running", revision: 7, evidenceRef: "emergency-stop:other", observedAt: 200 },
		executionGrant: {
			id: "grant:payment-42", kind: "scoped_execution", status: "active", profileId: "profile:analyst",
			allowedCapabilities: ["payment_send"], accessScopeIds: ["scope:finance-research"], evidenceRefs: ["approval:payment-42"],
			statusRevision: 2, statusEvidenceRef: "authority-status:payment-42:2", statusCheckedAt: 200, issuedAt: 150, expiresAt: 250,
		},
	});

	assert.equal(decision.reasonCode, "emergency_stop_scope_mismatch");
});

test("a mutation grant must cover its mandatory Access Scope even when the advisory flag is false", () => {
	const decision = new UnattendedExecutionAdmission().decide({
		...base,
		requiresAccessScope: false,
		toolName: "payment_send",
		toolPolicy: { ...MUTATING_TOOL_POLICY, reversible: false },
		credentialRequirements: [],
		standingAuthority: undefined,
		emergencyStop: { scopeId: "scope:finance-research", status: "running", revision: 7, evidenceRef: "emergency-stop:revision-7", observedAt: 200 },
		executionGrant: {
			id: "grant:payment-42", kind: "scoped_execution", status: "active", profileId: "profile:analyst",
			allowedCapabilities: ["payment_send"], accessScopeIds: ["scope:other"], evidenceRefs: ["approval:payment-42"],
			statusRevision: 2, statusEvidenceRef: "authority-status:payment-42:2", statusCheckedAt: 200, issuedAt: 150, expiresAt: 250,
		},
	});

	assert.equal(decision.reasonCode, "authority_scope_mismatch");
});

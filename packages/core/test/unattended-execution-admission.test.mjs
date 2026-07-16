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
	at: 200,
};

test("a current standing Profile authority admits a scoped read-only action without user interaction", () => {
	const decision = new UnattendedExecutionAdmission().decide(base);

	assert.equal(decision.outcome, "allow");
	assert.equal(decision.reasonCode, "standing_profile_authority");
	assert.equal(decision.authorityKind, "profile_standing");
	assert.equal(decision.authorityId, standingAuthority.id);
	assert.deepEqual(decision.evidenceRefs, ["iam-receipt:finance-research", "vault-check:market-data", "profile-policy:research-v3"]);
});

test("standing authority cannot silently authorize a high-risk irreversible action", () => {
	const decision = new UnattendedExecutionAdmission().decide({
		...base,
		toolName: "payment_send",
		toolPolicy: { ...MUTATING_TOOL_POLICY, reversible: false },
		credentialRequirements: [],
		standingAuthority: { ...standingAuthority, allowedCapabilities: ["payment_send"] },
	});

	assert.equal(decision.outcome, "blocked");
	assert.equal(decision.reasonCode, "scoped_execution_grant_required");
});

test("an exact, current scoped Execution Grant admits pre-authorized high-risk work", () => {
	const decision = new UnattendedExecutionAdmission().decide({
		...base,
		toolName: "payment_send",
		toolPolicy: { ...MUTATING_TOOL_POLICY, reversible: false },
		credentialRequirements: [],
		standingAuthority: undefined,
		executionGrant: {
			id: "grant:payment-42",
			kind: "scoped_execution",
			status: "active",
			profileId: "profile:analyst",
			allowedCapabilities: ["payment_send"],
			accessScopeIds: ["scope:finance-research"],
			evidenceRefs: ["approval:payment-42"],
			issuedAt: 150,
			expiresAt: 250,
		},
	});

	assert.equal(decision.outcome, "allow");
	assert.equal(decision.reasonCode, "scoped_execution_grant");
	assert.equal(decision.authorityKind, "scoped_execution");
});

test("missing credentials, material ambiguity, revocation, and expiry fail closed with exact blockers", () => {
	const admission = new UnattendedExecutionAdmission();
	assert.equal(admission.decide({ ...base, credentialRequirements: [{ ...base.credentialRequirements[0], status: "missing" }] }).reasonCode, "credential_missing");
	assert.equal(admission.decide({ ...base, intent: "materially_ambiguous" }).reasonCode, "material_intent_ambiguous");
	assert.equal(admission.decide({ ...base, standingAuthority: { ...standingAuthority, status: "revoked" } }).reasonCode, "authority_revoked");
	assert.equal(admission.decide({ ...base, at: 1_001 }).reasonCode, "credential_expired");
});

test("reported or model-authored scope data cannot mint unattended authority", () => {
	assert.throws(() => new UnattendedExecutionAdmission().decide({
		...base,
		accessScopeRef: { ...accessScopeRef, trust: "reported" },
	}), /trusted Access Scope/i);
});

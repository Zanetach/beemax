import assert from "node:assert/strict";
import test from "node:test";
import {
	EnterprisePolicyRuntime,
	MUTATING_TOOL_POLICY,
	READ_ONLY_TOOL_POLICY,
	createAccessScopeRef,
	createEnterprisePolicyProvider,
	createEnterprisePolicyPublisher,
	resolveEnterprisePolicyDecision,
} from "../dist/index.js";

const publisher = createEnterprisePolicyPublisher({
	id: "publisher:security-office",
	authority: { kind: "administrator_grant", reference: "admin-grant:42" },
	evidenceRef: "audit:publisher-onboarding:42",
	issuedAt: 100,
});
const accessScopeRef = createAccessScopeRef({ id: "scope:finance", authority: { kind: "enterprise_system", reference: "iam:finance" }, evidenceRef: "iam:audit:7", issuedAt: 100 });

test("trusted Enterprise Policy providers stamp decisions with publisher, version, scope, time, and evidence", async () => {
	const provider = createEnterprisePolicyProvider({
		publisher, version: "policy-2026.07.13", effectiveScope: { kind: "access_scope", id: "finance-policy", accessScopeId: "scope:finance" }, effectiveFrom: 100, effectiveUntil: 1_000,
		decide: async () => ({ id: "allow-read", disposition: "allow", reason: "Approved enterprise read path", evidenceRefs: ["policy-doc:read:8"] }),
	});
	const decision = await new EnterprisePolicyRuntime(provider).evaluate({ source: { platform: "cli", chatId: "local", chatType: "dm", userId: "user" }, toolName: "ledger_read", args: {}, toolPolicy: READ_ONLY_TOOL_POLICY, accessScopeRef, at: 500 });
	assert.deepEqual(decision, {
		id: "allow-read", disposition: "allow", reason: "Approved enterprise read path", evidenceRefs: ["policy-doc:read:8"],
		publisher, version: "policy-2026.07.13", effectiveScope: { kind: "access_scope", id: "finance-policy", accessScopeId: "scope:finance" }, effectiveFrom: 100, effectiveUntil: 1_000, evaluatedAt: 500,
	});
	assert.doesNotThrow(() => structuredClone(decision));
});

test("Enterprise Policy never applies outside its trusted scope or effective time", async () => {
	let calls = 0;
	const provider = createEnterprisePolicyProvider({
		publisher, version: "v1", effectiveScope: { kind: "access_scope", id: "finance", accessScopeId: "scope:finance" }, effectiveFrom: 100, effectiveUntil: 200,
		decide: async () => { calls++; return { id: "deny", disposition: "deny", reason: "blocked", evidenceRefs: ["policy:deny"] }; },
	});
	const runtime = new EnterprisePolicyRuntime(provider);
	const base = { source: { platform: "cli", chatId: "local", chatType: "dm", userId: "user" }, toolName: "write", args: {}, toolPolicy: MUTATING_TOOL_POLICY };
	assert.equal(await runtime.evaluate({ ...base, accessScopeRef, at: 99 }), undefined);
	assert.equal(await runtime.evaluate({ ...base, accessScopeRef: createAccessScopeRef({ id: "scope:other", authority: { kind: "enterprise_system", reference: "iam:other" }, issuedAt: 100 }), at: 150 }), undefined);
	assert.equal(calls, 0);
});

test("model output and learned conventions cannot become trusted Enterprise Policy publishers", () => {
	for (const kind of ["model_output", "convention_candidate"]) {
		assert.throws(() => createEnterprisePolicyPublisher({ id: "untrusted", authority: { kind, reference: "memory:claim" }, issuedAt: 1 }), /trusted enterprise authority/i);
	}
	assert.throws(() => new EnterprisePolicyRuntime({ publisher, version: "forged", effectiveScope: { kind: "global", id: "all" }, effectiveFrom: 1, decide: async () => undefined }), /trusted Composition Root factory/i);
});

test("Enterprise Policy dispositions resolve through one generic action contract", () => {
	const decision = (disposition, constraints) => ({ id: disposition, disposition, reason: disposition, evidenceRefs: ["policy:test"], publisher, version: "v1", effectiveScope: { kind: "global", id: "all" }, effectiveFrom: 1, evaluatedAt: 2, ...(constraints ? { constraints } : {}) });
	assert.deepEqual(resolveEnterprisePolicyDecision(decision("allow"), MUTATING_TOOL_POLICY), { allowed: true, requiresApproval: false, reason: "allow" });
	assert.equal(resolveEnterprisePolicyDecision(decision("deny"), READ_ONLY_TOOL_POLICY).allowed, false);
	assert.equal(resolveEnterprisePolicyDecision(decision("missing_evidence"), READ_ONLY_TOOL_POLICY).allowed, false);
	assert.equal(resolveEnterprisePolicyDecision(decision("require_approval"), MUTATING_TOOL_POLICY).requiresApproval, true);
	assert.equal(resolveEnterprisePolicyDecision(decision("constrain", { allowedSideEffects: ["none"] }), MUTATING_TOOL_POLICY).allowed, false);
	assert.deepEqual(resolveEnterprisePolicyDecision(decision("constrain", { requireApproval: true, allowedSideEffects: ["external"] }), MUTATING_TOOL_POLICY), { allowed: true, requiresApproval: true, reason: "constrain" });
});

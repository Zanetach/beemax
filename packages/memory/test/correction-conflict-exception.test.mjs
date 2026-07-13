import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "../dist/index.js";

const scope = { profileId: "profile-a", platform: "feishu", chatId: "ops", userId: "operator" };
const claim = (statement) => ({ ...scope, kind: "fact", statement, visibility: "conversation", confidence: 0.9, stability: "medium", source: { type: "manual", ref: "source:handbook" }, evidence: { kind: "manual", excerpt: `Handbook states: ${statement}` } });

test("correction and conflict chains retain evidence on every affected Claim", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-chain-"));
	try {
		const memory = new MemoryStore(join(root, "memory.db"), "profile-a");
		const first = memory.upsertClaim(claim("玄穹流程应在周五完成"));
		const second = memory.upsertClaim(claim("玄穹流程应在周六完成"));
		assert.equal(memory.markClaimsConflicted(first.id, second.id, scope, { excerpt: "Two approved handbooks disagree", sourceRef: "audit:conflict:7" }), true);
		for (const id of [first.id, second.id]) assert.equal(memory.explainClaim(id, scope).evidence.some((item) => item.kind === "conflict" && /disagree/.test(item.excerpt)), true);

		const corrected = memory.correctClaim(first.id, { statement: "玄穹流程应在周日完成", evidence: { kind: "correction", excerpt: "Owner correction recorded in decision:9" } }, scope);
		assert.equal(corrected.status, "active");
		assert.equal(memory.explainClaim(first.id, scope).evidence.some((item) => item.kind === "correction"), true);
		assert.equal(memory.explainClaim(corrected.id, scope).evidence.some((item) => item.kind === "correction"), true);
		memory.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("exceptions remain scoped evidence-backed exceptions and can be forgotten only by their owner scope", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-exception-"));
	try {
		const memory = new MemoryStore(join(root, "memory.db"), "profile-a");
		const exception = memory.recordException({ ...scope, statement: "玄穹流程在监管停机日不执行", visibility: "conversation", source: { type: "document", ref: "policy:shutdown" }, evidence: { kind: "exception", excerpt: "Approved shutdown calendar 2026" } });
		assert.equal(exception.kind, "exception");
		assert.equal(memory.explainClaim(exception.id, scope).evidence[0].kind, "exception");
		assert.equal(memory.compileLongTermMemory(scope).includes("工作例外"), true);
		assert.equal(memory.forgetClaim(exception.id, { ...scope, chatId: "other" }), false);
		assert.equal(memory.explainClaim(exception.id, scope).claim.status, "active");
		assert.equal(memory.forgetClaim(exception.id, scope), true);
		assert.equal(memory.explainClaim(exception.id, scope), undefined);
		memory.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("revocation stops effective recall without erasing its evidence chain", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-revoke-"));
	try {
		const memory = new MemoryStore(join(root, "memory.db"), "profile-a");
		const current = memory.upsertClaim(claim("玄穹流程当前由值班负责人批准"));
		assert.equal(memory.revokeClaim(current.id, { ...scope, chatId: "other" }, { excerpt: "Owner withdrew decision:11" }), false);
		assert.equal(memory.revokeClaim(current.id, scope, { excerpt: "Owner withdrew decision:11", sourceRef: "decision:11" }), true);
		assert.equal(memory.listClaims(scope).some((item) => item.id === current.id), false);
		const explanation = memory.explainClaim(current.id, scope);
		assert.equal(explanation.claim.status, "archived");
		assert.equal(explanation.evidence.some((item) => item.kind === "revocation" && item.sourceRef === "decision:11"), true);
		memory.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

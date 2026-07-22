import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSituation } from "@thruvera/core";
import { MemoryStore } from "../dist/index.js";

const scope = { profileId: "profile-a", platform: "feishu", chatId: "ops", userId: "operator" };
const episode = (memory, id, summary, status = "verified") => memory.upsertEpisode({ ...scope, objectiveId: id, situation: createSituation({ summary, confidence: 0.9 }), action: "核对来源", outcome: "完成玄穹潮窗复核", evidence: `evidence:${id}`, status });

test("Situation recall ranks Episode, active Claim, Correction, Conflict, and Convention with release metrics", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-org-recall-"));
	try {
		const memory = new MemoryStore(join(root, "memory.db"), "profile-a");
		const old = memory.upsertClaim({ ...scope, kind: "fact", statement: "玄穹潮窗为周五", visibility: "conversation", confidence: 0.8, stability: "medium", evidence: { kind: "manual", excerpt: "旧版日历" } });
		const corrected = memory.correctClaim(old.id, { statement: "玄穹潮窗为周日", evidence: { kind: "correction", excerpt: "负责人更新潮窗" } }, scope);
		const conflictA = memory.upsertClaim({ ...scope, kind: "fact", statement: "玄穹事项需要双签", visibility: "conversation", confidence: 0.9, stability: "medium" });
		const conflictB = memory.upsertClaim({ ...scope, kind: "fact", statement: "玄穹事项不需要双签", visibility: "conversation", confidence: 0.9, stability: "medium" });
		memory.markClaimsConflicted(conflictA.id, conflictB.id, scope, { excerpt: "两个现行来源冲突" });
		const first = episode(memory, "objective:1", "玄穹潮窗复核");
		const second = episode(memory, "objective:2", "玄穹潮窗再次复核");
		const convention = memory.upsertConventionCandidate({ ...scope, statement: "玄穹事项通常先核对来源", rationale: "两个结果采用相同动作", confidence: 0.85, supportingEpisodeIds: [first.id, second.id] });
		memory.confirmConventionCandidate(convention.id, scope, { excerpt: "团队确认该惯例" });
		const result = memory.recallOrganizationKnowledge(createSituation({ summary: "核对玄穹潮窗和双签要求", confidence: 0.8 }), scope, 12);
		assert.equal(result.hits.some((hit) => hit.id === corrected.id && hit.kind === "claim"), true);
		assert.equal(result.hits.some((hit) => hit.id === old.id && hit.kind === "correction"), true);
		assert.equal(result.hits.some((hit) => hit.kind === "conflict"), true);
		assert.equal(result.hits.some((hit) => hit.kind === "episode"), true);
		assert.equal(result.hits.some((hit) => hit.id === convention.id && hit.kind === "convention"), true);
		assert.equal(result.hits.every((hit) => hit.score >= 0 && hit.score <= 1 && hit.reasons.length > 0), true);
		assert.equal(result.metrics.conflictsVisible >= 2, true);
		assert.equal(result.metrics.correctionsRetained, 1);
		assert.equal(result.metrics.elapsedMs < 250, true);
		assert.equal(memory.recallOrganizationKnowledge(createSituation({ summary: "玄穹", confidence: 1 }), { ...scope, chatId: "other" }, 10).hits.length, 0);
		memory.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

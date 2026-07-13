import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConventionConsolidator, MemoryStore } from "../dist/index.js";

const scope = { profileId: "profile-a", platform: "feishu", chatId: "ops", userId: "operator" };
const situation = (summary) => ({ summary, goals: ["完成工作"], confidence: 0.9 });
function episode(memory, objectiveId, summary, status = "verified") {
	return memory.upsertEpisode({ ...scope, objectiveId, situation: situation(summary), action: "先核对证据再执行", outcome: "结果通过独立验证", evidence: `evidence:${objectiveId}`, status });
}

test("asynchronous consolidation is idempotent and retains supporting episodes, time span, and exceptions", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-convention-"));
	try {
		const path = join(root, "memory.db");
		let memory = new MemoryStore(path, "profile-a");
		const first = episode(memory, "objective:1", "玄穹事项需要复核");
		const second = episode(memory, "objective:2", "玄穹事项再次需要复核");
		const exception = memory.recordException({ ...scope, kind: undefined, statement: "监管停机日不执行复核", visibility: "conversation", source: { type: "document", ref: "calendar:2026" }, evidence: { kind: "exception", excerpt: "Approved shutdown calendar" } });
		let asynchronous = false;
		const consolidator = new ConventionConsolidator(memory, async () => {
			await Promise.resolve(); asynchronous = true;
			return [{ statement: "玄穹事项通常先复核证据", rationale: "两个已验证结果呈现相同模式", confidence: 0.9, supportingEpisodeIds: [first.id, second.id], exceptionClaimIds: [exception.id], contradictoryEpisodeIds: [] }];
		});
		const one = await consolidator.run(scope);
		const two = await consolidator.run(scope);
		assert.equal(asynchronous, true);
		assert.equal(one[0].id, two[0].id);
		assert.deepEqual(one[0].supportingEpisodeIds.sort(), [first.id, second.id].sort());
		assert.deepEqual(one[0].exceptionClaimIds, [exception.id]);
		assert.equal(one[0].observedFrom <= one[0].observedUntil, true);
		assert.equal(memory.listConventionCandidates(scope).length, 1);
		memory.close();
		memory = new MemoryStore(path, "profile-a");
		const [afterRestart] = await new ConventionConsolidator(memory, async () => [{ statement: "玄穹事项通常先复核证据", rationale: "两个已验证结果呈现相同模式", confidence: 0.9, supportingEpisodeIds: [first.id, second.id], exceptionClaimIds: [exception.id], contradictoryEpisodeIds: [] }]).run(scope);
		assert.equal(afterRestart.id, one[0].id);
		memory.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("contradictory episodes lower confidence and block confirmation", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-convention-conflict-"));
	try {
		const memory = new MemoryStore(join(root, "memory.db"), "profile-a");
		const first = episode(memory, "objective:1", "星港事项先复核");
		const second = episode(memory, "objective:2", "星港事项也先复核");
		const conflict = episode(memory, "objective:3", "星港紧急事项未经复核", "conflicted");
		const [candidate] = await new ConventionConsolidator(memory, async () => [{ statement: "星港事项通常先复核", rationale: "重复行为", confidence: 0.9, supportingEpisodeIds: [first.id, second.id], contradictoryEpisodeIds: [conflict.id], exceptionClaimIds: [] }]).run(scope);
		assert.equal(candidate.promotionBlocked, true);
		assert.equal(candidate.confidence < 0.9, true);
		assert.equal(memory.confirmConventionCandidate(candidate.id, scope, { excerpt: "Reviewer decision" }), false);
		const initiallySafe = await new ConventionConsolidator(memory, async () => [{ statement: "星港高风险事项先复核", rationale: "重复行为", confidence: 0.9, supportingEpisodeIds: [first.id, second.id], contradictoryEpisodeIds: [], exceptionClaimIds: [] }]).run(scope);
		assert.equal(memory.confirmConventionCandidate(initiallySafe[0].id, scope, { excerpt: "Initial review" }), true);
		const [reconsidered] = await new ConventionConsolidator(memory, async () => [{ statement: "星港高风险事项先复核", rationale: "出现反例", confidence: 0.9, supportingEpisodeIds: [first.id, second.id], contradictoryEpisodeIds: [conflict.id], exceptionClaimIds: [] }]).run(scope);
		assert.equal(reconsidered.status, "rolled_back");
		assert.equal(memory.explainConventionCandidate(reconsidered.id, scope).events.some((item) => item.kind === "rollback"), true);
		memory.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("candidate lifecycle is evidence-backed, scope-isolated, supersedable, and rollbackable", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-convention-lifecycle-"));
	try {
		const memory = new MemoryStore(join(root, "memory.db"), "profile-a");
		const episodes = [episode(memory, "objective:1", "青岚事项先复核"), episode(memory, "objective:2", "青岚事项再次复核")];
		const infer = async (statement) => (await new ConventionConsolidator(memory, async () => [{ statement, rationale: "repeated", confidence: 0.8, supportingEpisodeIds: episodes.map((item) => item.id), contradictoryEpisodeIds: [], exceptionClaimIds: [] }]).run(scope))[0];
		const oldCandidate = await infer("青岚事项先复核");
		const replacement = await infer("青岚高风险事项先双人复核");
		const rejected = await infer("青岚事项无需复核");
		assert.equal(memory.confirmConventionCandidate(oldCandidate.id, { ...scope, chatId: "other" }, { excerpt: "wrong scope" }), false);
		assert.equal(memory.confirmConventionCandidate(oldCandidate.id, scope, { excerpt: "Team review:21", sourceRef: "review:21" }), true);
		assert.equal(memory.supersedeConventionCandidate(oldCandidate.id, replacement.id, scope, { excerpt: "Newer reviewed convention" }), true);
		assert.equal(memory.confirmConventionCandidate(replacement.id, scope, { excerpt: "Team review:22" }), true);
		assert.equal(memory.rollbackConventionCandidate(replacement.id, scope, { excerpt: "Post-deployment counterexample" }), true);
		assert.equal(memory.rejectConventionCandidate(rejected.id, scope, { excerpt: "Reviewer rejected overgeneralization" }), true);
		assert.equal(memory.getConventionCandidate(oldCandidate.id, scope).status, "superseded");
		assert.equal(memory.getConventionCandidate(replacement.id, scope).status, "rolled_back");
		assert.equal(memory.getConventionCandidate(rejected.id, scope).status, "rejected");
		assert.equal(memory.explainConventionCandidate(replacement.id, scope).events.some((item) => item.kind === "rollback"), true);
		memory.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

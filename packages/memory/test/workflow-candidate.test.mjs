import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createSituation } from "../../core/dist/index.js";
import { MemoryStore, WorkflowCandidateDeriver } from "../dist/index.js";

const scope = { profileId: "profile", platform: "eval", chatId: "workspace", userId: "reviewer" };

function episode(memory, objectiveId, statement, status = "verified") {
	return memory.upsertEpisode({ ...scope, objectiveId, situation: createSituation({ summary: statement, confidence: 0.9 }), action: `Act on ${statement}`, outcome: `Verified ${statement}`, evidence: `evidence:${objectiveId}`, status });
}

test("confirmed conventions derive an idempotent instruction-only Workflow Candidate with complete Episode lineage", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-workflow-candidate-"));
	const memory = new MemoryStore(join(root, "memory.db"), "profile");
	try {
		const first = episode(memory, "objective:1", "泽塔流程先核验来源");
		const second = episode(memory, "objective:2", "泽塔流程先核验来源");
		const contradiction = episode(memory, "objective:3", "泽塔流程在紧急情况跳过核验", "conflicted");
		const convention = memory.upsertConventionCandidate({ ...scope, statement: "泽塔事项通常先核验来源", rationale: "两次结果采用相同顺序", confidence: 0.88, supportingEpisodeIds: [first.id, second.id], contradictoryEpisodeIds: [contradiction.id] });
		assert.equal(memory.confirmConventionCandidate(convention.id, scope, { excerpt: "人工确认稳定惯例", sourceRef: "review:1" }), false, "contradiction blocks confirmation");
		const stable = memory.upsertConventionCandidate({ ...scope, statement: "泽塔事项完成后记录证据", rationale: "重复验证形成稳定惯例", confidence: 0.92, supportingEpisodeIds: [first.id, second.id] });
		assert.equal(memory.confirmConventionCandidate(stable.id, scope, { excerpt: "人工确认稳定惯例", sourceRef: "review:2" }), true);
		const deriver = new WorkflowCandidateDeriver(memory, async () => [{
			title: "泽塔证据记录流程", summary: "完成事项后记录可核验依据", conditions: ["事项结果已产生"], exceptions: ["权威来源不可用时暂停"],
			inputs: ["当前结果", "权威证据来源"], instructions: ["核验当前结果", "记录证据引用"], expectedOutcomes: ["结果具有证据链"], verification: ["证据引用可由独立读取验证"], sourceConventionIds: [stable.id],
		}]);
		const [candidate] = await deriver.run(scope);
		const [same] = await deriver.run(scope);
		assert.equal(same.id, candidate.id);
		assert.deepEqual(candidate.sourceConventionIds, [stable.id]);
		assert.deepEqual(candidate.supportingEpisodeIds.sort(), [first.id, second.id].sort());
		assert.deepEqual(candidate.contradictoryEpisodeIds, []);
		assert.equal(candidate.status, "candidate");
		assert.equal("execute" in candidate, false);
		assert.equal("tool" in candidate, false);
		const draft = memory.stageWorkflowSkillCandidate(candidate.id, scope, "zeta-evidence-flow");
		assert.equal(draft.source, `workflow-candidate:${candidate.id}@1`);
		assert.match(draft.instructions, /## Verification/);
		const staged = { name: draft.name, sha256: createHash("sha256").update(draft.instructions).digest("hex") };
		assert.equal(memory.authorizeWorkflowSkillPromotion(draft.source, scope, staged).allowed, true);
		assert.equal(memory.authorizeWorkflowSkillPromotion(draft.source, scope, { ...staged, sha256: "0".repeat(64) }).allowed, false);
		memory.upsertConventionCandidate({ ...scope, statement: stable.statement, rationale: stable.rationale, confidence: stable.confidence, supportingEpisodeIds: [first.id, second.id], contradictoryEpisodeIds: [contradiction.id] });
		assert.deepEqual(memory.getWorkflowCandidate(candidate.id, scope).contradictoryEpisodeIds, [contradiction.id], "later counter-evidence follows the durable lineage");
		assert.equal(memory.authorizeWorkflowSkillPromotion(draft.source, scope, staged).allowed, false, "promotion rechecks current source authority");
	} finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Workflow Candidates reject Secrets and retain human edit, reject, supersede, and archive evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-workflow-review-"));
	const memory = new MemoryStore(join(root, "memory.db"), "profile");
	try {
		const first = episode(memory, "objective:a", "星图事项记录依据");
		const second = episode(memory, "objective:b", "星图事项记录依据");
		const convention = memory.upsertConventionCandidate({ ...scope, statement: "星图事项记录依据", rationale: "稳定重复", confidence: 0.9, supportingEpisodeIds: [first.id, second.id] });
		memory.confirmConventionCandidate(convention.id, scope, { excerpt: "人工确认", sourceRef: "review:a" });
		const base = { ...scope, title: "星图流程", summary: "记录依据", conditions: ["结果存在"], exceptions: [], inputs: ["结果"], instructions: ["记录依据"], expectedOutcomes: ["依据可查"], verification: ["独立核验"], sourceConventionIds: [convention.id] };
		assert.throws(() => memory.upsertWorkflowCandidate({ ...base, instructions: ["Use Bearer sk-secret-value"] }), /credential|secret/i);
		const original = memory.upsertWorkflowCandidate(base);
		assert.equal(memory.editWorkflowCandidate(original.id, scope, { summary: "记录可验证依据", instructions: ["核验结果", "记录依据"] }, { excerpt: "Reviewer clarified steps", sourceRef: "review:edit" }), true);
		const replacement = memory.upsertWorkflowCandidate({ ...base, title: "星图流程 v2", summary: "改进证据记录" });
		assert.equal(memory.supersedeWorkflowCandidate(original.id, replacement.id, scope, { excerpt: "Reviewer selected v2", sourceRef: "review:supersede" }), true);
		assert.equal(memory.rejectWorkflowCandidate(replacement.id, scope, { excerpt: "Reviewer found missing exception", sourceRef: "review:reject" }), true);
		const archived = memory.upsertWorkflowCandidate({ ...base, title: "星图归档流程" });
		assert.equal(memory.archiveWorkflowCandidate(archived.id, scope, { excerpt: "No longer relevant", sourceRef: "review:archive" }), true);
		assert.equal(memory.getWorkflowCandidate(original.id, scope).status, "superseded");
		assert.equal(memory.getWorkflowCandidate(replacement.id, scope).status, "rejected");
		assert.equal(memory.getWorkflowCandidate(archived.id, scope).status, "archived");
		assert.deepEqual(memory.explainWorkflowCandidate(original.id, scope).events.map((event) => event.kind).sort(), ["edited", "superseded"]);
	} finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
});

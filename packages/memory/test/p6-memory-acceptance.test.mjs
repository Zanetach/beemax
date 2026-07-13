import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "../dist/index.js";

test("P6 recall gate meets Recall@5 and cross-customer isolation targets", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-p6-recall-gate-"));
	const store = new MemoryStore(join(root, "memory.db"), "p6-profile");
	try {
		const base = { profileId: "p6-profile", platform: "feishu", chatId: "sales", threadId: "orders", userId: "seller", projectId: "sales-team" };
		const claims = Array.from({ length: 20 }, (_, index) => {
			const number = index + 1;
			const subject = { type: "customer", id: `customer-${number}` };
			const object = { type: "order", id: `PO-${1000 + number}` };
			const keyword = `SKU-${7000 + number}`;
			const claim = store.upsertClaim({ ...base, kind: "requirement", statement: `${object.id} 要求 ${keyword} 使用客户专属包装方案 ${number}`, subject, object, visibility: "team", confidence: 1, stability: "high" });
			return { claim, subject, object, keyword };
		});
		const cases = claims.map(({ claim, subject, object, keyword }) => ({
			query: `${keyword} 包装要求`, options: { ...base, subject, object }, expectedIds: [claim.id], forbiddenIds: claims.filter((candidate) => candidate.claim.id !== claim.id).map((candidate) => candidate.claim.id),
		}));
		const evaluation = store.evaluateRecall(cases, 5);
		assert.ok(evaluation.recallAtK >= 0.95, `Recall@5 ${evaluation.recallAtK} is below 0.95`);
		assert.ok(evaluation.forbiddenRetrievalRate < 0.001, `Cross-customer retrieval rate ${evaluation.forbiddenRetrievalRate} is not below 0.001`);
		assert.deepEqual({ cases: evaluation.cases, expectedRetrieved: evaluation.expectedRetrieved, forbiddenRetrieved: evaluation.forbiddenRetrieved }, { cases: 20, expectedRetrieved: 20, forbiddenRetrieved: 0 });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

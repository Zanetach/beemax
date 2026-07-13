import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSituation } from "@beemax/core";
import { MemoryStore } from "../dist/index.js";

const scope = { profileId: "profile-a", platform: "feishu", chatId: "ops", userId: "operator" };

test("generic verified work forms one idempotent Situation-backed Episode without a business entity", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-episode-"));
	try {
		const memory = new MemoryStore(join(root, "memory.db"), "profile-a");
		const input = { ...scope, objectiveId: "objective:unfamiliar", situation: createSituation({ summary: "玄穹批次需要复核", goals: ["给出可验证结论"], confidence: 0.9 }), action: "Inspect available evidence", outcome: "复核完成，差异已说明", evidence: "artifact:review-7", status: "verified" };
		const first = memory.upsertEpisode(input);
		const second = memory.upsertEpisode(input);
		assert.equal(first.id, second.id);
		assert.equal(memory.listEpisodes(scope).length, 1);
		assert.equal(first.subject, undefined);
		assert.equal(memory.recallEpisodes("玄穹", scope)[0].objectiveId, "objective:unfamiliar");
		memory.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Episode knowledge states remain explicit and scope-isolated across restart", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-episode-state-"));
	const path = join(root, "memory.db");
	try {
		let memory = new MemoryStore(path, "profile-a");
		for (const status of ["candidate", "verified", "conflicted", "superseded"]) memory.upsertEpisode({ ...scope, objectiveId: `objective:${status}`, situation: createSituation({ summary: `${status} knowledge`, confidence: 1 }), action: "Assess", outcome: `${status} outcome`, status });
		memory.close(); memory = new MemoryStore(path, "profile-a");
		assert.deepEqual(memory.listEpisodes({ ...scope, statuses: ["candidate", "verified", "conflicted", "superseded"] }).map((item) => item.status).sort(), ["candidate", "conflicted", "superseded", "verified"]);
		assert.equal(memory.listEpisodes({ ...scope, chatId: "other", statuses: ["candidate", "verified", "conflicted", "superseded"] }).length, 0);
		assert.deepEqual(memory.recallEpisodes("outcome", scope).map((item) => item.status).sort(), ["conflicted", "verified"]);
		memory.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

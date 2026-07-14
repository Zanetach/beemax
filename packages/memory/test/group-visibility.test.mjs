import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../dist/index.js";

test("group recall never discloses the actor's private direct-message claims", () => {
	const directory = mkdtempSync(join(tmpdir(), "beemax-group-visibility-"));
	const store = new MemoryStore(join(directory, "memory.db"), "personal");
	try {
		const privateClaim = store.upsertClaim({
			profileId: "personal", platform: "feishu", chatId: "dm-alice", userId: "alice",
			kind: "fact", statement: "玄鸟暗号 private-only", visibility: "private", confidence: 1, stability: "high",
		});
		const sharedClaim = store.upsertClaim({
			profileId: "personal", platform: "feishu", chatId: "group-1", userId: "alice",
			kind: "fact", statement: "玄鸟暗号 group-shared", visibility: "conversation", confidence: 1, stability: "high",
		});

		const groupHits = store.recall("玄鸟暗号", {
			profileId: "personal", platform: "feishu", chatId: "group-1", userId: "alice", chatType: "group", limit: 10,
		});
		assert.ok(groupHits.some((hit) => hit.id === sharedClaim.id));
		assert.ok(groupHits.every((hit) => hit.id !== privateClaim.id));
		const otherParticipantHits = store.recall("玄鸟暗号", {
			profileId: "personal", platform: "feishu", chatId: "group-1", userId: "bob", chatType: "group", limit: 10,
		});
		assert.ok(otherParticipantHits.some((hit) => hit.id === sharedClaim.id));
		assert.ok(otherParticipantHits.every((hit) => hit.id !== privateClaim.id));

		const dmHits = store.recall("玄鸟暗号", {
			profileId: "personal", platform: "feishu", chatId: "dm-alice", userId: "alice", chatType: "dm", limit: 10,
		});
		assert.ok(dmHits.some((hit) => hit.id === privateClaim.id));
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

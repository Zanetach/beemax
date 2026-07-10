import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../dist/index.js";

test("natural-language recall is safe and follows a user across chats", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-test-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.remember({
			platform: "feishu",
			chatId: "chat-a",
			userId: "user-1",
			role: "memory",
			content: "User prefers concise weekly reports",
		});
		const records = store.recall('prefers "concise" OR', {
			platform: "feishu",
			chatId: "chat-b",
			userId: "user-1",
			limit: 5,
		});
		assert.equal(records.length, 1);
		assert.match(records[0].content, /concise/);
		assert.equal(store.list({ platform: "feishu", userId: "user-1" }).length, 1);
		assert.equal(store.forget(records[0].id, { platform: "feishu", userId: "user-1" }), true);
		assert.equal(store.list({ platform: "feishu", userId: "user-1" }).length, 0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("conversation candidates stay pending until explicitly promoted or rejected", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-candidates-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", chatId: "chat-a", userId: "user-1" };
		const candidate = store.recordCandidate({ ...scope, role: "user", content: "User prefers monthly strategy reviews" });
		assert.equal(store.list(scope).length, 0);
		assert.equal(store.recall("monthly strategy", scope).length, 0);
		assert.equal(store.listCandidates(scope).length, 1);
		assert.equal(store.promoteCandidate(candidate, scope), true);
		assert.equal(store.list(scope).length, 1);
		assert.deepEqual(store.stats(scope), { curated: 1, pending: 0, promoted: 1, rejected: 0 });
		const rejected = store.recordCandidate({ ...scope, role: "assistant", content: "Transient draft response" });
		assert.equal(store.rejectCandidate(rejected, scope), true);
		assert.equal(store.stats(scope).rejected, 1);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

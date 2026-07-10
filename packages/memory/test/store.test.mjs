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

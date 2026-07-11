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

test("task ledger stores verifiable profile-scoped task facts independently from chat memory", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-ledger-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.upsertTask({
			id: "anthropic-protocol",
			title: "Support Anthropic Messages protocol",
			status: "done",
			evidence: "tag:v0.1.0-preview.15", completedAt: 1_700_000_000_000,
		});
		assert.deepEqual(store.listTasks(), [{
			id: "anthropic-protocol",
			title: "Support Anthropic Messages protocol",
			status: "done",
			evidence: "tag:v0.1.0-preview.15",
			completedAt: 1_700_000_000_000,
			updatedAt: store.listTasks()[0].updatedAt,
		}]);
		store.upsertTask({ id: "anthropic-protocol", title: "Support Anthropic Messages protocol", status: "open" });
		assert.equal(store.listTasks()[0].status, "open");
		assert.equal(store.listTasks()[0].evidence, undefined);
		assert.equal(store.listTasks()[0].completedAt, undefined);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("structured understandings retain evidence, support correction, and compile a bounded long-term snapshot", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-understanding-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", userId: "zane" };
		const preference = store.upsertClaim({
			...scope, kind: "preference", statement: "用户默认使用中文，并希望先给结论再给依据。",
			confidence: 0.95, stability: "high", evidence: { kind: "conversation", excerpt: "默认中文，先给结论。" },
		});
		store.upsertClaim({
			...scope, kind: "project", statement: "BeeMax 正在建设可解释的长期记忆系统。",
			confidence: 0.9, stability: "medium", evidence: { excerpt: "按设计实施记忆系统。" },
		});
		assert.equal(store.recallBrief("用户默认使用中文", scope).claims[0].id, preference.id);
		assert.equal(store.recall("用户默认使用中文", scope)[0].id, preference.id);
		assert.equal(store.explainClaim(preference.id, scope).evidence[0].excerpt, "默认中文，先给结论。");
		const corrected = store.correctClaim(preference.id, { statement: "用户默认使用中文；架构讨论时需要完整方案。" }, scope);
		assert.ok(corrected);
		assert.equal(store.listClaims(scope).some((claim) => claim.id === preference.id), false);
		assert.match(store.compileLongTermMemory({ ...scope, maxChars: 1000 }), /架构讨论时需要完整方案/);
		assert.match(store.compileLongTermMemory({ ...scope, maxChars: 1000 }), /BeeMax 正在建设/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

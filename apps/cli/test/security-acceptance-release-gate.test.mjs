import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileToolEffectJournal, MUTATING_TOOL_POLICY } from "@beemax/core";
import { MemoryStore } from "@beemax/memory";

test("security acceptance gate never discloses a private DM claim in a group", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-security-private-group-"));
	const store = new MemoryStore(join(root, "memory.db"), "personal");
	try {
		const privateClaim = store.upsertClaim({
			profileId: "personal", platform: "feishu", chatId: "dm-alice", userId: "alice",
			kind: "fact", statement: "private-release-secret", visibility: "private", confidence: 1, stability: "high",
		});
		const groupHits = store.recall("private-release-secret", {
			profileId: "personal", platform: "feishu", chatId: "group-1", userId: "alice", chatType: "group", limit: 10,
		});
		assert.ok(groupHits.every((hit) => hit.id !== privateClaim.id));
		assert.equal(store.recall("private-release-secret", {
			profileId: "personal", platform: "feishu", chatId: "dm-alice", userId: "alice", chatType: "dm", limit: 10,
		}).some((hit) => hit.id === privateClaim.id), true);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("security acceptance gate never opens one Profile Memory authority as another Profile", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-security-cross-profile-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path, "profile-a");
	try {
		store.upsertClaim({ profileId: "profile-a", platform: "cli", chatId: "local", userId: "owner", kind: "fact", statement: "profile-a-only" });
		store.close();
		assert.throws(() => new MemoryStore(path, "profile-b"), /belongs to Profile 'profile-a'/);
		store = new MemoryStore(path, "profile-a");
		assert.equal(store.recallBrief("profile-a-only", { profileId: "profile-a", platform: "cli", chatId: "local", userId: "owner" }).claims.length, 1);
	} finally { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});

test("security acceptance gate executes one idempotent Effect mutation at most once", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-security-effect-replay-"));
	const path = join(root, "tool-effects.jsonl");
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "operator" };
	const policy = { ...MUTATING_TOOL_POLICY, sideEffect: "local" };
	const first = new FileToolEffectJournal(path);
	const retry = new FileToolEffectJournal(path);
	try {
		first.begin({ source, taskId: "task:first", toolCallId: "call:first", toolName: "write", args: { idempotencyKey: "security:mutation" }, policy });
		first.finish({ source, toolCallId: "call:first", toolName: "write", policy, isError: false, details: { beemaxEffect: { operation: "write durable state" } } });
		assert.throws(() => retry.begin({ source, taskId: "task:retry", toolCallId: "call:retry", toolName: "write", args: { idempotencyKey: "security:mutation" }, policy }), /already committed/i);
		assert.equal(first.events().filter((effect) => effect.status === "committed" && effect.idempotencyKey === "security:mutation").length, 1);
	} finally { first.close(); retry.close(); rmSync(root, { recursive: true, force: true }); }
});

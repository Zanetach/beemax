import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ProfileSessionOwnershipMigration,
	SessionCatalog,
	legacySessionIdsForSource,
	sessionIdForSource,
} from "../dist/index.js";

test("Session Ownership Migration explicitly promotes one legacy group transcript and reverses it", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-session-ownership-"));
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice", threadId: "topic-1" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	const canonicalSessionId = sessionIdForSource(source);
	const sessions = join(agentDir, "sessions");
	const legacyPath = join(sessions, `2026-01-01T00-00-00-000Z_${legacySessionId}.jsonl`);
	try {
		await mkdir(sessions, { recursive: true });
		await writeFile(legacyPath, [
			JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: agentDir }),
			JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "legacy group context" } }),
		].join("\n") + "\n", { mode: 0o600 });
		await writeFile(join(sessions, "beemax-session-index.json"), JSON.stringify([{
			owner: "feishu:group-1:alice", threadId: "topic-1", lastUsedAt: 10, preferences: { reasoningDisplay: "summary" },
		}]));

		const migration = new ProfileSessionOwnershipMigration(agentDir);
		const plan = await migration.plan(source, legacySessionId);
		assert.equal(plan.canonicalSessionId, canonicalSessionId);
		assert.equal(plan.selected?.sessionId, legacySessionId);
		assert.deepEqual(plan.blockers, []);

		const prepared = await migration.apply({ id: "promote-topic", source, legacySessionId }, () => undefined);
		assert.equal(prepared.result.targetPath.endsWith(`_${canonicalSessionId}.jsonl`), true);
		assert.equal((await readFile(prepared.result.targetPath, "utf8")).includes("legacy group context"), true);
		assert.equal(JSON.parse((await readFile(prepared.result.targetPath, "utf8")).split("\n")[0]).id, canonicalSessionId);
		assert.equal((await readFile(legacyPath, "utf8")).includes("legacy group context"), true);
		assert.equal(await SessionCatalog.forAgentDir(agentDir).has({ ...source, userId: "bob" }), true);
		assert.deepEqual(await SessionCatalog.forAgentDir(agentDir).preferences({ ...source, userId: "bob" }), { reasoningDisplay: "summary" });

		await migration.rollback(prepared.result);
		await migration.rollback(prepared.result);
		await assert.rejects(readFile(prepared.result.targetPath, "utf8"), /ENOENT/);
		assert.equal((await readFile(legacyPath, "utf8")).includes("legacy group context"), true);
		assert.equal(await SessionCatalog.forAgentDir(agentDir).has({ ...source, userId: "bob" }), false);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Session Ownership Migration refuses rollback after the canonical transcript receives new work", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-session-ownership-new-work-"));
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	const sessions = join(agentDir, "sessions");
	const legacyPath = join(sessions, `legacy_${legacySessionId}.jsonl`);
	try {
		await mkdir(sessions, { recursive: true });
		await writeFile(legacyPath, `${JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: agentDir })}\n`, { mode: 0o600 });
		const migration = new ProfileSessionOwnershipMigration(agentDir);
		const prepared = await migration.apply({ id: "protect-new-work", source, legacySessionId }, () => undefined);
		await appendFile(prepared.result.targetPath, `${JSON.stringify({ type: "message", id: "new", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "new work" } })}\n`);
		await assert.rejects(migration.rollback(prepared.result), /Canonical Session changed/i);
		assert.equal((await readFile(prepared.result.targetPath, "utf8")).includes("new work"), true);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Session Ownership Migration refuses to guess between duplicate legacy transcript files", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-session-ownership-ambiguous-"));
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	const sessions = join(agentDir, "sessions");
	const header = `${JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: agentDir })}\n`;
	try {
		await mkdir(sessions, { recursive: true });
		await writeFile(join(sessions, `older_${legacySessionId}.jsonl`), header, { mode: 0o600 });
		await writeFile(join(sessions, `newer_${legacySessionId}.jsonl`), header, { mode: 0o600 });
		const migration = new ProfileSessionOwnershipMigration(agentDir);
		const plan = await migration.plan(source, legacySessionId);
		assert.equal(plan.candidates.length, 2);
		assert.match(plan.blockers.join("\n"), /multiple transcript files|ambiguous/i);
		await assert.rejects(migration.apply({ id: "do-not-guess", source, legacySessionId }, () => undefined), /blocked.*ambiguous/is);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

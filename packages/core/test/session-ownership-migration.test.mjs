import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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

test("Session Ownership Migration recovers when publication completed before the Catalog commit", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-session-ownership-publish-crash-"));
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	const sessions = join(agentDir, "sessions");
	try {
		await mkdir(sessions, { recursive: true });
		await writeFile(join(sessions, `legacy_${legacySessionId}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: agentDir })}\n`);
		await writeFile(join(sessions, "beemax-session-index.json"), JSON.stringify([{ owner: "feishu:group-1:alice", lastUsedAt: 10, preferences: {} }]));
		const migration = new ProfileSessionOwnershipMigration(agentDir);
		const prepared = await migration.apply({ id: "publish-crash", source, legacySessionId }, () => undefined);
		await SessionCatalog.forAgentDir(agentDir).rollbackOwnershipMigration(source, prepared.result.catalogReceipt);

		await new ProfileSessionOwnershipMigration(agentDir).rollback(prepared.result, { allowPreparedCatalog: true });
		await assert.rejects(readFile(prepared.result.targetPath, "utf8"), /ENOENT/);
		assert.equal(await SessionCatalog.forAgentDir(agentDir).has({ ...source, userId: "bob" }), false);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("Session Ownership Migration rejects a sessions symlink outside the Profile", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-session-ownership-symlink-"));
	const outside = await mkdtemp(join(tmpdir(), "beemax-session-ownership-outside-"));
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	const outsidePath = join(outside, `legacy_${legacySessionId}.jsonl`);
	try {
		await writeFile(outsidePath, `${JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: agentDir })}\n`);
		await symlink(outside, join(agentDir, "sessions"), "dir");
		await assert.rejects(new ProfileSessionOwnershipMigration(agentDir).plan(source, legacySessionId), /session directory|symbolic|Profile/i);
		assert.equal((await readFile(outsidePath, "utf8")).includes(legacySessionId), true);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("Session Ownership Migration plan blocks a filename match with an invalid Pi header", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-session-ownership-header-"));
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	try {
		await mkdir(join(agentDir, "sessions"), { recursive: true });
		await writeFile(join(agentDir, "sessions", `corrupt_${legacySessionId}.jsonl`), `${JSON.stringify({ type: "session", id: "wrong", timestamp: "2026-01-01T00:00:00.000Z", cwd: agentDir })}\n`);
		const plan = await new ProfileSessionOwnershipMigration(agentDir).plan(source, legacySessionId);
		assert.equal(plan.selected, undefined);
		assert.match(plan.blockers.join("\n"), /header|invalid|does not match/i);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("Session Ownership Migration refuses rollback when another canonical transcript appeared", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-session-ownership-canonical-race-"));
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	const canonicalSessionId = sessionIdForSource(source);
	try {
		await mkdir(join(agentDir, "sessions"), { recursive: true });
		await writeFile(join(agentDir, "sessions", `legacy_${legacySessionId}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: agentDir })}\n`);
		await writeFile(join(agentDir, "sessions", "beemax-session-index.json"), JSON.stringify([{ owner: "feishu:group-1:alice", lastUsedAt: 10, preferences: {} }]));
		const migration = new ProfileSessionOwnershipMigration(agentDir);
		const prepared = await migration.apply({ id: "canonical-race", source, legacySessionId }, () => undefined);
		await rename(prepared.result.targetPath, `${prepared.result.targetPath}.lost`);
		const newCanonical = join(agentDir, "sessions", `new_${canonicalSessionId}.jsonl`);
		await writeFile(newCanonical, `${JSON.stringify({ type: "session", version: 3, id: canonicalSessionId, timestamp: "2026-01-02T00:00:00.000Z", cwd: agentDir })}\n`);
		await assert.rejects(migration.rollback(prepared.result), /canonical Session already exists|new canonical/i);
		assert.equal(await SessionCatalog.forAgentDir(agentDir).has({ ...source, userId: "bob" }), true);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("Session Ownership Migration never deletes a canonical transcript racing its no-clobber publish", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-session-ownership-publish-race-"));
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	const canonicalSessionId = sessionIdForSource(source);
	const appliedAt = Date.parse("2026-07-14T00:00:00.000Z");
	const targetPath = join(agentDir, "sessions", `2026-07-14T00-00-00-000Z-publish-race_${canonicalSessionId}.jsonl`);
	const competing = `${JSON.stringify({ type: "session", version: 3, id: canonicalSessionId, timestamp: "2026-07-14T00:00:00.000Z", cwd: agentDir })}\ncompeting work\n`;
	try {
		await mkdir(join(agentDir, "sessions"), { recursive: true });
		await writeFile(join(agentDir, "sessions", `legacy_${legacySessionId}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: agentDir })}\n`);
		const migration = new ProfileSessionOwnershipMigration(agentDir);
		await assert.rejects(migration.apply({ id: "publish-race", source, legacySessionId, appliedAt }, async () => {
			await writeFile(targetPath, competing, { flag: "wx" });
		}), /Canonical Session already exists/i);
		assert.equal(await readFile(targetPath, "utf8"), competing);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("Session Ownership Migration refuses an applied rollback after its Catalog record reverted", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-session-ownership-catalog-revert-"));
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	try {
		await mkdir(join(agentDir, "sessions"), { recursive: true });
		await writeFile(join(agentDir, "sessions", `legacy_${legacySessionId}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: agentDir })}\n`);
		await writeFile(join(agentDir, "sessions", "beemax-session-index.json"), JSON.stringify([{ owner: "feishu:group-1:alice", lastUsedAt: 10, preferences: {} }]));
		const migration = new ProfileSessionOwnershipMigration(agentDir);
		const prepared = await migration.apply({ id: "catalog-revert", source, legacySessionId }, () => undefined);
		await SessionCatalog.forAgentDir(agentDir).rollbackOwnershipMigration(source, prepared.result.catalogReceipt);

		await assert.rejects(new ProfileSessionOwnershipMigration(agentDir).rollback(prepared.result), /Session Catalog changed after ownership migration/i);
		assert.equal((await readFile(prepared.result.targetPath, "utf8")).includes(sessionIdForSource(source)), true);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("Session Ownership Migration resumes a crash after no-clobber restoration linked both names", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-session-ownership-restore-crash-"));
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	try {
		await mkdir(join(agentDir, "sessions"), { recursive: true });
		await writeFile(join(agentDir, "sessions", `legacy_${legacySessionId}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: agentDir })}\n`);
		const migration = new ProfileSessionOwnershipMigration(agentDir);
		const prepared = await migration.apply({ id: "restore-crash", source, legacySessionId }, () => undefined);
		const quarantine = `${prepared.result.targetPath}.rollback-${prepared.result.id}`;
		await rename(prepared.result.targetPath, quarantine);
		await link(quarantine, prepared.result.targetPath);

		await migration.rollback(prepared.result, { allowPreparedCatalog: true });
		await assert.rejects(readFile(prepared.result.targetPath, "utf8"), /ENOENT/);
		await assert.rejects(readFile(quarantine, "utf8"), /ENOENT/);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

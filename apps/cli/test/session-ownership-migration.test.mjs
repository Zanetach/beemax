import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { legacySessionIdsForSource } from "@beemax/core";
import {
	applyProfileSessionOwnershipMigration,
	planProfileSessionOwnershipMigration,
	rollbackProfileSessionOwnershipMigration,
} from "../dist/session-ownership-migration.js";

const cli = join(process.cwd(), "apps", "cli", "dist", "cli.js");

test("operator explicitly plans, applies, and rolls back one Profile Session ownership migration", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-session-migration-"));
	const profileHome = join(root, "profiles", "personal");
	const sessions = join(profileHome, "sessions");
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-a", chatType: "group", userId: "alice" };
	const legacySessionId = legacySessionIdsForSource(source)[0];
	const legacyPath = join(sessions, `legacy_${legacySessionId}.jsonl`);
	try {
		await mkdir(sessions, { recursive: true });
		await writeFile(legacyPath, `${JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: profileHome })}\n`, { mode: 0o600 });
		const target = { lockRoot: root, profileHome, agentDir: profileHome, profile: "personal", source };
		const plan = await planProfileSessionOwnershipMigration(target, legacySessionId);
		assert.equal(plan.selected?.sessionId, legacySessionId);
		const applied = await applyProfileSessionOwnershipMigration({ ...target, legacySessionId, migrationId: "group-a-history" });
		assert.equal(applied.status, "applied");
		assert.equal((await readFile(applied.result.targetPath, "utf8")).includes(applied.result.canonicalSessionId), true);
		assert.equal((await readFile(legacyPath, "utf8")).includes(legacySessionId), true);
		const conflicting = await planProfileSessionOwnershipMigration({ ...target, source: { ...source, channelInstanceId: "company-b" } }, legacySessionId);
		assert.match(conflicting.blockers.join("\n"), /already assigned by active migration/i);
		const rolledBack = await rollbackProfileSessionOwnershipMigration({ lockRoot: root, profileHome, agentDir: profileHome, profile: "personal", manifestPath: applied.manifestPath });
		assert.equal(rolledBack.status, "rolled_back");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI requires explicit Session selection and confirmation before apply and rollback", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-session-migration-cli-"));
	const run = (...args) => execFileSync(process.execPath, [cli, ...args, "--profile", "personal"], { encoding: "utf8", env: { ...process.env, BEEMAX_HOME: home } });
	try {
		run("init");
		const profileHome = join(home, "profiles", "personal");
		const configPath = join(profileHome, "config.yaml");
		await writeFile(configPath, (await readFile(configPath, "utf8")).replace("channels: []", `channels:\n    - id: company-a\n      adapter: feishu\n      enabled: true\n      credentialRef: profile-env:feishu\n      settings: {}`));
		const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-a", chatType: "group", userId: "alice" };
		const legacySessionId = legacySessionIdsForSource(source)[0];
		const sessions = join(profileHome, "sessions");
		await mkdir(sessions, { recursive: true });
		await writeFile(join(sessions, `legacy_${legacySessionId}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: legacySessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: profileHome })}\n`, { mode: 0o600 });
		const common = ["--platform", "feishu", "--channel-instance", "company-a", "--chat-id", "group-a", "--legacy-user", "alice"];
		assert.match(run("migration", "session", "plan", ...common), new RegExp(legacySessionId));
		assert.throws(() => run("migration", "session", "apply", ...common, "--legacy-session-id", legacySessionId, "--migration-id", "session-cli"), /requires --yes/i);
		assert.match(run("migration", "session", "apply", ...common, "--legacy-session-id", legacySessionId, "--migration-id", "session-cli", "--yes"), /Migrated legacy Session/i);
		const manifest = join(profileHome, "migrations", "session-ownership", "session-cli.json");
		assert.throws(() => run("migration", "session", "rollback", manifest), /requires --yes/i);
		assert.match(run("migration", "session", "rollback", manifest, "--yes"), /Rolled back Session ownership migration/i);
	} finally { await rm(home, { recursive: true, force: true }); }
});

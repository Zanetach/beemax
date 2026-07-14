import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	applyProfileChannelInstanceMigration,
	planProfileChannelInstanceMigration,
	rollbackProfileChannelInstanceMigration,
} from "../dist/channel-instance-migration.js";

const cli = join(process.cwd(), "apps", "cli", "dist", "cli.js");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-instance-migration-"));
	const profileHome = join(root, "profiles", "personal");
	const dbPath = join(profileHome, "data", "memory.db");
	mkdirSync(join(profileHome, "data"), { recursive: true });
	const db = new Database(dbPath);
	db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, platform TEXT NOT NULL); INSERT INTO memories VALUES ('legacy', 'feishu')");
	db.close();
	return { root, profileHome, dbPath };
}

test("operator migration plans, snapshots, audits, and safely rolls back Profile data", async () => {
	const { root, profileHome, dbPath } = fixture();
	try {
		const planned = await planProfileChannelInstanceMigration({ lockRoot: root, profile: "personal", dbPath, platform: "feishu", channelInstanceId: "company-a" });
		assert.equal(planned.totalRows, 1);

		const applied = await applyProfileChannelInstanceMigration({
			lockRoot: root, profileHome, profile: "personal", dbPath,
			platform: "feishu", channelInstanceId: "company-a", migrationId: "assign-company-a",
		});
		assert.equal(new Database(dbPath, { readonly: true }).prepare("SELECT platform FROM memories").pluck().get(), "feishu@company-a");
		const manifest = JSON.parse(await readFile(applied.manifestPath, "utf8"));
		assert.equal(manifest.status, "applied");
		assert.equal(manifest.preMigrationDigest.length, 64);
		assert.equal(manifest.postMigrationDigest.length, 64);
		assert.equal(new Database(manifest.backupPath, { readonly: true }).prepare("SELECT platform FROM memories").pluck().get(), "feishu");

		const rolledBack = await rollbackProfileChannelInstanceMigration({ lockRoot: root, profile: "personal", manifestPath: applied.manifestPath });
		assert.equal(rolledBack.status, "rolled_back");
		assert.equal(new Database(dbPath, { readonly: true }).prepare("SELECT platform FROM memories").pluck().get(), "feishu");
		assert.equal(JSON.parse(await readFile(applied.manifestPath, "utf8")).status, "rolled_back");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator rollback refuses to erase writes made after migration", async () => {
	const { root, profileHome, dbPath } = fixture();
	try {
		const applied = await applyProfileChannelInstanceMigration({
			lockRoot: root, profileHome, profile: "personal", dbPath,
			platform: "feishu", channelInstanceId: "company-a", migrationId: "guard-new-writes",
		});
		const changed = new Database(dbPath);
		changed.prepare("INSERT INTO memories VALUES ('new-write', 'feishu@company-a')").run();
		changed.close();
		await assert.rejects(
			rollbackProfileChannelInstanceMigration({ lockRoot: root, profile: "personal", manifestPath: applied.manifestPath }),
			/database changed after migration/i,
		);
		const check = new Database(dbPath, { readonly: true });
		try { assert.equal(check.prepare("SELECT COUNT(*) FROM memories").pluck().get(), 2); }
		finally { check.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI exposes explicit plan, confirmed apply, and confirmed rollback", () => {
	const home = mkdtempSync(join(tmpdir(), "beemax-instance-migration-cli-"));
	const run = (...args) => execFileSync(process.execPath, [cli, ...args, "--profile", "personal"], {
		encoding: "utf8", env: { ...process.env, BEEMAX_HOME: home },
	});
	try {
		run("init");
		const dbPath = join(home, "profiles", "personal", "memory.db");
		const db = new Database(dbPath);
		db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, platform TEXT NOT NULL); INSERT INTO memories VALUES ('legacy', 'feishu')");
		db.close();
		assert.match(run("migration", "channel-instance", "plan", "--platform", "feishu", "--channel-instance", "company-a"), /1 legacy row.*memories/is);
		assert.throws(() => run("migration", "channel-instance", "apply", "--platform", "feishu", "--channel-instance", "company-a", "--migration-id", "cli-assign"), /requires --yes/i);
		assert.match(
			run("migration", "channel-instance", "apply", "--platform", "feishu", "--channel-instance", "company-a", "--migration-id", "cli-assign", "--yes"),
			/migrated 1 legacy row.*cli-assign/is,
		);
		const manifestPath = join(home, "profiles", "personal", "migrations", "channel-instance", "cli-assign.json");
		assert.match(run("migration", "channel-instance", "rollback", manifestPath, "--yes"), /rolled back.*cli-assign/i);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

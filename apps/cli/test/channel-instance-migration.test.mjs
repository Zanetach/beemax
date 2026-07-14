import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function scalar(path, sql) {
	const db = new Database(path, { readonly: true });
	try { return db.prepare(sql).pluck().get(); }
	finally { db.close(); }
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
		assert.equal(scalar(dbPath, "SELECT platform FROM memories"), "feishu@company-a");
		const manifest = JSON.parse(await readFile(applied.manifestPath, "utf8"));
		assert.equal(manifest.status, "applied");
		assert.equal(manifest.preMigrationDigest.length, 64);
		assert.equal(manifest.postMigrationDigest.length, 64);
		assert.equal(scalar(manifest.backupPath, "SELECT platform FROM memories"), "feishu");

		const rolledBack = await rollbackProfileChannelInstanceMigration({ lockRoot: root, profileHome, profile: "personal", dbPath, manifestPath: applied.manifestPath });
		assert.equal(rolledBack.status, "rolled_back");
		assert.equal(scalar(dbPath, "SELECT platform FROM memories"), "feishu");
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
			rollbackProfileChannelInstanceMigration({ lockRoot: root, profileHome, profile: "personal", dbPath, manifestPath: applied.manifestPath }),
			/database changed after migration/i,
		);
		const check = new Database(dbPath, { readonly: true });
		try { assert.equal(check.prepare("SELECT COUNT(*) FROM memories").pluck().get(), 2); }
		finally { check.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator rollback derives database and backup paths from the selected Profile", async () => {
	const { root, profileHome, dbPath } = fixture();
	try {
		const applied = await applyProfileChannelInstanceMigration({
			lockRoot: root, profileHome, profile: "personal", dbPath,
			platform: "feishu", channelInstanceId: "company-a", migrationId: "reject-crafted-path",
		});
		const victim = join(root, "victim.db");
		copyFileSync(dbPath, victim);
		const crafted = JSON.parse(readFileSync(applied.manifestPath, "utf8"));
		crafted.dbPath = victim;
		writeFileSync(applied.manifestPath, JSON.stringify(crafted));
		await assert.rejects(
			rollbackProfileChannelInstanceMigration({ lockRoot: root, profileHome, profile: "personal", dbPath, manifestPath: applied.manifestPath }),
			/path|selected Profile|configured database/i,
		);
		const check = new Database(victim, { readonly: true });
		try { assert.equal(check.prepare("SELECT platform FROM memories WHERE id='legacy'").pluck().get(), "feishu@company-a"); }
		finally { check.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator rollback resumes prepared and post-restore crash states idempotently", async () => {
	const { root, profileHome, dbPath } = fixture();
	try {
		const applied = await applyProfileChannelInstanceMigration({
			lockRoot: root, profileHome, profile: "personal", dbPath,
			platform: "feishu", channelInstanceId: "company-a", migrationId: "resume-rollback",
		});
		const prepared = JSON.parse(readFileSync(applied.manifestPath, "utf8"));
		prepared.status = "prepared";
		writeFileSync(applied.manifestPath, JSON.stringify(prepared));
		const rolledBack = await rollbackProfileChannelInstanceMigration({ lockRoot: root, profileHome, profile: "personal", dbPath, manifestPath: applied.manifestPath });
		assert.equal(rolledBack.status, "rolled_back");
		assert.equal(scalar(dbPath, "SELECT platform FROM memories"), "feishu");

		const interrupted = JSON.parse(readFileSync(applied.manifestPath, "utf8"));
		interrupted.status = "rollback_prepared";
		delete interrupted.rolledBackAt;
		writeFileSync(applied.manifestPath, JSON.stringify(interrupted));
		const finalized = await rollbackProfileChannelInstanceMigration({ lockRoot: root, profileHome, profile: "personal", dbPath, manifestPath: applied.manifestPath });
		assert.equal(finalized.status, "rolled_back");
		assert.equal(scalar(dbPath, "SELECT platform FROM memories"), "feishu");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator migration rejects a dangling backup symlink instead of escaping the Profile", async () => {
	const { root, profileHome, dbPath } = fixture();
	const directory = join(profileHome, "migrations", "channel-instance");
	mkdirSync(directory, { recursive: true });
	const outside = join(root, "outside-created.db");
	symlinkSync(outside, join(directory, "dangling.before.db"));
	try {
		await assert.rejects(
			applyProfileChannelInstanceMigration({
				lockRoot: root, profileHome, profile: "personal", dbPath,
				platform: "feishu", channelInstanceId: "company-a", migrationId: "dangling",
			}),
			/artifact already exists|symbolic link/i,
		);
		assert.equal(existsSync(outside), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI exposes explicit plan, confirmed apply, and confirmed rollback", () => {
	const home = mkdtempSync(join(tmpdir(), "beemax-instance-migration-cli-"));
	const run = (...args) => execFileSync(process.execPath, [cli, ...args, "--profile", "personal"], {
		encoding: "utf8", env: { ...process.env, BEEMAX_HOME: home },
	});
	try {
		run("init");
		const configPath = join(home, "profiles", "personal", "config.yaml");
		writeFileSync(configPath, readFileSync(configPath, "utf8").replace("channels: []", `channels:\n    - id: company-a\n      adapter: feishu\n      enabled: true\n      credentialRef: profile-env:feishu\n      settings: {}`));
		const dbPath = join(home, "profiles", "personal", "memory.db");
		const db = new Database(dbPath);
		db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, platform TEXT NOT NULL); INSERT INTO memories VALUES ('legacy', 'feishu')");
		db.close();
		assert.match(run("migration", "channel-instance", "plan", "--platform", "feishu", "--channel-instance", "company-a"), /1 legacy row.*memories/is);
		assert.throws(() => run("migration", "channel-instance", "plan", "--platform", "feishu", "--channel-instance", "typo"), /configured.*Channel Instance|does not belong/i);
		assert.throws(() => run("migration", "channel-instance", "apply", "--platform", "feishu", "--channel-instance", "company-a", "--migration-id", "cli-assign"), /requires --yes/i);
		assert.match(
			run("migration", "channel-instance", "apply", "--platform", "feishu", "--channel-instance", "company-a", "--migration-id", "cli-assign", "--yes"),
			/migrated 1 legacy row.*cli-assign/is,
		);
		const manifestPath = join(home, "profiles", "personal", "migrations", "channel-instance", "cli-assign.json");
		assert.match(run("migration", "channel-instance", "rollback", manifestPath, "--yes"), /rolled back.*cli-assign/i);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

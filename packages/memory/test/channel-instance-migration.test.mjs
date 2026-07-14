import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { digestSqliteDatabase, ProfileChannelInstanceMigration } from "../dist/index.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "beemax-channel-migration-"));
	const path = join(root, "profile.db");
	const db = new Database(path);
	db.exec(`
		CREATE TABLE memories (id TEXT PRIMARY KEY, platform TEXT NOT NULL, chat_id TEXT NOT NULL);
		CREATE TABLE automation_jobs (id TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_instance_id TEXT, chat_id TEXT NOT NULL);
		CREATE TABLE automation_routes (platform TEXT NOT NULL, channel_instance_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL, chat_id TEXT NOT NULL, PRIMARY KEY(platform, channel_instance_id, user_id));
		CREATE TABLE customer_extension (id TEXT PRIMARY KEY, platform TEXT NOT NULL);
		CREATE TABLE unrelated (id TEXT PRIMARY KEY, value TEXT NOT NULL);
		INSERT INTO memories VALUES ('legacy-memory', 'feishu', 'chat-a'), ('other-memory', 'telegram', 'chat-a'), ('owned-memory', 'feishu@company-a', 'chat-a');
		INSERT INTO automation_jobs VALUES ('legacy-job', 'feishu', NULL, 'chat-a'), ('owned-job', 'feishu', 'company-b', 'chat-a');
		INSERT INTO automation_routes VALUES ('feishu', '', 'user-a', 'chat-a');
		INSERT INTO customer_extension VALUES ('customer-row', 'feishu');
		INSERT INTO unrelated VALUES ('keep', 'unchanged');
	`);
	db.close();
	return { root, path };
}

test("Profile Channel Instance migration plans and atomically assigns only legacy route data", () => {
	const { root, path } = fixture();
	const migration = new ProfileChannelInstanceMigration(path);
	try {
		const plan = migration.plan("feishu", "company-a");
		assert.equal(plan.totalRows, 3);
		assert.deepEqual(plan.tables, [
			{ table: "automation_jobs", storage: "channel_instance_column", rows: 1 },
			{ table: "automation_routes", storage: "channel_instance_column", rows: 1 },
			{ table: "memories", storage: "encoded_platform", rows: 1 },
		]);
		assert.deepEqual(plan.blockers, []);

		const applied = migration.apply({
			id: "migration-1", platform: "feishu", channelInstanceId: "company-a", backupRef: "backup:profile-before-migration",
		});
		assert.equal(applied.totalRows, 3);
		const db = new Database(path, { readonly: true });
		try {
			assert.deepEqual(db.prepare("SELECT id, platform FROM memories ORDER BY id").all(), [
				{ id: "legacy-memory", platform: "feishu@company-a" },
				{ id: "other-memory", platform: "telegram" },
				{ id: "owned-memory", platform: "feishu@company-a" },
			]);
			assert.equal(db.prepare("SELECT channel_instance_id FROM automation_jobs WHERE id='legacy-job'").pluck().get(), "company-a");
			assert.equal(db.prepare("SELECT channel_instance_id FROM automation_jobs WHERE id='owned-job'").pluck().get(), "company-b");
			assert.equal(db.prepare("SELECT channel_instance_id FROM automation_routes WHERE user_id='user-a'").pluck().get(), "company-a");
			assert.equal(db.prepare("SELECT value FROM unrelated WHERE id='keep'").pluck().get(), "unchanged");
			assert.equal(db.prepare("SELECT platform FROM customer_extension WHERE id='customer-row'").pluck().get(), "feishu");
			assert.equal(db.prepare("SELECT backup_ref FROM channel_instance_migrations WHERE id='migration-1'").pluck().get(), "backup:profile-before-migration");
		} finally { db.close(); }
		assert.equal(migration.plan("feishu", "company-a").totalRows, 0);
	} finally {
		migration.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Profile Channel Instance migration snapshots both sides while its SQLite write fence is held", async () => {
	const { root, path } = fixture();
	const backupPath = join(root, "before.db");
	const migration = new ProfileChannelInstanceMigration(path);
	const competingWriter = new Database(path);
	competingWriter.pragma("busy_timeout = 1");
	try {
		const applied = await migration.applyWithBackup({
			id: "migration-fenced", platform: "feishu", channelInstanceId: "company-a", backupRef: backupPath,
		}, backupPath, async (prepared) => {
			assert.notEqual(prepared.preMigrationDigest, prepared.postMigrationDigest);
			assert.throws(() => competingWriter.prepare("INSERT INTO memories VALUES ('concurrent', 'feishu', 'chat-a')").run(), /locked|busy/i);
		});
		assert.equal(applied.result.totalRows, 3);
		const backup = new Database(backupPath, { readonly: true });
		try { assert.equal(backup.prepare("SELECT platform FROM memories WHERE id='legacy-memory'").pluck().get(), "feishu"); }
		finally { backup.close(); }
	} finally {
		competingWriter.close();
		migration.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Profile Channel Instance migration rolls back when the prepared recovery manifest cannot be persisted", async () => {
	const { root, path } = fixture();
	const backupPath = join(root, "before-failed.db");
	const migration = new ProfileChannelInstanceMigration(path);
	try {
		await assert.rejects(
			migration.applyWithBackup({ id: "migration-prepare-failed", platform: "feishu", channelInstanceId: "company-a", backupRef: backupPath }, backupPath, async () => { throw new Error("manifest unavailable"); }),
			/manifest unavailable/,
		);
		const check = new Database(path, { readonly: true });
		try {
			assert.equal(check.prepare("SELECT platform FROM memories WHERE id='legacy-memory'").pluck().get(), "feishu");
			assert.equal(check.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='channel_instance_migrations'").pluck().get(), 0);
		} finally { check.close(); }
	} finally {
		migration.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Profile Channel Instance migration reports target collisions and rolls back every table", () => {
	const { root, path } = fixture();
	const db = new Database(path);
	db.prepare("INSERT INTO automation_routes VALUES ('feishu', 'company-a', 'user-a', 'target-chat')").run();
	db.close();
	const migration = new ProfileChannelInstanceMigration(path);
	try {
		const plan = migration.plan("feishu", "company-a");
		assert.match(plan.blockers.join("\n"), /automation_routes.*user-a.*already exists/i);
		assert.throws(() => migration.apply({ id: "migration-conflict", platform: "feishu", channelInstanceId: "company-a", backupRef: "backup:before" }), /blocked/i);
		const check = new Database(path, { readonly: true });
		try {
			assert.equal(check.prepare("SELECT platform FROM memories WHERE id='legacy-memory'").pluck().get(), "feishu");
			assert.equal(check.prepare("SELECT channel_instance_id FROM automation_jobs WHERE id='legacy-job'").pluck().get(), null);
			assert.equal(check.prepare("SELECT channel_instance_id FROM automation_routes WHERE user_id='user-a' ORDER BY channel_instance_id").pluck().all()[0], "");
		} finally { check.close(); }
	} finally {
		migration.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Profile Channel Instance migration preserves structured scope and nested trigger routes", () => {
	const { root, path } = fixture();
	const db = new Database(path);
	db.exec(`
		CREATE TABLE memory_convention_candidates (
			id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, platform TEXT NOT NULL,
			chat_id TEXT NOT NULL, user_id TEXT, thread_id TEXT, scope_key TEXT NOT NULL,
			canonical_statement TEXT NOT NULL,
			UNIQUE(profile_id, scope_key, canonical_statement)
		);
		CREATE TABLE initiative_triggers (
			id TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_instance_id TEXT,
			delivery_target TEXT, execution_scope TEXT
		);
		INSERT INTO memory_convention_candidates VALUES (
			'convention-a', 'personal', 'feishu', 'chat-a', 'user-a', NULL,
			json_array('feishu', 'chat-a', 'user-a', NULL), 'send a summary'
		);
		INSERT INTO initiative_triggers VALUES (
			'trigger-a', 'feishu', NULL,
			json_object('platform', 'feishu', 'chatId', 'chat-a'),
			json_object('platform', 'feishu', 'chatId', 'chat-a')
		);
	`);
	db.close();
	const migration = new ProfileChannelInstanceMigration(path);
	try {
		migration.apply({ id: "migration-structured", platform: "feishu", channelInstanceId: "company-a", backupRef: "backup:structured" });
		const check = new Database(path, { readonly: true });
		try {
			const convention = check.prepare("SELECT platform, scope_key FROM memory_convention_candidates WHERE id='convention-a'").get();
			assert.equal(convention.platform, "feishu@company-a");
			assert.deepEqual(JSON.parse(convention.scope_key), ["feishu@company-a", "chat-a", "user-a", null]);
			const trigger = check.prepare("SELECT channel_instance_id, delivery_target, execution_scope FROM initiative_triggers WHERE id='trigger-a'").get();
			assert.equal(trigger.channel_instance_id, "company-a");
			assert.equal(JSON.parse(trigger.delivery_target).channelInstanceId, "company-a");
			assert.equal(JSON.parse(trigger.execution_scope).channelInstanceId, "company-a");
		} finally { check.close(); }
	} finally {
		migration.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Profile Channel Instance migration plans structured scope collisions before apply", () => {
	const { root, path } = fixture();
	const db = new Database(path);
	db.exec(`
		CREATE TABLE memory_workflow_candidates (
			id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, platform TEXT NOT NULL,
			chat_id TEXT NOT NULL, user_id TEXT, thread_id TEXT, scope_key TEXT NOT NULL,
			canonical_title TEXT NOT NULL,
			UNIQUE(profile_id, scope_key, canonical_title)
		);
		INSERT INTO memory_workflow_candidates VALUES
			('legacy-flow', 'personal', 'feishu', 'chat-a', 'user-a', NULL, json_array('feishu', 'chat-a', 'user-a', NULL), 'daily brief'),
			('owned-flow', 'personal', 'feishu@company-a', 'chat-a', 'user-a', NULL, json_array('feishu@company-a', 'chat-a', 'user-a', NULL), 'daily brief');
	`);
	db.close();
	const migration = new ProfileChannelInstanceMigration(path);
	try {
		const plan = migration.plan("feishu", "company-a");
		assert.match(plan.blockers.join("\n"), /memory_workflow_candidates.*daily brief.*already exists/i);
		assert.throws(() => migration.apply({ id: "migration-scope-conflict", platform: "feishu", channelInstanceId: "company-a", backupRef: "backup:scope" }), /blocked/i);
		const check = new Database(path, { readonly: true });
		try { assert.equal(check.prepare("SELECT platform FROM memory_workflow_candidates WHERE id='legacy-flow'").pluck().get(), "feishu"); }
		finally { check.close(); }
	} finally {
		migration.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Profile Channel Instance migration blocks malformed nested trigger ownership", () => {
	const { root, path } = fixture();
	const db = new Database(path);
	db.exec(`
		CREATE TABLE initiative_triggers (
			id TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_instance_id TEXT,
			delivery_target TEXT, execution_scope TEXT
		);
		INSERT INTO initiative_triggers VALUES ('trigger-invalid', 'feishu', NULL, '[]', '{broken');
	`);
	db.close();
	const migration = new ProfileChannelInstanceMigration(path);
	try {
		const plan = migration.plan("feishu", "company-a");
		assert.match(plan.blockers.join("\n"), /delivery_target.*invalid or non-object|invalid or non-object.*delivery_target/i);
		assert.match(plan.blockers.join("\n"), /execution_scope.*invalid or non-object|invalid or non-object.*execution_scope/i);
		assert.throws(() => migration.apply({ id: "migration-invalid-json", platform: "feishu", channelInstanceId: "company-a", backupRef: "backup:invalid" }), /blocked/i);
	} finally {
		migration.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("logical SQLite digest distinguishes adjacent 64-bit integers exactly", () => {
	const { root, path } = fixture();
	const db = new Database(path);
	try { db.exec("CREATE TABLE exact_integers (value INTEGER NOT NULL); INSERT INTO exact_integers VALUES (9007199254740992)"); }
	finally { db.close(); }
	const before = digestSqliteDatabase(path);
	const changed = new Database(path);
	try { changed.exec("UPDATE exact_integers SET value = 9007199254740993"); }
	finally { changed.close(); }
	try { assert.notEqual(digestSqliteDatabase(path), before); }
	finally { rmSync(root, { recursive: true, force: true }); }
});

test("logical SQLite digest distinguishes adjacent IEEE-754 real values exactly", () => {
	const { root, path } = fixture();
	const db = new Database(path);
	try { db.exec("CREATE TABLE exact_reals (value REAL NOT NULL); INSERT INTO exact_reals VALUES (1.0)"); }
	finally { db.close(); }
	const before = digestSqliteDatabase(path);
	const changed = new Database(path);
	try { changed.prepare("UPDATE exact_reals SET value = ?").run(1.0000000000000002); }
	finally { changed.close(); }
	try { assert.notEqual(digestSqliteDatabase(path), before); }
	finally { rmSync(root, { recursive: true, force: true }); }
});

test("Profile Channel Instance migration restores from its verified snapshot in place under WAL", async () => {
	const { root, path } = fixture();
	const beforePath = join(root, "receipt-before.db");
	const migration = new ProfileChannelInstanceMigration(path);
	const configured = new Database(path);
	try {
		configured.pragma("journal_mode = WAL");
		configured.exec(`
			CREATE TABLE channel_instance_migrations (
				id TEXT PRIMARY KEY, base_platform TEXT NOT NULL, channel_instance_id TEXT NOT NULL,
				backup_ref TEXT NOT NULL, row_counts_json TEXT NOT NULL, total_rows INTEGER NOT NULL, applied_at INTEGER NOT NULL
			);
			INSERT INTO channel_instance_migrations VALUES ('older', 'telegram', 'bot-a', 'older.db', '[]', 0, 1);
		`);
	} finally { configured.close(); }
	try {
		const prepared = await migration.applyWithBackup({
			id: "migration-receipt-rollback", platform: "feishu", channelInstanceId: "company-a", backupRef: beforePath,
		}, beforePath, () => undefined);
		migration.rollbackFromBackup(prepared.result, beforePath, prepared.postMigrationDigest, prepared.preMigrationDigest);
		assert.equal(scalar(path, "SELECT platform FROM memories WHERE id='legacy-memory'"), "feishu");
		assert.equal(scalar(path, "SELECT channel_instance_id FROM automation_jobs WHERE id='legacy-job'"), null);
		assert.equal(scalar(path, "SELECT channel_instance_id FROM automation_routes WHERE user_id='user-a'"), "");
		assert.equal(scalar(path, "SELECT COUNT(*) FROM channel_instance_migrations WHERE id='older'"), 1);
		assert.equal(digestSqliteDatabase(path), prepared.preMigrationDigest);
	} finally {
		migration.close();
		rmSync(root, { recursive: true, force: true });
	}
});

function scalar(path, sql) {
	const db = new Database(path, { readonly: true });
	try { return db.prepare(sql).pluck().get(); }
	finally { db.close(); }
}

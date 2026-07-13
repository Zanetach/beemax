#!/usr/bin/env node
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateProfile } from "../apps/cli/dist/profile-config.js";
import { backupSqliteDatabase, MemoryStore, verifySqliteDatabase } from "../packages/memory/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "beemax-p0-p10-root-"));
const home = await mkdtemp(join(tmpdir(), "beemax-p0-p10-home-"));
const failures = [];
const rehearsal = {
	legacySourcePreserved: false,
	legacyTaskMigrated: false,
	backupIntegrityVerified: false,
	preBackupResponsibilityRestored: false,
	postBackupWriteExcluded: false,
	rollbackDatabaseReopened: false,
};

try {
	const profile = "rehearsal";
	const legacyConfig = join(root, "config", "profiles", `${profile}.yaml`);
	const legacyData = join(root, "data", "profiles", profile);
	const legacyDb = join(legacyData, "memory.db");
	const preUpgradeBackup = join(home, "pre-upgrade-backup.db");
	await mkdir(join(root, "config", "profiles"), { recursive: true });
	await mkdir(legacyData, { recursive: true });
	await writeFile(legacyConfig, [
		"agent:",
		"  systemPrompt: Rehearsal identity.",
		"memory:",
		"  dbPath: data/profiles/rehearsal/memory.db",
		"paths:",
		"  agentDir: data/profiles/rehearsal/agent",
		"  cwd: .",
	].join("\n"));

	withDatabase(legacyDb, undefined, (legacy) => {
		legacy.exec("CREATE TABLE task_ledger (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT, completed_at INTEGER, updated_at INTEGER NOT NULL)");
		legacy.prepare("INSERT INTO task_ledger VALUES (?, ?, ?, ?, ?, ?)").run("legacy-responsibility", "Preserve accepted responsibility", "done", "legacy:evidence", 120, 110);
	});
	const sourceConfig = await readFile(legacyConfig, "utf8");
	const sourceDatabaseDigest = digest(await readFile(legacyDb));
	await backupSqliteDatabase(legacyDb, preUpgradeBackup);
	verifySqliteDatabase(preUpgradeBackup);
	rehearsal.backupIntegrityVerified = true;

	const migrated = await migrateProfile(profile, { root, home });
	verifySqliteDatabase(legacyDb);
	const sourceRowPreserved = withDatabase(legacyDb, { readonly: true, fileMustExist: true }, (source) => {
		const row = source.prepare("SELECT id, status, evidence FROM task_ledger WHERE id = ?").get("legacy-responsibility");
		return JSON.stringify(row) === JSON.stringify({ id: "legacy-responsibility", status: "done", evidence: "legacy:evidence" });
	});
	rehearsal.legacySourcePreserved = await readFile(legacyConfig, "utf8") === sourceConfig
		&& digest(await readFile(legacyDb)) === sourceDatabaseDigest
		&& sourceRowPreserved;

	withMemoryStore(join(migrated.homePath, "memory.db"), profile, (migratedStore) => {
		const migratedTasks = migratedStore.queryTasks({ ownerKeys: ["profile"] });
		rehearsal.legacyTaskMigrated = migratedTasks.some((task) => task.id === "legacy-responsibility" && task.status === "succeeded");
		migratedStore.upsertTask({ id: "post-backup-write", title: "Must disappear after rollback", status: "open" });
	});

	const rollback = join(home, "rollback.db");
	await copyFile(preUpgradeBackup, rollback);
	verifySqliteDatabase(rollback);
	withMemoryStore(rollback, profile, (restored) => {
		const restoredTasks = restored.queryTasks({ ownerKeys: ["profile"] });
		rehearsal.preBackupResponsibilityRestored = restoredTasks.some((task) => task.id === "legacy-responsibility" && task.status === "succeeded");
		rehearsal.postBackupWriteExcluded = !restoredTasks.some((task) => task.id === "post-backup-write");
	});
	withMemoryStore(rollback, profile, (reopened) => {
		rehearsal.rollbackDatabaseReopened = reopened.queryTasks({ ownerKeys: ["profile"] }).some((task) => task.id === "legacy-responsibility");
	});
} catch (error) {
	failures.push(error instanceof Error ? error.message : String(error));
} finally {
	await Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]);
}

for (const [name, passed] of Object.entries(rehearsal)) if (!passed) failures.push(`${name} did not pass`);
console.log(JSON.stringify({ schemaVersion: 1, rehearsal, gate: { passed: failures.length === 0, failures } }, null, 2));
if (failures.length) process.exitCode = 1;

function withDatabase(path, options, work) {
	const database = new Database(path, options);
	try { return work(database); }
	finally { database.close(); }
}

function withMemoryStore(path, profile, work) {
	const store = new MemoryStore(path, profile);
	try { return work(store); }
	finally { store.close(); }
}

function digest(content) { return createHash("sha256").update(content).digest("hex"); }

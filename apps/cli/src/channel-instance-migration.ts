import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	backupSqliteDatabase,
	ProfileChannelInstanceMigration,
	verifySqliteDatabase,
	type AppliedChannelInstanceMigration,
	type ChannelInstanceMigrationPlan,
} from "@beemax/memory";
import { acquireChannelLock } from "./channel-lock.ts";

export interface ProfileChannelInstanceMigrationTarget {
	lockRoot: string;
	profile: string;
	dbPath: string;
	platform: string;
	channelInstanceId: string;
}

export interface ApplyProfileChannelInstanceMigrationInput extends ProfileChannelInstanceMigrationTarget {
	profileHome: string;
	migrationId?: string;
}

export interface ProfileChannelInstanceMigrationManifest {
	version: 1;
	status: "applied" | "rolled_back";
	migrationId: string;
	profile: string;
	dbPath: string;
	backupPath: string;
	postMigrationBackupPath?: string;
	platform: string;
	channelInstanceId: string;
	preMigrationDigest: string;
	postMigrationDigest: string;
	appliedAt: number;
	rolledBackAt?: number;
	result: AppliedChannelInstanceMigration;
}

export interface AppliedProfileChannelInstanceMigration extends ProfileChannelInstanceMigrationManifest {
	manifestPath: string;
}

export interface RollbackProfileChannelInstanceMigrationInput {
	lockRoot: string;
	profile: string;
	manifestPath: string;
}

export async function planProfileChannelInstanceMigration(input: ProfileChannelInstanceMigrationTarget): Promise<ChannelInstanceMigrationPlan> {
	return withProfileOffline(input.lockRoot, input.profile, () => {
		const migration = new ProfileChannelInstanceMigration(input.dbPath);
		try { return migration.plan(input.platform, input.channelInstanceId); }
		finally { migration.close(); }
	});
}

export async function applyProfileChannelInstanceMigration(input: ApplyProfileChannelInstanceMigrationInput): Promise<AppliedProfileChannelInstanceMigration> {
	return withProfileOffline(input.lockRoot, input.profile, async () => {
		const migrationId = migrationFileId(input.migrationId ?? `channel-instance-${Date.now()}-${randomUUID()}`);
		const directory = join(resolve(input.profileHome), "migrations", "channel-instance");
		const backupPath = join(directory, `${migrationId}.before.db`);
		const manifestPath = join(directory, `${migrationId}.json`);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await assertAbsent(backupPath);
		await assertAbsent(manifestPath);

		let databaseChanged = false;
		try {
			await backupSqliteDatabase(input.dbPath, backupPath);
			verifySqliteDatabase(backupPath);
			const preMigrationDigest = await sha256File(backupPath);
			const migration = new ProfileChannelInstanceMigration(input.dbPath);
			let result: AppliedChannelInstanceMigration;
			try {
				result = migration.apply({
					id: migrationId,
					platform: input.platform,
					channelInstanceId: input.channelInstanceId,
					backupRef: backupPath,
				});
			} finally { migration.close(); }
			databaseChanged = true;
			const postMigrationDigest = await digestSqliteSnapshot(input.dbPath, directory);
			const manifest: ProfileChannelInstanceMigrationManifest = {
				version: 1,
				status: "applied",
				migrationId,
				profile: input.profile,
				dbPath: resolve(input.dbPath),
				backupPath,
				platform: result.platform,
				channelInstanceId: result.channelInstanceId,
				preMigrationDigest,
				postMigrationDigest,
				appliedAt: result.appliedAt,
				result,
			};
			await writeJsonAtomically(manifestPath, manifest);
			return { ...manifest, manifestPath };
		} catch (error) {
			if (!databaseChanged) await rm(backupPath, { force: true }).catch(() => undefined);
			throw error;
		}
	});
}

export async function rollbackProfileChannelInstanceMigration(input: RollbackProfileChannelInstanceMigrationInput): Promise<ProfileChannelInstanceMigrationManifest> {
	return withProfileOffline(input.lockRoot, input.profile, async () => {
		const manifestPath = resolve(input.manifestPath);
		const manifest = parseManifest(await readFile(manifestPath, "utf8"));
		if (manifest.profile !== input.profile) throw new Error(`Migration belongs to Profile '${manifest.profile}', not '${input.profile}'`);
		if (manifest.status !== "applied") throw new Error(`Migration ${manifest.migrationId} is already ${manifest.status}`);
		verifySqliteDatabase(manifest.backupPath);
		if (await sha256File(manifest.backupPath) !== manifest.preMigrationDigest) throw new Error("Migration backup digest does not match its manifest");

		const directory = dirname(manifestPath);
		const currentDigest = await digestSqliteSnapshot(manifest.dbPath, directory);
		if (currentDigest !== manifest.postMigrationDigest) {
			throw new Error("Profile database changed after migration; rollback would erase newer writes");
		}

		const postMigrationBackupPath = join(directory, `${manifest.migrationId}.after.db`);
		await assertAbsent(postMigrationBackupPath);
		await backupSqliteDatabase(manifest.dbPath, postMigrationBackupPath);
		verifySqliteDatabase(postMigrationBackupPath);
		const restorePath = join(dirname(manifest.dbPath), `.channel-instance-restore-${randomUUID()}.db`);
		try {
			await backupSqliteDatabase(manifest.backupPath, restorePath);
			verifySqliteDatabase(restorePath);
			await rm(`${manifest.dbPath}-wal`, { force: true });
			await rm(`${manifest.dbPath}-shm`, { force: true });
			await rename(restorePath, manifest.dbPath);
			verifySqliteDatabase(manifest.dbPath);
		} catch (error) {
			await rm(restorePath, { force: true }).catch(() => undefined);
			throw error;
		}

		const rolledBack: ProfileChannelInstanceMigrationManifest = {
			...manifest,
			status: "rolled_back",
			postMigrationBackupPath,
			rolledBackAt: Date.now(),
		};
		await writeJsonAtomically(manifestPath, rolledBack);
		return rolledBack;
	});
}

async function withProfileOffline<T>(lockRoot: string, profile: string, operation: () => T | Promise<T>): Promise<T> {
	const release = await acquireChannelLock(lockRoot, `profile:${profile}`);
	try { return await operation(); }
	finally { await release(); }
}

function migrationFileId(value: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(value)) {
		throw new Error("migrationId must contain only letters, numbers, '.', '_' or '-' and be at most 200 characters");
	}
	return value;
}

async function assertAbsent(path: string): Promise<void> {
	try {
		await access(path);
		throw new Error(`Migration artifact already exists: ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function digestSqliteSnapshot(dbPath: string, directory: string): Promise<string> {
	const snapshot = join(directory, `.digest-${randomUUID()}.db`);
	try {
		await backupSqliteDatabase(dbPath, snapshot);
		verifySqliteDatabase(snapshot);
		return await sha256File(snapshot);
	} finally { await rm(snapshot, { force: true }).catch(() => undefined); }
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await import("node:fs/promises").then(({ open }) => open(temp, "wx", 0o600));
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally { await handle.close(); }
		await rename(temp, path);
	} finally { await rm(temp, { force: true }).catch(() => undefined); }
}

function parseManifest(source: string): ProfileChannelInstanceMigrationManifest {
	const value = JSON.parse(source) as Partial<ProfileChannelInstanceMigrationManifest>;
	if (value.version !== 1 || !value.migrationId || !value.profile || !value.dbPath || !value.backupPath
		|| !value.preMigrationDigest || !value.postMigrationDigest || !value.result
		|| (value.status !== "applied" && value.status !== "rolled_back")) {
		throw new Error("Channel instance migration manifest is invalid");
	}
	return value as ProfileChannelInstanceMigrationManifest;
}

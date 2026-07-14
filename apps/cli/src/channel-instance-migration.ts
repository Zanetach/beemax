import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	backupSqliteDatabase,
	digestSqliteDatabase,
	ProfileChannelInstanceMigration,
	verifySqliteDatabase,
	type AppliedChannelInstanceMigration,
	type ChannelInstanceMigrationPlan,
	type PreparedChannelInstanceMigration,
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

export type ProfileChannelInstanceMigrationStatus = "prepared" | "applied" | "rollback_prepared" | "rolled_back" | "aborted";

export interface ProfileChannelInstanceMigrationManifest {
	version: 1;
	status: ProfileChannelInstanceMigrationStatus;
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
	rollbackPreparedAt?: number;
	rolledBackAt?: number;
	abortedAt?: number;
	result: AppliedChannelInstanceMigration;
}

export interface AppliedProfileChannelInstanceMigration extends ProfileChannelInstanceMigrationManifest {
	manifestPath: string;
}

export interface RollbackProfileChannelInstanceMigrationInput {
	lockRoot: string;
	profileHome: string;
	profile: string;
	dbPath: string;
	manifestPath: string;
}

interface MigrationPaths {
	profileHome: string;
	directory: string;
	dbPath: string;
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
		const paths = await resolveMigrationPaths(input.profileHome, input.dbPath);
		const backupPath = join(paths.directory, `${migrationId}.before.db`);
		const backupTempPath = join(paths.directory, `.${migrationId}.before-${randomUUID()}.tmp`);
		const manifestPath = join(paths.directory, `${migrationId}.json`);
		await assertAbsent(backupPath);
		await assertAbsent(manifestPath);

		const migration = new ProfileChannelInstanceMigration(paths.dbPath);
		let manifest: ProfileChannelInstanceMigrationManifest | undefined;
		let manifestPersisted = false;
		try {
			const prepared = await migration.applyWithBackup({
				id: migrationId,
				platform: input.platform,
				channelInstanceId: input.channelInstanceId,
				backupRef: backupPath,
			}, backupTempPath, async (state) => {
				verifySqliteDatabase(backupTempPath);
				await publishArtifact(backupTempPath, backupPath);
				manifest = preparedManifest(input.profile, paths.dbPath, backupPath, migrationId, state);
				await writeJsonAtomically(manifestPath, manifest);
				manifestPersisted = true;
			});
			manifest ??= preparedManifest(input.profile, paths.dbPath, backupPath, migrationId, prepared);
			verifySqliteDatabase(paths.dbPath);
			const applied: ProfileChannelInstanceMigrationManifest = { ...manifest, status: "applied" };
			await writeJsonAtomically(manifestPath, applied);
			return { ...applied, manifestPath };
		} catch (error) {
			if (!manifestPersisted) await rm(backupPath, { force: true }).catch(() => undefined);
			throw error;
		} finally {
			migration.close();
			await rm(backupTempPath, { force: true }).catch(() => undefined);
		}
	});
}

export async function rollbackProfileChannelInstanceMigration(input: RollbackProfileChannelInstanceMigrationInput): Promise<ProfileChannelInstanceMigrationManifest> {
	return withProfileOffline(input.lockRoot, input.profile, async () => {
		const paths = await resolveMigrationPaths(input.profileHome, input.dbPath);
		const manifestPath = await validateManifestLocation(input.manifestPath, paths.directory);
		let manifest = parseManifest(await readFile(manifestPath, "utf8"));
		validateManifestOwnership(manifest, input.profile, paths, manifestPath);
		if (manifest.status === "rolled_back" || manifest.status === "aborted") {
			throw new Error(`Migration ${manifest.migrationId} is already ${manifest.status}`);
		}

		await validateArtifactFile(manifest.backupPath);
		verifySqliteDatabase(manifest.backupPath);
		if (digestSqliteDatabase(manifest.backupPath) !== manifest.preMigrationDigest) {
			throw new Error("Migration backup digest does not match its manifest");
		}
		let currentDigest = digestSqliteDatabase(paths.dbPath);
		if (manifest.status === "prepared" && currentDigest === manifest.preMigrationDigest) {
			const aborted: ProfileChannelInstanceMigrationManifest = { ...manifest, status: "aborted", abortedAt: Date.now() };
			await writeJsonAtomically(manifestPath, aborted);
			return aborted;
		}
		if (manifest.status === "rollback_prepared" && currentDigest === manifest.preMigrationDigest) {
			const completed: ProfileChannelInstanceMigrationManifest = { ...manifest, status: "rolled_back", rolledBackAt: Date.now() };
			await writeJsonAtomically(manifestPath, completed);
			return completed;
		}
		if (currentDigest !== manifest.postMigrationDigest) {
			throw new Error("Profile database changed after migration; rollback would erase newer writes");
		}

		const postMigrationBackupPath = join(paths.directory, `${manifest.migrationId}.after.db`);
		if (await exists(postMigrationBackupPath)) {
			await validateArtifactFile(postMigrationBackupPath);
			verifySqliteDatabase(postMigrationBackupPath);
			if (digestSqliteDatabase(postMigrationBackupPath) !== manifest.postMigrationDigest) {
				throw new Error("Post-migration recovery snapshot does not match its manifest");
			}
		} else {
			await createVerifiedBackup(paths.dbPath, postMigrationBackupPath, manifest.postMigrationDigest);
		}

		manifest = {
			...manifest,
			status: "rollback_prepared",
			postMigrationBackupPath,
			rollbackPreparedAt: manifest.rollbackPreparedAt ?? Date.now(),
		};
		await writeJsonAtomically(manifestPath, manifest);
		const migration = new ProfileChannelInstanceMigration(paths.dbPath);
		try { migration.rollbackApplied(manifest.result, manifest.postMigrationDigest, manifest.preMigrationDigest); }
		finally { migration.close(); }
		verifySqliteDatabase(paths.dbPath);

		const rolledBack: ProfileChannelInstanceMigrationManifest = { ...manifest, status: "rolled_back", rolledBackAt: Date.now() };
		await writeJsonAtomically(manifestPath, rolledBack);
		return rolledBack;
	});
}

async function withProfileOffline<T>(lockRoot: string, profile: string, operation: () => T | Promise<T>): Promise<T> {
	const release = await acquireChannelLock(lockRoot, `profile:${profile}`);
	try { return await operation(); }
	finally { await release(); }
}

function preparedManifest(
	profile: string,
	dbPath: string,
	backupPath: string,
	migrationId: string,
	prepared: PreparedChannelInstanceMigration,
): ProfileChannelInstanceMigrationManifest {
	return {
		version: 1,
		status: "prepared",
		migrationId,
		profile,
		dbPath,
		backupPath,
		platform: prepared.result.platform,
		channelInstanceId: prepared.result.channelInstanceId,
		preMigrationDigest: prepared.preMigrationDigest,
		postMigrationDigest: prepared.postMigrationDigest,
		appliedAt: prepared.result.appliedAt,
		result: prepared.result,
	};
}

async function resolveMigrationPaths(profileHome: string, dbPath: string): Promise<MigrationPaths> {
	const canonicalProfileHome = await realpath(resolve(profileHome));
	const directory = join(canonicalProfileHome, "migrations", "channel-instance");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (await realpath(directory) !== directory) throw new Error("Profile migration directory resolves outside the selected Profile");
	return { profileHome: canonicalProfileHome, directory, dbPath: await realpath(resolve(dbPath)) };
}

async function validateManifestLocation(path: string, directory: string): Promise<string> {
	const canonical = await realpath(resolve(path));
	if (dirname(canonical) !== directory) throw new Error("Migration manifest path is outside the selected Profile migration directory");
	return canonical;
}

function validateManifestOwnership(manifest: ProfileChannelInstanceMigrationManifest, profile: string, paths: MigrationPaths, manifestPath: string): void {
	const id = migrationFileId(manifest.migrationId);
	if (manifest.profile !== profile) throw new Error(`Migration belongs to Profile '${manifest.profile}', not '${profile}'`);
	if (resolve(manifestPath) !== join(paths.directory, `${id}.json`)) throw new Error("Migration manifest path does not match its migration id");
	if (resolve(manifest.dbPath) !== paths.dbPath) throw new Error("Migration manifest does not target the selected Profile configured database");
	if (resolve(manifest.backupPath) !== join(paths.directory, `${id}.before.db`)) throw new Error("Migration backup path does not match the selected Profile");
	if (manifest.postMigrationBackupPath && resolve(manifest.postMigrationBackupPath) !== join(paths.directory, `${id}.after.db`)) {
		throw new Error("Post-migration backup path does not match the selected Profile");
	}
}

function migrationFileId(value: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(value)) {
		throw new Error("migrationId must contain only letters, numbers, '.', '_' or '-' and be at most 200 characters");
	}
	return value;
}

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function assertAbsent(path: string): Promise<void> {
	if (await exists(path)) throw new Error(`Migration artifact already exists: ${path}`);
}

async function publishArtifact(tempPath: string, finalPath: string): Promise<void> {
	try { await link(tempPath, finalPath); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Migration artifact already exists: ${finalPath}`);
		throw error;
	}
	await rm(tempPath, { force: true });
	await fsyncDirectory(dirname(finalPath));
}

async function createVerifiedBackup(sourcePath: string, finalPath: string, expectedDigest: string): Promise<void> {
	const tempPath = join(dirname(finalPath), `.${randomUUID()}.backup.tmp`);
	try {
		await backupSqliteDatabase(sourcePath, tempPath);
		verifySqliteDatabase(tempPath);
		if (digestSqliteDatabase(tempPath) !== expectedDigest) throw new Error("Profile database changed while preparing rollback");
		await publishArtifact(tempPath, finalPath);
	} finally { await rm(tempPath, { force: true }).catch(() => undefined); }
}

async function validateArtifactFile(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
		throw new Error(`Migration artifact is not a regular Profile file: ${path}`);
	}
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally { await handle.close(); }
		await rename(temp, path);
		await fsyncDirectory(dirname(path));
	} finally { await rm(temp, { force: true }).catch(() => undefined); }
}

async function fsyncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try { await handle.sync(); }
	finally { await handle.close(); }
}

function parseManifest(source: string): ProfileChannelInstanceMigrationManifest {
	const value = JSON.parse(source) as Partial<ProfileChannelInstanceMigrationManifest>;
	if (value.version !== 1 || !value.migrationId || !value.profile || !value.dbPath || !value.backupPath
		|| !value.platform || !value.channelInstanceId || !value.preMigrationDigest || !value.postMigrationDigest || !value.result
		|| !["prepared", "applied", "rollback_prepared", "rolled_back", "aborted"].includes(value.status ?? "")) {
		throw new Error("Channel instance migration manifest is invalid");
	}
	return value as ProfileChannelInstanceMigrationManifest;
}

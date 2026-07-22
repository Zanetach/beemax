import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
	ProfileSessionOwnershipMigration,
	type AppliedSessionOwnershipMigration,
	type ThruveraRuntimeSource,
	type SessionOwnershipMigrationPlan,
} from "@thruvera/core";
import { acquireChannelLock } from "./channel-lock.ts";

export interface ProfileSessionOwnershipTarget<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> {
	lockRoot: string;
	profileHome: string;
	agentDir: string;
	profile: string;
	source: Source;
}

export interface ApplyProfileSessionOwnershipInput<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> extends ProfileSessionOwnershipTarget<Source> {
	legacySessionId: string;
	migrationId?: string;
}

export type ProfileSessionOwnershipStatus = "prepared" | "applied" | "rollback_prepared" | "rolled_back" | "aborted";

export interface ProfileSessionOwnershipManifest<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> {
	version: 1;
	status: ProfileSessionOwnershipStatus;
	migrationId: string;
	profile: string;
	agentDir: string;
	appliedAt: number;
	rollbackPreparedAt?: number;
	rolledBackAt?: number;
	abortedAt?: number;
	result: AppliedSessionOwnershipMigration<Source>;
}

export interface AppliedProfileSessionOwnership<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> extends ProfileSessionOwnershipManifest<Source> {
	manifestPath: string;
}

export interface RollbackProfileSessionOwnershipInput {
	lockRoot: string;
	profileHome: string;
	agentDir: string;
	profile: string;
	manifestPath: string;
}

interface MigrationPaths { profileHome: string; agentDir: string; directory: string; }

export async function planProfileSessionOwnershipMigration<Source extends ThruveraRuntimeSource>(input: ProfileSessionOwnershipTarget<Source>, legacySessionId?: string): Promise<SessionOwnershipMigrationPlan> {
	return withProfileOffline(input.lockRoot, input.profile, async () => {
		const paths = await resolveMigrationPaths(input.profileHome, input.agentDir);
		const plan = await new ProfileSessionOwnershipMigration<Source>(paths.agentDir).plan(input.source, legacySessionId);
		if (!plan.selected) return plan;
		return { ...plan, blockers: [...plan.blockers, ...await activeAssignmentBlockers(paths.directory, plan.selected.path)] };
	});
}

export async function applyProfileSessionOwnershipMigration<Source extends ThruveraRuntimeSource>(input: ApplyProfileSessionOwnershipInput<Source>): Promise<AppliedProfileSessionOwnership<Source>> {
	return withProfileOffline(input.lockRoot, input.profile, async () => {
		const paths = await resolveMigrationPaths(input.profileHome, input.agentDir);
		const migrationId = migrationFileId(input.migrationId ?? `session-ownership-${Date.now()}-${randomUUID()}`);
		const manifestPath = join(paths.directory, `${migrationId}.json`);
		await assertAbsent(manifestPath);
		const migration = new ProfileSessionOwnershipMigration<Source>(paths.agentDir);
		const plan = await migration.plan(input.source, input.legacySessionId, migrationId);
		const assignmentBlockers = plan.selected ? await activeAssignmentBlockers(paths.directory, plan.selected.path) : [];
		if (plan.blockers.length > 0 || assignmentBlockers.length > 0) throw new Error(`Session ownership migration is blocked:\n${[...plan.blockers, ...assignmentBlockers].join("\n")}`);
		let manifest: ProfileSessionOwnershipManifest<Source> | undefined;
		const prepared = await migration.apply({ id: migrationId, source: input.source, legacySessionId: input.legacySessionId }, async (state) => {
			manifest = {
				version: 1, status: "prepared", migrationId, profile: input.profile,
				agentDir: paths.agentDir, appliedAt: state.result.appliedAt, result: state.result,
			};
			await writeJsonAtomically(manifestPath, manifest);
		});
		manifest ??= { version: 1, status: "prepared", migrationId, profile: input.profile, agentDir: paths.agentDir, appliedAt: prepared.result.appliedAt, result: prepared.result };
		const applied: ProfileSessionOwnershipManifest<Source> = { ...manifest, status: "applied" };
		await writeJsonAtomically(manifestPath, applied);
		return { ...applied, manifestPath };
	});
}

export async function rollbackProfileSessionOwnershipMigration(input: RollbackProfileSessionOwnershipInput): Promise<ProfileSessionOwnershipManifest> {
	return withProfileOffline(input.lockRoot, input.profile, async () => {
		const paths = await resolveMigrationPaths(input.profileHome, input.agentDir);
		const manifestPath = await validateManifestLocation(input.manifestPath, paths.directory);
		let manifest = parseManifest(await readFile(manifestPath, "utf8"));
		validateManifestOwnership(manifest, input.profile, paths, manifestPath);
		if (manifest.status === "rolled_back" || manifest.status === "aborted") throw new Error(`Session migration ${manifest.migrationId} is already ${manifest.status}`);
		const recoveryState = manifest.status;
		await validateRegularFile(manifest.result.sourcePath);
		const targetExists = await exists(manifest.result.targetPath);
		if (manifest.status === "prepared" && !targetExists) {
			await new ProfileSessionOwnershipMigration(paths.agentDir).rollback(manifest.result);
			const aborted = { ...manifest, status: "aborted" as const, abortedAt: Date.now() };
			await writeJsonAtomically(manifestPath, aborted);
			return aborted;
		}
		if (targetExists) await validateRegularFile(manifest.result.targetPath);
		manifest = { ...manifest, status: "rollback_prepared", rollbackPreparedAt: manifest.rollbackPreparedAt ?? Date.now() };
		await writeJsonAtomically(manifestPath, manifest);
		await new ProfileSessionOwnershipMigration(paths.agentDir).rollback(manifest.result, { allowPreparedCatalog: recoveryState !== "applied" });
		const rolledBack = { ...manifest, status: "rolled_back" as const, rolledBackAt: Date.now() };
		await writeJsonAtomically(manifestPath, rolledBack);
		return rolledBack;
	});
}

async function withProfileOffline<T>(lockRoot: string, profile: string, operation: () => T | Promise<T>): Promise<T> {
	const release = await acquireChannelLock(lockRoot, `profile:${profile}`);
	try { return await operation(); } finally { await release(); }
}

async function resolveMigrationPaths(profileHome: string, agentDir: string): Promise<MigrationPaths> {
	const canonicalProfileHome = await realpath(resolve(profileHome));
	const canonicalAgentDir = await realpath(resolve(agentDir));
	const relativeAgent = relative(canonicalProfileHome, canonicalAgentDir);
	if (relativeAgent.startsWith("..") || resolve(canonicalProfileHome, relativeAgent) !== canonicalAgentDir) throw new Error("Profile Agent directory is outside the selected Profile");
	const directory = join(canonicalProfileHome, "migrations", "session-ownership");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (await realpath(directory) !== directory) throw new Error("Session migration directory resolves outside the selected Profile");
	return { profileHome: canonicalProfileHome, agentDir: canonicalAgentDir, directory };
}

async function validateManifestLocation(path: string, directory: string): Promise<string> {
	const canonical = await realpath(resolve(path));
	if (dirname(canonical) !== directory) throw new Error("Session migration manifest is outside the selected Profile migration directory");
	return canonical;
}

function validateManifestOwnership(manifest: ProfileSessionOwnershipManifest, profile: string, paths: MigrationPaths, manifestPath: string): void {
	const id = migrationFileId(manifest.migrationId);
	if (manifest.profile !== profile) throw new Error(`Session migration belongs to Profile '${manifest.profile}', not '${profile}'`);
	if (resolve(manifestPath) !== join(paths.directory, `${id}.json`)) throw new Error("Session migration manifest path does not match its id");
	if (resolve(manifest.agentDir) !== paths.agentDir) throw new Error("Session migration does not target the selected Profile Agent directory");
}

function parseManifest(source: string): ProfileSessionOwnershipManifest {
	const value = JSON.parse(source) as Partial<ProfileSessionOwnershipManifest>;
	if (value.version !== 1 || !value.migrationId || !value.profile || !value.agentDir || !value.result
		|| !["prepared", "applied", "rollback_prepared", "rolled_back", "aborted"].includes(value.status ?? "")) throw new Error("Session ownership migration manifest is invalid");
	return value as ProfileSessionOwnershipManifest;
}

function migrationFileId(value: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(value)) throw new Error("migrationId must contain only letters, numbers, '.', '_' or '-'");
	return value;
}

async function validateRegularFile(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error(`Session migration artifact is not a regular Profile file: ${path}`);
}

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function assertAbsent(path: string): Promise<void> { if (await exists(path)) throw new Error(`Session migration artifact already exists: ${path}`); }

async function activeAssignmentBlockers(directory: string, sourcePath: string): Promise<string[]> {
	const blockers: string[] = [];
	const entries = await opendir(directory);
	for await (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
		const path = join(directory, entry.name);
		let manifest: ProfileSessionOwnershipManifest;
		try { manifest = parseManifest(await readFile(path, "utf8")); }
		catch { blockers.push(`Existing Session migration manifest is unreadable: ${entry.name}`); continue; }
		if (!["prepared", "applied", "rollback_prepared"].includes(manifest.status)) continue;
		if (resolve(manifest.result.sourcePath) === resolve(sourcePath)) blockers.push(`Legacy Session is already assigned by active migration '${manifest.migrationId}'`);
	}
	return blockers;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
		finally { await handle.close(); }
		await rename(temporary, path);
		await fsyncDirectory(dirname(path));
	} finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

async function fsyncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

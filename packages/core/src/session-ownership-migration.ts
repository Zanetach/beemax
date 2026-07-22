import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ThruveraRuntimeSource } from "./runtime.ts";
import { legacySessionIdsForSource, sessionIdForSource } from "./session-coordinator.ts";
import { SessionCatalog, type SessionCatalogOwnershipReceipt } from "./session-catalog.ts";

export interface SessionOwnershipCandidate {
	sessionId: string;
	path: string;
	bytes: number;
	modifiedAt: number;
	digest: string;
}

export interface SessionOwnershipMigrationPlan {
	canonicalSessionId: string;
	candidates: SessionOwnershipCandidate[];
	selected?: SessionOwnershipCandidate;
	targetPath?: string;
	blockers: string[];
}

export interface ApplySessionOwnershipMigrationInput<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> {
	id: string;
	source: Source;
	legacySessionId: string;
	appliedAt?: number;
}

export interface AppliedSessionOwnershipMigration<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> {
	id: string;
	source: Source;
	legacySessionId: string;
	canonicalSessionId: string;
	sourcePath: string;
	targetPath: string;
	sourceDigest: string;
	targetDigest: string;
	catalogReceipt: SessionCatalogOwnershipReceipt;
	appliedAt: number;
}

export interface PreparedSessionOwnershipMigration<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> {
	result: AppliedSessionOwnershipMigration<Source>;
}

export interface RollbackSessionOwnershipMigrationOptions {
	/** Accept Catalog-before only while recovering a prepared or already-started rollback state. */
	allowPreparedCatalog?: boolean;
}

const MAX_HEADER_BYTES = 64 * 1024;

/** Explicitly assigns one legacy Actor-scoped Pi transcript to one canonical shared Conversation. */
export class ProfileSessionOwnershipMigration<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> {
	private readonly agentDir: string;
	private readonly sessionDir: string;
	private readonly catalog: SessionCatalog<Source>;

	constructor(agentDir: string) {
		this.agentDir = resolve(agentDir);
		this.sessionDir = join(this.agentDir, "sessions");
		this.catalog = SessionCatalog.forAgentDir<Source>(this.agentDir);
	}

	async plan(source: Source, legacySessionId?: string, id = "session-ownership"): Promise<SessionOwnershipMigrationPlan> {
		await this.assertSessionDirectory();
		validateSource(source);
		const migrationId = validateMigrationId(id);
		const canonicalSessionId = sessionIdForSource(source);
		const eligible = new Set(legacySessionIdsForSource(source));
		const blockers: string[] = [];
		if (legacySessionId && !eligible.has(legacySessionId)) blockers.push("Selected legacy Session does not belong to this Conversation and Actor");
		const discovery = await this.findCandidates(eligible);
		blockers.push(...discovery.blockers);
		const candidates = discovery.candidates;
		const matchingCanonical = await this.pathsWithSuffix(`_${canonicalSessionId}.jsonl`, 2);
		if (matchingCanonical.length > 0) blockers.push(`Canonical Session already exists: ${matchingCanonical.map((path) => basename(path)).join(", ")}`);
		const selectedCandidates = legacySessionId ? candidates.filter((candidate) => candidate.sessionId === legacySessionId) : [];
		if (legacySessionId && selectedCandidates.length === 0) blockers.push("Selected legacy Session transcript was not found");
		if (legacySessionId && selectedCandidates.length > 1) blockers.push("Selected legacy Session has multiple transcript files and is ambiguous");
		const targetPath = join(this.sessionDir, `${timestampForFile(Date.now())}-${migrationId}_${canonicalSessionId}.jsonl`);
		return { canonicalSessionId, candidates, selected: selectedCandidates.length === 1 ? selectedCandidates[0] : undefined, targetPath, blockers };
	}

	async apply(
		input: ApplySessionOwnershipMigrationInput<Source>,
		prepareCommit: (prepared: PreparedSessionOwnershipMigration<Source>) => void | Promise<void>,
	): Promise<PreparedSessionOwnershipMigration<Source>> {
		const id = validateMigrationId(input.id);
		const appliedAt = input.appliedAt ?? Date.now();
		const plan = await this.plan(input.source, input.legacySessionId, id);
		if (plan.blockers.length > 0 || !plan.selected || !plan.targetPath) throw new Error(`Session ownership migration is blocked:\n${plan.blockers.join("\n")}`);
		const targetPath = join(this.sessionDir, `${timestampForFile(appliedAt)}-${id}_${plan.canonicalSessionId}.jsonl`);
		const tempPath = join(this.sessionDir, `.${id}-${randomUUID()}.tmp`);
		const catalogReceipt = await this.catalog.prepareOwnershipMigration(input.source);
		try {
			const sourceDigest = await rewritePinnedSession(plan.selected.path, tempPath, input.legacySessionId, plan.canonicalSessionId);
			if (sourceDigest !== plan.selected.digest) throw new Error("Legacy Session changed while migration was prepared");
			const targetDigest = await digestFile(tempPath);
			const result: AppliedSessionOwnershipMigration<Source> = {
				id, source: { ...input.source }, legacySessionId: input.legacySessionId,
				canonicalSessionId: plan.canonicalSessionId, sourcePath: plan.selected.path, targetPath,
				sourceDigest, targetDigest, catalogReceipt, appliedAt,
			};
			const prepared = { result };
			await prepareCommit(prepared);
			await publishNoClobber(tempPath, targetPath);
			try { await this.catalog.applyOwnershipMigration(input.source, catalogReceipt); }
			catch (error) {
				try { await removeUnchangedArtifact(targetPath, targetDigest); }
				catch (cleanupError) { throw new AggregateError([error, cleanupError], "Session Catalog update failed and its published transcript could not be safely removed"); }
				throw error;
			}
			return prepared;
		} finally {
			await rm(tempPath, { force: true }).catch(() => undefined);
		}
	}

	async rollback(result: AppliedSessionOwnershipMigration<Source>, options: RollbackSessionOwnershipMigrationOptions = {}): Promise<void> {
		await this.assertSessionDirectory();
		this.validateApplied(result);
		if (await digestPinnedPath(result.sourcePath) !== result.sourceDigest) throw new Error("Legacy Session changed after ownership migration");
		const quarantine = `${result.targetPath}.rollback-${result.id}`;
		const abortQuarantine = `${result.targetPath}.abort`;
		let targetExists = await exists(result.targetPath);
		let quarantineExists = await exists(quarantine);
		if (targetExists && quarantineExists) {
			await removeDuplicateHardLink(result.targetPath, quarantine, result.targetDigest);
			quarantineExists = false;
		}
		const abortExists = await exists(abortQuarantine);
		if (abortExists) {
			if (targetExists) await removeDuplicateHardLink(result.targetPath, abortQuarantine, result.targetDigest);
			else {
				if (await digestFile(abortQuarantine) !== result.targetDigest) throw new Error("Aborted Session cleanup artifact changed after ownership migration");
				await rm(abortQuarantine);
				await fsyncDirectory(this.sessionDir);
			}
			targetExists = await exists(result.targetPath);
		}
		if (!targetExists) {
			const otherCanonical = (await this.pathsWithSuffix(`_${result.canonicalSessionId}.jsonl`, 1)).filter((path) => path !== result.targetPath);
			if (otherCanonical.length > 0) throw new Error(`A new canonical Session already exists: ${basename(otherCanonical[0])}`);
			if (quarantineExists && await digestFile(quarantine) !== result.targetDigest) throw new Error("Rollback Session artifact changed after ownership migration");
			await this.catalog.reconcileOwnershipRollback(result.source, result.catalogReceipt);
			if (quarantineExists) await rm(quarantine, { force: true });
			await fsyncDirectory(this.sessionDir);
			return;
		}
		if (quarantineExists) throw new Error("Session rollback artifact already exists");
		const target = await openPinnedRegularFile(result.targetPath);
		try {
			if (await digestHandle(target.handle) !== result.targetDigest) throw new Error("Canonical Session changed after ownership migration");
			await rename(result.targetPath, quarantine);
			if (!sameFile(await target.handle.stat(), await lstat(quarantine)) || await digestHandle(target.handle) !== result.targetDigest) throw new Error("Canonical Session changed during ownership rollback");
			if (options.allowPreparedCatalog) await this.catalog.reconcileOwnershipRollback(result.source, result.catalogReceipt);
			else await this.catalog.rollbackOwnershipMigration(result.source, result.catalogReceipt);
			await fsyncDirectory(this.sessionDir);
			if (await digestHandle(target.handle) !== result.targetDigest) throw new Error("Canonical Session changed during ownership rollback");
			await rm(quarantine, { force: true });
			await fsyncDirectory(this.sessionDir);
		} catch (error) {
			if (await exists(quarantine)) {
				try { await restoreNoClobber(quarantine, result.targetPath); }
				catch (restoreError) { throw new AggregateError([error, restoreError], "Session rollback failed and its canonical artifact could not be restored"); }
			}
			throw error;
		} finally { await target.handle.close(); }
	}

	private validateApplied(result: AppliedSessionOwnershipMigration<Source>): void {
		validateMigrationId(result.id);
		validateSource(result.source);
		if (!Number.isSafeInteger(result.appliedAt) || result.appliedAt <= 0 || !/^[a-f0-9]{64}$/u.test(result.sourceDigest) || !/^[a-f0-9]{64}$/u.test(result.targetDigest)) throw new Error("Session migration evidence is invalid");
		if (result.canonicalSessionId !== sessionIdForSource(result.source)) throw new Error("Session migration target identity is invalid");
		if (!legacySessionIdsForSource(result.source).includes(result.legacySessionId)) throw new Error("Session migration source identity is invalid");
		if (dirname(resolve(result.sourcePath)) !== this.sessionDir || dirname(resolve(result.targetPath)) !== this.sessionDir) throw new Error("Session migration path is outside the Profile session directory");
		const expectedTarget = `${timestampForFile(result.appliedAt)}-${result.id}_${result.canonicalSessionId}.jsonl`;
		if (!basename(result.sourcePath).endsWith(`_${result.legacySessionId}.jsonl`) || basename(result.targetPath) !== expectedTarget) throw new Error("Session migration path does not match its identity");
	}

	private async findCandidates(eligible: Set<string>): Promise<{ candidates: SessionOwnershipCandidate[]; blockers: string[] }> {
		const candidates: SessionOwnershipCandidate[] = [];
		const blockers: string[] = [];
		for (const sessionId of eligible) {
			for (const path of await this.pathsWithSuffix(`_${sessionId}.jsonl`, 2)) {
				try {
					const inspected = await inspectCandidate(path, sessionId);
					candidates.push({ sessionId, path, ...inspected });
				} catch (error) { blockers.push(`Invalid legacy Session ${basename(path)}: ${messageOf(error)}`); }
			}
		}
		return { candidates: candidates.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path)), blockers };
	}

	private async pathsWithSuffix(suffix: string, limit: number): Promise<string[]> {
		const paths: string[] = [];
		try {
			const directory = await opendir(this.sessionDir);
			for await (const entry of directory) {
				if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(suffix)) paths.push(join(this.sessionDir, entry.name));
				if (paths.length >= limit) break;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return paths.sort().reverse();
	}

	private async assertSessionDirectory(): Promise<void> {
		try { await mkdir(this.sessionDir, { recursive: true, mode: 0o700 }); }
		catch (error) { throw new Error(`Unable to prepare the Profile session directory: ${messageOf(error)}`); }
		const info = await lstat(this.sessionDir);
		if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.sessionDir) !== join(await realpath(this.agentDir), "sessions")) throw new Error("Profile session directory must be a real directory inside the Profile");
	}
}

async function rewritePinnedSession(sourcePath: string, targetPath: string, expectedSourceId: string, targetId: string): Promise<string> {
	const source = await openPinnedRegularFile(sourcePath);
	const target = await open(targetPath, "wx", 0o600);
	const hash = createHash("sha256");
	let headerBytes = Buffer.alloc(0);
	let offset = 0;
	try {
		while (headerBytes.byteLength <= MAX_HEADER_BYTES) {
			const chunk = Buffer.alloc(Math.min(4096, MAX_HEADER_BYTES + 1 - headerBytes.byteLength));
			const { bytesRead } = await source.handle.read(chunk, 0, chunk.byteLength, offset);
			if (bytesRead === 0) break;
			const bytes = chunk.subarray(0, bytesRead);
			hash.update(bytes);
			headerBytes = Buffer.concat([headerBytes, bytes]);
			offset += bytesRead;
			const newline = headerBytes.indexOf(0x0a);
			if (newline >= 0) {
				const remainder = headerBytes.subarray(newline + 1);
				headerBytes = headerBytes.subarray(0, newline);
				const header = parseSessionHeader(headerBytes, expectedSourceId);
				await target.writeFile(`${JSON.stringify({ ...header, id: targetId })}\n`, "utf8");
				if (remainder.byteLength > 0) await writeAll(target, remainder);
				break;
			}
		}
		if (offset === 0 || headerBytes.byteLength > MAX_HEADER_BYTES) throw new Error("Legacy Session header is missing or exceeds 64 KiB");
		const chunk = Buffer.alloc(64 * 1024);
		while (true) {
			const { bytesRead } = await source.handle.read(chunk, 0, chunk.byteLength, offset);
			if (bytesRead === 0) break;
			const bytes = chunk.subarray(0, bytesRead);
			hash.update(bytes);
			await writeAll(target, bytes);
			offset += bytesRead;
		}
		const after = await source.handle.stat();
		const pathAfter = await lstat(sourcePath);
		if (!sameFile(source.info, after) || !sameFile(after, pathAfter) || after.size !== offset) throw new Error("Legacy Session changed while migration was prepared");
		await target.sync();
		return hash.digest("hex");
	} finally { await Promise.allSettled([source.handle.close(), target.close()]); }
}

async function digestFile(path: string): Promise<string> {
	const pinned = await openPinnedRegularFile(path);
	try { return await digestHandle(pinned.handle); } finally { await pinned.handle.close(); }
}

async function digestPinnedPath(path: string): Promise<string> {
	const pinned = await openPinnedRegularFile(path);
	try {
		const digest = await digestHandle(pinned.handle);
		if (!sameFile(await pinned.handle.stat(), await lstat(path))) throw new Error("Session artifact changed identity while it was read");
		return digest;
	} finally { await pinned.handle.close(); }
}

async function inspectCandidate(path: string, expectedId: string): Promise<{ bytes: number; modifiedAt: number; digest: string }> {
	const pinned = await openPinnedRegularFile(path);
	try {
		await readSessionHeader(pinned.handle, expectedId);
		const digest = await digestHandle(pinned.handle);
		const after = await pinned.handle.stat();
		if (!sameFile(pinned.info, after) || !sameFile(after, await lstat(path))) throw new Error("Session candidate changed while it was inspected");
		return { bytes: after.size, modifiedAt: after.mtimeMs, digest };
	} finally { await pinned.handle.close(); }
}

async function openPinnedRegularFile(path: string): Promise<{ handle: FileHandle; info: Stats }> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || !sameFile(info, await lstat(path)) || await realpath(path) !== join(await realpath(dirname(path)), basename(path))) throw new Error(`Session artifact is not a pinned regular file: ${path}`);
		return { handle, info };
	} catch (error) { await handle.close(); throw error; }
}

async function readSessionHeader(handle: FileHandle, expectedId: string): Promise<Record<string, unknown>> {
	let bytes = Buffer.alloc(0);
	let offset = 0;
	while (bytes.byteLength <= MAX_HEADER_BYTES) {
		const chunk = Buffer.alloc(Math.min(4096, MAX_HEADER_BYTES + 1 - bytes.byteLength));
		const result = await handle.read(chunk, 0, chunk.byteLength, offset);
		if (result.bytesRead === 0) break;
		bytes = Buffer.concat([bytes, chunk.subarray(0, result.bytesRead)]);
		const newline = bytes.indexOf(0x0a);
		if (newline >= 0) return parseSessionHeader(bytes.subarray(0, newline), expectedId);
		offset += result.bytesRead;
	}
	throw new Error("Legacy Session header is missing or exceeds 64 KiB");
}

function parseSessionHeader(bytes: Buffer, expectedId: string): Record<string, unknown> {
	let header: Record<string, unknown>;
	try { header = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
	catch { throw new Error("Legacy Session header is not valid JSON"); }
	if (header.type !== "session" || header.id !== expectedId || typeof header.cwd !== "string" || typeof header.timestamp !== "string") throw new Error("Legacy Session header does not match the selected Session identity");
	return header;
}

async function digestHandle(handle: FileHandle): Promise<string> {
	const hash = createHash("sha256");
	const chunk = Buffer.alloc(64 * 1024);
	let offset = 0;
	while (true) {
		const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
		if (bytesRead === 0) break;
		hash.update(chunk.subarray(0, bytesRead));
		offset += bytesRead;
	}
	return hash.digest("hex");
}

function sameFile(left: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">, right: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
	let written = 0;
	while (written < bytes.byteLength) {
		const result = await handle.write(bytes, written, bytes.byteLength - written);
		if (result.bytesWritten <= 0) throw new Error("Unable to make progress while writing the canonical Session");
		written += result.bytesWritten;
	}
}

async function publishNoClobber(tempPath: string, targetPath: string): Promise<void> {
	try { await link(tempPath, targetPath); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Canonical Session already exists: ${targetPath}`);
		throw error;
	}
	await rm(tempPath, { force: true });
	await fsyncDirectory(dirname(targetPath));
}

async function removeUnchangedArtifact(path: string, expectedDigest: string): Promise<void> {
	const pinned = await openPinnedRegularFile(path);
	const quarantine = `${path}.abort`;
	try {
		if (await exists(quarantine)) throw new Error(`Published Session cleanup artifact already exists: ${quarantine}`);
		if (await digestHandle(pinned.handle) !== expectedDigest) throw new Error("Published Session changed before cleanup");
		await rename(path, quarantine);
		if (!sameFile(await pinned.handle.stat(), await lstat(quarantine)) || await digestHandle(pinned.handle) !== expectedDigest) throw new Error("Published Session changed during cleanup");
		await rm(quarantine);
		await fsyncDirectory(dirname(path));
	} catch (error) {
		if (await exists(quarantine)) {
			try { await restoreNoClobber(quarantine, path); }
			catch (restoreError) { throw new AggregateError([error, restoreError], "Published Session cleanup failed and its artifact could not be restored"); }
		}
		throw error;
	} finally { await pinned.handle.close(); }
}

async function restoreNoClobber(quarantine: string, target: string): Promise<void> {
	try { await link(quarantine, target); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Refusing to overwrite a Session that appeared during recovery: ${target}`);
		throw error;
	}
	await fsyncDirectory(dirname(target));
	await rm(quarantine);
	await fsyncDirectory(dirname(target));
}

async function removeDuplicateHardLink(target: string, quarantine: string, expectedDigest: string): Promise<void> {
	const targetFile = await openPinnedRegularFile(target);
	const quarantineFile = await openPinnedRegularFile(quarantine);
	try {
		if (!sameFile(await targetFile.handle.stat(), await quarantineFile.handle.stat())) throw new Error("Session recovery paths refer to different files");
		if (await digestHandle(targetFile.handle) !== expectedDigest || await digestHandle(quarantineFile.handle) !== expectedDigest) throw new Error("Session recovery artifact changed after ownership migration");
		await rm(quarantine);
		await fsyncDirectory(dirname(target));
	} finally { await Promise.allSettled([targetFile.handle.close(), quarantineFile.handle.close()]); }
}

async function fsyncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try { await directory.sync(); } finally { await directory.close(); }
}

function validateSource(source: ThruveraRuntimeSource): void {
	if (source.chatType !== "group" && source.chatType !== "thread") throw new Error("Session Ownership Migration supports group Conversations only");
	for (const [name, value] of [["platform", source.platform], ["channelInstanceId", source.channelInstanceId], ["chatId", source.chatId], ["userId", source.userId]] as const) {
		if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} is required and must not contain control characters`);
	}
}

function validateMigrationId(value: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(value)) throw new Error("migration id must contain only letters, numbers, '.', '_' or '-'");
	return value;
}

function timestampForFile(value: number): string { return new Date(value).toISOString().replace(/[:.]/gu, "-"); }

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

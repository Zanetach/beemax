import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, opendir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
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

export interface ApplySessionOwnershipMigrationInput<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	id: string;
	source: Source;
	legacySessionId: string;
	appliedAt?: number;
}

export interface AppliedSessionOwnershipMigration<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
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

export interface PreparedSessionOwnershipMigration<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	result: AppliedSessionOwnershipMigration<Source>;
}

const MAX_HEADER_BYTES = 64 * 1024;

/** Explicitly assigns one legacy Actor-scoped Pi transcript to one canonical shared Conversation. */
export class ProfileSessionOwnershipMigration<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	private readonly agentDir: string;
	private readonly sessionDir: string;
	private readonly catalog: SessionCatalog<Source>;

	constructor(agentDir: string) {
		this.agentDir = resolve(agentDir);
		this.sessionDir = join(this.agentDir, "sessions");
		this.catalog = SessionCatalog.forAgentDir<Source>(this.agentDir);
	}

	async plan(source: Source, legacySessionId?: string, id = "session-ownership"): Promise<SessionOwnershipMigrationPlan> {
		validateSource(source);
		const migrationId = validateMigrationId(id);
		const canonicalSessionId = sessionIdForSource(source);
		const eligible = new Set(legacySessionIdsForSource(source));
		const blockers: string[] = [];
		if (legacySessionId && !eligible.has(legacySessionId)) blockers.push("Selected legacy Session does not belong to this Conversation and Actor");
		const candidates = await this.findCandidates(eligible);
		const matchingCanonical = await this.pathsWithSuffix(`_${canonicalSessionId}.jsonl`);
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
		await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
		const targetPath = join(this.sessionDir, `${timestampForFile(appliedAt)}-${id}_${plan.canonicalSessionId}.jsonl`);
		const tempPath = join(this.sessionDir, `.${id}-${randomUUID()}.tmp`);
		const catalogReceipt = await this.catalog.prepareOwnershipMigration(input.source);
		let published = false;
		try {
			await rewriteSession(plan.selected.path, tempPath, input.legacySessionId, plan.canonicalSessionId);
			const sourceDigest = await digestFile(plan.selected.path);
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
			published = true;
			try { await this.catalog.applyOwnershipMigration(input.source, catalogReceipt); }
			catch (error) { await rm(targetPath, { force: true }); await fsyncDirectory(this.sessionDir); throw error; }
			return prepared;
		} finally {
			await rm(tempPath, { force: true }).catch(() => undefined);
			if (!published) await rm(targetPath, { force: true }).catch(() => undefined);
		}
	}

	async rollback(result: AppliedSessionOwnershipMigration<Source>): Promise<void> {
		this.validateApplied(result);
		if (await digestFile(result.sourcePath) !== result.sourceDigest) throw new Error("Legacy Session changed after ownership migration");
		const quarantine = `${result.targetPath}.rollback-${result.id}`;
		const targetExists = await exists(result.targetPath);
		const quarantineExists = await exists(quarantine);
		if (!targetExists) {
			if (quarantineExists && await digestFile(quarantine) !== result.targetDigest) throw new Error("Rollback Session artifact changed after ownership migration");
			await this.catalog.reconcileOwnershipRollback(result.source, result.catalogReceipt);
			if (quarantineExists) await rm(quarantine, { force: true });
			await fsyncDirectory(this.sessionDir);
			return;
		}
		if (quarantineExists) throw new Error("Session rollback artifact already exists");
		if (await digestFile(result.targetPath) !== result.targetDigest) throw new Error("Canonical Session changed after ownership migration");
		await rename(result.targetPath, quarantine);
		try {
			await this.catalog.rollbackOwnershipMigration(result.source, result.catalogReceipt);
			await fsyncDirectory(this.sessionDir);
			await rm(quarantine, { force: true });
		} catch (error) {
			await rename(quarantine, result.targetPath).catch(() => undefined);
			throw error;
		}
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

	private async findCandidates(eligible: Set<string>): Promise<SessionOwnershipCandidate[]> {
		const candidates: SessionOwnershipCandidate[] = [];
		for (const sessionId of eligible) {
			for (const path of await this.pathsWithSuffix(`_${sessionId}.jsonl`)) {
				const info = await stat(path);
				candidates.push({ sessionId, path, bytes: info.size, modifiedAt: info.mtimeMs, digest: await digestFile(path) });
			}
		}
		return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
	}

	private async pathsWithSuffix(suffix: string): Promise<string[]> {
		const paths: string[] = [];
		try {
			const directory = await opendir(this.sessionDir);
			for await (const entry of directory) if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(suffix)) paths.push(join(this.sessionDir, entry.name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return paths.sort().reverse();
	}
}

async function rewriteSession(sourcePath: string, targetPath: string, expectedSourceId: string, targetId: string): Promise<void> {
	const source = await open(sourcePath, "r");
	let headerBytes = Buffer.alloc(0);
	let offset = 0;
	try {
		while (headerBytes.byteLength <= MAX_HEADER_BYTES) {
			const chunk = Buffer.alloc(Math.min(4096, MAX_HEADER_BYTES + 1 - headerBytes.byteLength));
			const { bytesRead } = await source.read(chunk, 0, chunk.byteLength, offset);
			if (bytesRead === 0) break;
			headerBytes = Buffer.concat([headerBytes, chunk.subarray(0, bytesRead)]);
			const newline = headerBytes.indexOf(0x0a);
			if (newline >= 0) { offset = newline + 1; headerBytes = headerBytes.subarray(0, newline); break; }
			offset += bytesRead;
		}
	} finally { await source.close(); }
	if (offset === 0 || headerBytes.byteLength > MAX_HEADER_BYTES) throw new Error("Legacy Session header is missing or exceeds 64 KiB");
	let header: Record<string, unknown>;
	try { header = JSON.parse(headerBytes.toString("utf8")) as Record<string, unknown>; }
	catch { throw new Error("Legacy Session header is not valid JSON"); }
	if (header.type !== "session" || header.id !== expectedSourceId || typeof header.cwd !== "string" || typeof header.timestamp !== "string") throw new Error("Legacy Session header does not match the selected Session identity");
	const target = await open(targetPath, "wx", 0o600);
	try { await target.writeFile(`${JSON.stringify({ ...header, id: targetId })}\n`, "utf8"); await target.sync(); }
	finally { await target.close(); }
	await pipeline(createReadStream(sourcePath, { start: offset }), createWriteStream(targetPath, { flags: "a", mode: 0o600 }));
	const completed = await open(targetPath, "r+");
	try { await completed.sync(); } finally { await completed.close(); }
}

async function digestFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
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

async function fsyncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try { await directory.sync(); } finally { await directory.close(); }
}

function validateSource(source: BeeMaxRuntimeSource): void {
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
	try { await stat(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

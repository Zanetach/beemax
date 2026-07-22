import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThruveraRuntimeSource } from "./runtime.ts";
import { sessionOwnerKey } from "./session-coordinator.ts";
import { responsibilityOwnerKeys } from "./agent-scope.ts";

export interface SavedSessionChoice {
	threadId?: string;
	lastUsedAt: number;
	preferences: SessionPreferences;
}

/** Channel-neutral user choices associated with a conversation, not transcript content. */
export interface SessionPreferences {
	reasoningDisplay?: "off" | "summary" | "raw";
	detailsDisplay?: "hidden" | "collapsed" | "expanded";
}

export interface StoredSessionChoice extends SavedSessionChoice { owner: string; }

export interface SessionCatalogOwnershipReceipt {
	canonicalKey: string;
	before?: StoredSessionChoice;
	after?: StoredSessionChoice;
}

/**
 * Content-free, profile-local discovery index. AgentSession/Pi remains the
 * transcript authority; the Core runtime owns how channels discover choices.
 */
export class SessionCatalog<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> {
	private readonly path: string;
	private readonly records = new Map<string, StoredSessionChoice>();
	private loading?: Promise<void>;
	private writes?: Promise<void>;
	private writeGeneration = 0;
	private readonly limit: number;

	static forAgentDir<Source extends ThruveraRuntimeSource>(agentDir: string): SessionCatalog<Source> {
		return new SessionCatalog(join(agentDir, "sessions", "beemax-session-index.json"));
	}

	constructor(path: string, limit = 2_000) { this.path = path; this.limit = Math.max(100, Math.min(limit, 20_000)); }

	async list(source: Source): Promise<SavedSessionChoice[]> {
		await this.ready();
		const owners = new Set(ownerKeys(source));
		return [...this.records.values()].filter((record) => owners.has(record.owner)).map(({ threadId, lastUsedAt, preferences }) => ({ threadId, lastUsedAt, preferences: { ...preferences } })).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
	}

	async has(source: Source): Promise<boolean> {
		await this.ready();
		return recordKeys(source).some((key) => this.records.has(key));
	}

	async touch(source: Source): Promise<void> {
		await this.ready();
		const existing = firstRecord(this.records, recordKeys(source));
		this.records.set(recordKey(source), { owner: sessionOwnerKey(source), threadId: source.threadId, lastUsedAt: Date.now(), preferences: existing?.preferences ?? {} });
		this.prune();
		await this.persist();
	}

	async preferences(source: Source): Promise<SessionPreferences> {
		await this.ready();
		return { ...(firstRecord(this.records, recordKeys(source))?.preferences ?? {}) };
	}

	async updatePreferences(source: Source, preferences: SessionPreferences): Promise<void> {
		await this.ready();
		const existing = firstRecord(this.records, recordKeys(source));
		this.records.set(recordKey(source), {
			owner: sessionOwnerKey(source), threadId: source.threadId, lastUsedAt: existing?.lastUsedAt ?? Date.now(),
			preferences: { ...existing?.preferences, ...preferences },
		});
		this.prune();
		await this.persist();
	}

	/** Prepares a bounded, content-free receipt for moving legacy discovery metadata to the canonical Conversation owner. */
	async prepareOwnershipMigration(source: Source): Promise<SessionCatalogOwnershipReceipt> {
		await this.ready();
		const canonicalKey = recordKey(source);
		const before = cloneRecord(this.records.get(canonicalKey));
		const legacy = firstRecord(this.records, recordKeys(source).filter((key) => key !== canonicalKey));
		const after = before ?? (legacy ? { ...cloneRecord(legacy)!, owner: sessionOwnerKey(source) } : undefined);
		return { canonicalKey, before, after };
	}

	async applyOwnershipMigration(source: Source, receipt: SessionCatalogOwnershipReceipt): Promise<void> {
		await this.ready();
		this.validateOwnershipReceipt(source, receipt);
		if (!sameRecord(this.records.get(receipt.canonicalKey), receipt.before)) throw new Error("Session Catalog changed while ownership migration was prepared");
		if (receipt.after) this.records.set(receipt.canonicalKey, cloneRecord(receipt.after)!);
		if (!sameRecord(receipt.before, receipt.after)) await this.persist();
	}

	async rollbackOwnershipMigration(source: Source, receipt: SessionCatalogOwnershipReceipt): Promise<void> {
		await this.ready();
		this.validateOwnershipReceipt(source, receipt);
		if (!sameRecord(this.records.get(receipt.canonicalKey), receipt.after)) throw new Error("Session Catalog changed after ownership migration");
		if (receipt.before) this.records.set(receipt.canonicalKey, cloneRecord(receipt.before)!); else this.records.delete(receipt.canonicalKey);
		if (!sameRecord(receipt.before, receipt.after)) await this.persist();
	}

	async reconcileOwnershipRollback(source: Source, receipt: SessionCatalogOwnershipReceipt): Promise<void> {
		await this.ready();
		this.validateOwnershipReceipt(source, receipt);
		const current = this.records.get(receipt.canonicalKey);
		if (sameRecord(current, receipt.before)) return;
		if (!sameRecord(current, receipt.after)) throw new Error("Session Catalog changed after ownership migration");
		if (receipt.before) this.records.set(receipt.canonicalKey, cloneRecord(receipt.before)!); else this.records.delete(receipt.canonicalKey);
		if (!sameRecord(receipt.before, receipt.after)) await this.persist();
	}

	private validateOwnershipReceipt(source: Source, receipt: SessionCatalogOwnershipReceipt): void {
		if (receipt.canonicalKey !== recordKey(source)) throw new Error("Session Catalog ownership receipt targets a different Conversation");
		if (receipt.before && !isRecord(receipt.before)) throw new Error("Session Catalog ownership receipt has an invalid previous record");
		if (receipt.after && (!isRecord(receipt.after) || receipt.after.owner !== sessionOwnerKey(source))) throw new Error("Session Catalog ownership receipt has an invalid canonical record");
	}

	private async persist(): Promise<void> {
		this.writeGeneration++;
		this.writes ??= this.flushWrites().finally(() => { this.writes = undefined; });
		await this.writes;
	}
	private async flushWrites(): Promise<void> {
		await Promise.resolve();
		let persisted = 0;
		while (persisted < this.writeGeneration) {
			const target = this.writeGeneration;
			const snapshot = JSON.stringify([...this.records.values()]);
			await mkdir(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
			await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.path);
			persisted = target;
		}
	}
	private prune(): void {
		if (this.records.size <= this.limit) return;
		const oldest = [...this.records.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt).slice(0, this.records.size - this.limit);
		for (const [key] of oldest) this.records.delete(key);
	}

	private async ready(): Promise<void> {
		this.loading ??= this.load();
		await this.loading;
	}
	private async load(): Promise<void> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
			if (!Array.isArray(parsed)) return;
			for (const candidate of parsed) if (isRecord(candidate)) this.records.set(`${candidate.owner}:${candidate.threadId ?? ""}`, { ...candidate, preferences: candidate.preferences ?? {} });
			this.prune();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[thruvera] unable to read session index: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function recordKey(source: ThruveraRuntimeSource): string { return `${sessionOwnerKey(source)}:${source.threadId ?? ""}`; }
function ownerKeys(source: ThruveraRuntimeSource): string[] { return [...new Set([sessionOwnerKey(source), ...responsibilityOwnerKeys(source)])]; }
function recordKeys(source: ThruveraRuntimeSource): string[] { return ownerKeys(source).map((owner) => `${owner}:${source.threadId ?? ""}`); }
function firstRecord(records: Map<string, StoredSessionChoice>, keys: string[]): StoredSessionChoice | undefined {
	for (const key of keys) { const record = records.get(key); if (record) return record; }
	return undefined;
}
function cloneRecord(record: StoredSessionChoice | undefined): StoredSessionChoice | undefined {
	return record ? { ...record, preferences: { ...record.preferences } } : undefined;
}
function sameRecord(left: StoredSessionChoice | undefined, right: StoredSessionChoice | undefined): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
function isRecord(value: unknown): value is StoredSessionChoice {
	return typeof value === "object" && value !== null
		&& "owner" in value && typeof value.owner === "string"
		&& (!("threadId" in value) || value.threadId === undefined || typeof value.threadId === "string")
		&& "lastUsedAt" in value && typeof value.lastUsedAt === "number" && Number.isFinite(value.lastUsedAt)
		&& (!("preferences" in value) || isPreferences(value.preferences));
}
function isPreferences(value: unknown): value is SessionPreferences {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (candidate.reasoningDisplay === undefined || candidate.reasoningDisplay === "off" || candidate.reasoningDisplay === "summary" || candidate.reasoningDisplay === "raw")
		&& (candidate.detailsDisplay === undefined || candidate.detailsDisplay === "hidden" || candidate.detailsDisplay === "collapsed" || candidate.detailsDisplay === "expanded");
}

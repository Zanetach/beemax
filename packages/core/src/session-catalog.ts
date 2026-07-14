import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
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

interface StoredSessionChoice extends SavedSessionChoice { owner: string; }

/**
 * Content-free, profile-local discovery index. AgentSession/Pi remains the
 * transcript authority; the Core runtime owns how channels discover choices.
 */
export class SessionCatalog<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	private readonly path: string;
	private readonly records = new Map<string, StoredSessionChoice>();
	private loading?: Promise<void>;
	private writes?: Promise<void>;
	private writeGeneration = 0;
	private readonly limit: number;

	static forAgentDir<Source extends BeeMaxRuntimeSource>(agentDir: string): SessionCatalog<Source> {
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
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[beemax] unable to read session index: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function recordKey(source: BeeMaxRuntimeSource): string { return `${sessionOwnerKey(source)}:${source.threadId ?? ""}`; }
function ownerKeys(source: BeeMaxRuntimeSource): string[] { return [...new Set([sessionOwnerKey(source), ...responsibilityOwnerKeys(source)])]; }
function recordKeys(source: BeeMaxRuntimeSource): string[] { return ownerKeys(source).map((owner) => `${owner}:${source.threadId ?? ""}`); }
function firstRecord(records: Map<string, StoredSessionChoice>, keys: string[]): StoredSessionChoice | undefined {
	for (const key of keys) { const record = records.get(key); if (record) return record; }
	return undefined;
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

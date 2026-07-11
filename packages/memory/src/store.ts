/**
 * Long-term memory store backed by SQLite + FTS5.
 *
 * This is the BeeMax analogue of Hermes' memory_manager + FTS5 session search.
 * Two tables:
 *   - memories: curated facts/preferences the agent chose to remember.
 *   - exchanges: full user<->assistant turns, FTS5-indexed for cross-session
 *     recall ("what did I ask last week about X?").
 *
 * We start with FTS5 only (zero extra deps beyond better-sqlite3). Vector
 * embeddings can be layered on later without changing the recall API.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface MemoryRecord {
	id: string;
	platform: string;
	chatId: string;
	userId?: string;
	role: "user" | "assistant" | "memory";
	content: string;
	createdAt: number;
}

export interface RecallOptions {
	limit?: number;
	platform?: string;
	chatId?: string;
	userId?: string;
}

export interface MemoryCandidate extends MemoryRecord {
	status: "pending" | "promoted" | "rejected";
}

/** A durable, explainable statement about the user or their work. */
export interface MemoryClaim {
	id: string;
	platform: string;
	chatId: string;
	userId?: string;
	kind: "preference" | "fact" | "decision" | "goal" | "project" | "relationship" | "workflow";
	statement: string;
	confidence: number;
	stability: "low" | "medium" | "high";
	status: "active" | "superseded" | "rejected" | "archived";
	supersededBy?: string;
	firstObservedAt: number;
	lastConfirmedAt: number;
	expiresAt?: number;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryEvidence {
	id: string;
	claimId: string;
	kind: "conversation" | "manual" | "correction";
	eventId?: string;
	excerpt: string;
	createdAt: number;
}

export interface MemoryBrief {
	claims: MemoryClaim[];
	records: MemoryRecord[];
}

export interface ClaimInput {
	platform: string;
	chatId: string;
	userId?: string;
	kind: MemoryClaim["kind"];
	statement: string;
	confidence?: number;
	stability?: MemoryClaim["stability"];
	expiresAt?: number;
	evidence?: { kind?: MemoryEvidence["kind"]; eventId?: string; excerpt: string };
}

/** Durable, verifiable work state. Unlike chat memory, this is a current fact source. */
export interface TaskRecord {
	id: string;
	title: string;
	status: "open" | "in_progress" | "done" | "cancelled";
	evidence?: string;
	completedAt?: number;
	updatedAt: number;
}

export class MemoryStore {
	private readonly db: DatabaseType;

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
				content,
				content='memories',
				content_rowid='rowid',
				tokenize='unicode61 remove_diacritics 2'
			);

			CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
				INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
				INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
			END;

			CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(platform, chat_id);
			CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(platform, user_id);

			CREATE TABLE IF NOT EXISTS memory_candidates (
				id TEXT PRIMARY KEY,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				created_at INTEGER NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_candidates_fts USING fts5(
				content,
				content='memory_candidates',
				content_rowid='rowid',
				tokenize='unicode61 remove_diacritics 2'
			);
			CREATE TRIGGER IF NOT EXISTS memory_candidates_ai AFTER INSERT ON memory_candidates BEGIN
				INSERT INTO memory_candidates_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memory_candidates_ad AFTER DELETE ON memory_candidates BEGIN
				INSERT INTO memory_candidates_fts(memory_candidates_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memory_candidates_au AFTER UPDATE ON memory_candidates BEGIN
				INSERT INTO memory_candidates_fts(memory_candidates_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			END;
			CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope ON memory_candidates(platform, chat_id, user_id, status);

			CREATE TABLE IF NOT EXISTS task_ledger (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
				evidence TEXT,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS memory_events (
				id TEXT PRIMARY KEY,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				kind TEXT NOT NULL,
				content TEXT NOT NULL,
				occurred_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_events_scope_time ON memory_events(platform, user_id, chat_id, occurred_at DESC);

			CREATE TABLE IF NOT EXISTS memory_claims (
				id TEXT PRIMARY KEY,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				kind TEXT NOT NULL,
				statement TEXT NOT NULL,
				confidence REAL NOT NULL,
				stability TEXT NOT NULL,
				status TEXT NOT NULL,
				superseded_by TEXT REFERENCES memory_claims(id),
				first_observed_at INTEGER NOT NULL,
				last_confirmed_at INTEGER NOT NULL,
				expires_at INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_claims_fts USING fts5(
				statement,
				content='memory_claims',
				content_rowid='rowid',
				tokenize='unicode61 remove_diacritics 2'
			);
			CREATE TRIGGER IF NOT EXISTS memory_claims_ai AFTER INSERT ON memory_claims BEGIN
				INSERT INTO memory_claims_fts(rowid, statement) VALUES (new.rowid, new.statement);
			END;
			CREATE TRIGGER IF NOT EXISTS memory_claims_ad AFTER DELETE ON memory_claims BEGIN
				INSERT INTO memory_claims_fts(memory_claims_fts, rowid, statement) VALUES('delete', old.rowid, old.statement);
			END;
			CREATE TRIGGER IF NOT EXISTS memory_claims_au AFTER UPDATE ON memory_claims BEGIN
				INSERT INTO memory_claims_fts(memory_claims_fts, rowid, statement) VALUES('delete', old.rowid, old.statement);
				INSERT INTO memory_claims_fts(rowid, statement) VALUES (new.rowid, new.statement);
			END;
			CREATE INDEX IF NOT EXISTS idx_memory_claims_scope_status ON memory_claims(platform, user_id, chat_id, status, updated_at DESC);

			CREATE TABLE IF NOT EXISTS memory_evidence (
				id TEXT PRIMARY KEY,
				claim_id TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
				event_id TEXT REFERENCES memory_events(id),
				kind TEXT NOT NULL,
				excerpt TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_evidence_claim ON memory_evidence(claim_id, created_at DESC);
		`);
		this.addColumnIfMissing("memory_claims", "superseded_by", "TEXT REFERENCES memory_claims(id)");
		this.addColumnIfMissing("memory_evidence", "event_id", "TEXT REFERENCES memory_events(id)");
	}

	private addColumnIfMissing(table: string, column: string, definition: string): void {
		const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
		if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}

	/** Persist an immutable source record. It is evidence, not an inferred user fact. */
	recordEvent(record: { platform: string; chatId: string; userId?: string; kind: "user" | "assistant" | "import" | "feedback"; content: string; occurredAt?: number }): string {
		const id = cryptoRandom();
		const now = Date.now();
		this.db.prepare("INSERT INTO memory_events (id, platform, chat_id, user_id, kind, content, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(id, record.platform, record.chatId, record.userId ?? null, record.kind, record.content, record.occurredAt ?? now, now);
		return id;
	}

	/** Store or reinforce a named understanding with optional provenance. */
	upsertClaim(input: ClaimInput): MemoryClaim {
		const statement = input.statement.trim();
		if (!statement) throw new Error("Memory claim statement cannot be empty");
		const now = Date.now();
		const scope = [input.platform, input.userId ?? null, input.userId ?? null, input.chatId, input.kind, statement];
		const existing = this.db.prepare(`SELECT * FROM memory_claims
			WHERE platform = ? AND (user_id = ? OR (? IS NULL AND chat_id = ?)) AND kind = ? AND statement = ? AND status = 'active'
			ORDER BY updated_at DESC LIMIT 1`).get(...scope) as ClaimRow | undefined;
		let id: string;
		if (existing) {
			id = existing.id;
			this.db.prepare("UPDATE memory_claims SET confidence = MAX(confidence, ?), stability = ?, last_confirmed_at = ?, expires_at = ?, updated_at = ? WHERE id = ?")
				.run(clampConfidence(input.confidence ?? existing.confidence), strongerStability(existing.stability, input.stability ?? "low"), now, input.expiresAt ?? existing.expires_at, now, id);
		} else {
			id = cryptoRandom();
			this.db.prepare(`INSERT INTO memory_claims (id, platform, chat_id, user_id, kind, statement, confidence, stability, status, first_observed_at, last_confirmed_at, expires_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
				.run(id, input.platform, input.chatId, input.userId ?? null, input.kind, statement, clampConfidence(input.confidence ?? 0.7), input.stability ?? "low", now, now, input.expiresAt ?? null, now, now);
		}
		if (input.evidence?.excerpt.trim()) this.addEvidence(id, input.evidence.kind ?? "manual", input.evidence.excerpt, input.evidence.eventId);
		return this.getClaim(id)!;
	}

	correctClaim(id: string, replacement: Pick<ClaimInput, "statement" | "confidence" | "stability" | "expiresAt">, opts: Omit<RecallOptions, "limit"> = {}): MemoryClaim | undefined {
		const current = this.getClaim(id, opts);
		if (!current || current.status !== "active") return undefined;
		const eventId = this.recordEvent({ platform: current.platform, chatId: current.chatId, userId: current.userId, kind: "feedback", content: `Corrected claim ${id}: ${current.statement} -> ${replacement.statement}` });
		const corrected = this.upsertClaim({
			platform: current.platform, chatId: current.chatId, userId: current.userId, kind: current.kind,
			statement: replacement.statement, confidence: replacement.confidence ?? Math.max(current.confidence, 0.8),
			stability: replacement.stability ?? current.stability, expiresAt: replacement.expiresAt,
			evidence: { kind: "correction", eventId, excerpt: `Corrects claim ${id}: ${current.statement}` },
		});
		this.db.prepare("UPDATE memory_claims SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(corrected.id, Date.now(), id);
		return corrected;
	}

	listClaims(opts: RecallOptions & { status?: MemoryClaim["status"]; limit?: number } = {}): MemoryClaim[] {
		const { where, params } = scopeWhere(opts, "c");
		const status = opts.status ?? "active";
		const rows = this.db.prepare(`SELECT * FROM memory_claims c WHERE c.status = ? ${where} AND (c.expires_at IS NULL OR c.expires_at > ?)
			ORDER BY CASE c.stability WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, c.confidence DESC, c.updated_at DESC LIMIT ?`)
			.all(status, ...params, Date.now(), limitOf(opts.limit, 50)) as ClaimRow[];
		return rows.map(mapClaim);
	}

	recallBrief(query: string, opts: RecallOptions = {}): MemoryBrief {
		const match = toFtsQuery(query);
		const claims = match ? this.searchClaims(match, opts) : [];
		if (claims.length === 0 && query.trim()) claims.push(...this.searchClaimsLike(query.trim(), opts));
		return { claims, records: this.recall(query, { ...opts, limit: Math.min(opts.limit ?? 5, 8) }) };
	}

	explainClaim(id: string, opts: Omit<RecallOptions, "limit"> = {}): { claim: MemoryClaim; evidence: MemoryEvidence[] } | undefined {
		const claim = this.getClaim(id, opts);
		if (!claim) return undefined;
		const evidence = this.db.prepare("SELECT id, claim_id, event_id, kind, excerpt, created_at FROM memory_evidence WHERE claim_id = ? ORDER BY created_at DESC").all(id) as EvidenceRow[];
		return { claim, evidence: evidence.map(mapEvidence) };
	}

	/** Compile a small, deterministic long-term snapshot. The SQLite ledger remains the source of truth. */
	compileLongTermMemory(opts: RecallOptions & { maxChars?: number } = {}): string {
		const limit = Math.max(300, Math.min(opts.maxChars ?? 2200, 8000));
		const claims = this.listClaims({ ...opts, limit: 100 }).filter((claim) => claim.stability !== "low" || claim.confidence >= 0.85);
		const grouped = new Map<MemoryClaim["kind"], MemoryClaim[]>();
		for (const claim of claims) grouped.set(claim.kind, [...(grouped.get(claim.kind) ?? []), claim]);
		const labels: Record<MemoryClaim["kind"], string> = { preference: "沟通与偏好", fact: "稳定事实", decision: "关键决策", goal: "长期目标", project: "项目", relationship: "重要关系", workflow: "工作方式" };
		const lines = ["# BeeMax 长期记忆", "", "此文件由记忆账本生成；原始证据与可纠正版本保存在 SQLite。"];
		for (const kind of Object.keys(labels) as MemoryClaim["kind"][]) {
			const entries = grouped.get(kind);
			if (!entries?.length) continue;
			lines.push("", `## ${labels[kind]}`);
			for (const claim of entries) {
				const candidate = `- ${claim.statement}`;
				if ([...lines, candidate].join("\n").length > limit) return `${lines.join("\n")}\n\n[已按大小截断；请使用记忆检索获取更多内容]`;
				lines.push(candidate);
			}
		}
		return lines.join("\n");
	}

	private addEvidence(claimId: string, kind: MemoryEvidence["kind"], excerpt: string, eventId?: string): void {
		this.db.prepare("INSERT INTO memory_evidence (id, claim_id, event_id, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(cryptoRandom(), claimId, eventId ?? null, kind, excerpt.trim().slice(0, 4000), Date.now());
	}

	private getClaim(id: string, opts: Omit<RecallOptions, "limit"> = {}): MemoryClaim | undefined {
		const { where, params } = scopeWhere(opts, "c");
		const row = this.db.prepare(`SELECT * FROM memory_claims c WHERE c.id = ? ${where}`).get(id, ...params) as ClaimRow | undefined;
		return row ? mapClaim(row) : undefined;
	}

	private searchClaims(match: string, opts: RecallOptions): MemoryClaim[] {
		const { where, params } = scopeWhere(opts, "c");
		const rows = this.db.prepare(`SELECT c.* FROM memory_claims_fts f JOIN memory_claims c ON c.rowid = f.rowid
			WHERE memory_claims_fts MATCH ? AND c.status = 'active' ${where} AND (c.expires_at IS NULL OR c.expires_at > ?)
			ORDER BY rank, c.confidence DESC, c.updated_at DESC LIMIT ?`)
			.all(match, ...params, Date.now(), limitOf(opts.limit, 5)) as ClaimRow[];
		return rows.map(mapClaim);
	}

	private searchClaimsLike(query: string, opts: RecallOptions): MemoryClaim[] {
		const { where, params } = scopeWhere(opts, "c");
		const rows = this.db.prepare(`SELECT c.* FROM memory_claims c
			WHERE c.statement LIKE ? AND c.status = 'active' ${where} AND (c.expires_at IS NULL OR c.expires_at > ?)
			ORDER BY c.confidence DESC, c.updated_at DESC LIMIT ?`)
			.all(`%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, ...params, Date.now(), limitOf(opts.limit, 5)) as ClaimRow[];
		return rows.map(mapClaim);
	}

	remember(record: Omit<MemoryRecord, "id" | "createdAt">): string {
		const id = cryptoRandom();
		const createdAt = Date.now();
		this.db
			.prepare(
				"INSERT INTO memories (id, platform, chat_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(id, record.platform, record.chatId, record.userId ?? null, record.role, record.content, createdAt);
		return id;
	}

	/** Store a raw turn as a retrievable candidate, not as curated long-term memory. */
	recordCandidate(record: Omit<MemoryRecord, "id" | "createdAt" | "role"> & { role: "user" | "assistant" }): string {
		const existing = this.db.prepare(
			"SELECT id FROM memory_candidates WHERE platform = ? AND chat_id = ? AND user_id IS ? AND role = ? AND content = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
		).get(record.platform, record.chatId, record.userId ?? null, record.role, record.content) as { id: string } | undefined;
		if (existing) return existing.id;
		const id = cryptoRandom();
		this.db.prepare(
			"INSERT INTO memory_candidates (id, platform, chat_id, user_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
		).run(id, record.platform, record.chatId, record.userId ?? null, record.role, record.content, Date.now());
		return id;
	}

	/**
	 * Full-text recall. Returns matching rows ranked by FTS5 relevance, filtered
	 * to the requesting scope (same chat, or same user across chats).
	 */
	recall(query: string, opts: RecallOptions = {}): MemoryRecord[] {
		const match = toFtsQuery(query);
		if (!match) return [];
		const limit = Math.max(1, Math.min(opts.limit ?? 5, 100));
		const conditions: string[] = [];
		const params: unknown[] = [match];
		if (opts.platform) {
			conditions.push("m.platform = ?");
			params.push(opts.platform);
		}
		if (opts.chatId && opts.userId) {
			conditions.push("(m.chat_id = ? OR m.user_id = ?)");
			params.push(opts.chatId, opts.userId);
		} else if (opts.chatId) {
			conditions.push("m.chat_id = ?");
			params.push(opts.chatId);
		} else if (opts.userId) {
			conditions.push("m.user_id = ?");
			params.push(opts.userId);
		}
		const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";
		const rows = this.db
			.prepare(
				`SELECT m.id, m.platform, m.chat_id, m.user_id, m.role, m.content, m.created_at
				 FROM memories_fts f
				 JOIN memories m ON m.rowid = f.rowid
				 WHERE memories_fts MATCH ?
				 ${where}
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(...params, limit) as MemoryRow[];
		const records = rows.map(mapRow);
		const claims = this.searchClaims(match, opts);
		if (claims.length === 0) claims.push(...this.searchClaimsLike(query.trim(), opts));
		const claimRecords = claims.map((claim) => ({
			id: claim.id, platform: claim.platform, chatId: claim.chatId, userId: claim.userId,
			role: "memory" as const, content: claim.statement, createdAt: claim.updatedAt,
		}));
		return [...claimRecords, ...records].slice(0, limit);
	}

	list(opts: RecallOptions = {}): MemoryRecord[] {
		const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
		const conditions = ["role = 'memory'"];
		const params: unknown[] = [];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		else if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		const rows = this.db.prepare(
			`SELECT id, platform, chat_id, user_id, role, content, created_at
			 FROM memories WHERE ${conditions.join(" AND ")}
			 ORDER BY created_at DESC LIMIT ?`,
		).all(...params, limit) as MemoryRow[];
		return rows.map(mapRow);
	}

	listCandidates(opts: RecallOptions = {}): MemoryCandidate[] {
		const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
		const conditions = ["status = 'pending'"];
		const params: unknown[] = [];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		else if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		const rows = this.db.prepare(
			`SELECT id, platform, chat_id, user_id, role, content, status, created_at FROM memory_candidates WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
		).all(...params, limit) as CandidateRow[];
		return rows.map(mapCandidate);
	}

	promoteCandidate(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const conditions = ["id = ?", "status = 'pending'"];
		const params: unknown[] = [id];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		else if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		const row = this.db.prepare(
			`SELECT id, platform, chat_id, user_id, content FROM memory_candidates WHERE ${conditions.join(" AND ")}`,
		).get(...params) as Pick<MemoryRow, "id" | "platform" | "chat_id" | "user_id" | "content"> | undefined;
		if (!row) return false;
		const candidate = mapRow({ ...row, role: "memory", created_at: Date.now() });
		this.db.transaction(() => {
			this.remember({ platform: candidate.platform, chatId: candidate.chatId, userId: candidate.userId, role: "memory", content: candidate.content });
			this.db.prepare("UPDATE memory_candidates SET status = 'promoted' WHERE id = ?").run(id);
		})();
		return true;
	}

	rejectCandidate(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const conditions = ["id = ?", "status = 'pending'"];
		const params: unknown[] = [id];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		else if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		return this.db.prepare(`UPDATE memory_candidates SET status = 'rejected' WHERE ${conditions.join(" AND ")}`).run(...params).changes > 0;
	}

	stats(opts: Omit<RecallOptions, "limit"> = {}): { curated: number; pending: number; promoted: number; rejected: number } {
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		else if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const curatedWhere = ["role = 'memory'", ...conditions].join(" AND ");
		const curated = (this.db.prepare(`SELECT count(*) AS value FROM memories WHERE ${curatedWhere}`).get(...params) as { value: number }).value;
		const rows = this.db.prepare(`SELECT status, count(*) AS value FROM memory_candidates ${where} GROUP BY status`).all(...params) as Array<{ status: string; value: number }>;
		const result = { curated, pending: 0, promoted: 0, rejected: 0 };
		for (const row of rows) if (row.status in result) result[row.status as "pending" | "promoted" | "rejected"] = row.value;
		return result;
	}

	upsertTask(task: Pick<TaskRecord, "id" | "title" | "status"> & { evidence?: string; completedAt?: number }): void {
		const now = Date.now();
		const completedAt = task.status === "done" ? task.completedAt ?? now : null;
		this.db.prepare(`
			INSERT INTO task_ledger (id, title, status, evidence, completed_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				title = excluded.title,
				status = excluded.status,
				evidence = excluded.evidence,
				completed_at = CASE WHEN excluded.status = 'done' THEN COALESCE(task_ledger.completed_at, excluded.completed_at) ELSE NULL END,
				updated_at = excluded.updated_at
		`).run(task.id, task.title, task.status, task.evidence ?? null, completedAt, now);
	}

	listTasks(): TaskRecord[] {
		const rows = this.db.prepare("SELECT id, title, status, evidence, completed_at, updated_at FROM task_ledger ORDER BY updated_at DESC, id").all() as TaskRow[];
		return rows.map((row) => ({
			id: row.id,
			title: row.title,
			status: row.status as TaskRecord["status"],
			evidence: row.evidence ?? undefined,
			completedAt: row.completed_at ?? undefined,
			updatedAt: row.updated_at,
		}));
	}

	forget(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const conditions = ["id = ?", "role = 'memory'"];
		const params: unknown[] = [id];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		else if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		return this.db.prepare(`DELETE FROM memories WHERE ${conditions.join(" AND ")}`).run(...params).changes > 0;
	}

	close(): void {
		this.db.close();
	}

}

export async function backupSqliteDatabase(sourcePath: string, destinationPath: string): Promise<void> {
	const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
	try {
		await db.backup(destinationPath);
	} finally {
		db.close();
	}
}

export function verifySqliteDatabase(path: string): void {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const result = db.pragma("integrity_check", { simple: true });
		if (result !== "ok") throw new Error(`SQLite integrity check failed: ${String(result)}`);
	} finally {
		db.close();
	}
}

interface MemoryRow {
	id: string;
	platform: string;
	chat_id: string;
	user_id: string | null;
	role: string;
	content: string;
	created_at: number;
}

interface CandidateRow extends MemoryRow { status: MemoryCandidate["status"] }

interface TaskRow {
	id: string;
	title: string;
	status: string;
	evidence: string | null;
	completed_at: number | null;
	updated_at: number;
}

interface ClaimRow {
	id: string;
	platform: string;
	chat_id: string;
	user_id: string | null;
	kind: MemoryClaim["kind"];
	statement: string;
	confidence: number;
	stability: MemoryClaim["stability"];
	status: MemoryClaim["status"];
	superseded_by: string | null;
	first_observed_at: number;
	last_confirmed_at: number;
	expires_at: number | null;
	created_at: number;
	updated_at: number;
}

interface EvidenceRow {
	id: string;
	claim_id: string;
	event_id: string | null;
	kind: MemoryEvidence["kind"];
	excerpt: string;
	created_at: number;
}

function mapRow(row: MemoryRow): MemoryRecord {
	return {
		id: row.id,
		platform: row.platform,
		chatId: row.chat_id,
		userId: row.user_id ?? undefined,
		role: row.role as MemoryRecord["role"],
		content: row.content,
		createdAt: row.created_at,
	};
}

function mapCandidate(row: CandidateRow): MemoryCandidate {
	return { ...mapRow(row), status: row.status };
}

function mapClaim(row: ClaimRow): MemoryClaim {
	return {
		id: row.id, platform: row.platform, chatId: row.chat_id, userId: row.user_id ?? undefined,
		kind: row.kind, statement: row.statement, confidence: row.confidence, stability: row.stability,
		status: row.status, supersededBy: row.superseded_by ?? undefined, firstObservedAt: row.first_observed_at, lastConfirmedAt: row.last_confirmed_at,
		expiresAt: row.expires_at ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

function mapEvidence(row: EvidenceRow): MemoryEvidence {
	return { id: row.id, claimId: row.claim_id, eventId: row.event_id ?? undefined, kind: row.kind, excerpt: row.excerpt, createdAt: row.created_at };
}

function scopeWhere(opts: Omit<RecallOptions, "limit">, alias: string): { where: string; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];
	if (opts.platform) { conditions.push(`${alias}.platform = ?`); params.push(opts.platform); }
	if (opts.userId) { conditions.push(`${alias}.user_id = ?`); params.push(opts.userId); }
	else if (opts.chatId) { conditions.push(`${alias}.chat_id = ?`); params.push(opts.chatId); }
	return { where: conditions.length ? `AND ${conditions.join(" AND ")}` : "", params };
}

function clampConfidence(value: number): number { return Math.max(0, Math.min(1, value)); }
function strongerStability(a: MemoryClaim["stability"], b: MemoryClaim["stability"]): MemoryClaim["stability"] {
	const order = { low: 1, medium: 2, high: 3 } as const;
	return order[a] >= order[b] ? a : b;
}
function limitOf(value: number | undefined, fallback: number): number { return Math.max(1, Math.min(value ?? fallback, 100)); }

function toFtsQuery(query: string): string {
	return query.trim().split(/\s+/u).filter(Boolean)
		.map((token) => `"${token.replaceAll('"', '""')}"`)
		.join(" OR ");
}

function cryptoRandom(): string {
	// 16 random bytes -> 32 hex chars. Good enough as a unique row id.
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

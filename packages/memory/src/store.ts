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
import type { TaskDependency, TaskPlanQuery, TaskPlanRecord, TaskPlanTransition, TaskQuery, TaskRecord as RuntimeTaskRecord, TaskRunRecord, TaskRunTransition, TaskTransition } from "@beemax/core";

export const MEMORY_CLAIM_KINDS = ["preference", "fact", "decision", "goal", "project", "relationship", "workflow"] as const;
export type MemoryClaimKind = typeof MEMORY_CLAIM_KINDS[number];
export const MEMORY_CLAIM_KIND_LABELS: Record<MemoryClaimKind, string> = { preference: "沟通与偏好", fact: "稳定事实", decision: "关键决策", goal: "长期目标", project: "项目", relationship: "重要关系", workflow: "工作方式" };

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
	kind: MemoryClaimKind;
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
	event?: MemoryEvent;
	excerpt: string;
	createdAt: number;
}

export interface MemoryEvent {
	id: string;
	platform: string;
	chatId: string;
	userId?: string;
	kind: "user" | "assistant" | "import" | "feedback";
	content: string;
	occurredAt: number;
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
export interface TaskFactRecord {
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
				description TEXT,
				status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
				evidence TEXT,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS task_plans (
				id TEXT PRIMARY KEY,
				owner_key TEXT NOT NULL,
				title TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
				task_count INTEGER NOT NULL,
				succeeded INTEGER NOT NULL DEFAULT 0,
				failed INTEGER NOT NULL DEFAULT 0,
				cancelled INTEGER NOT NULL DEFAULT 0,
				verified INTEGER NOT NULL DEFAULT 0,
				corrective_attempts INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_task_plans_owner_created ON task_plans(owner_key, created_at DESC);
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				owner_key TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('objective', 'delegated', 'automation')),
				title TEXT NOT NULL,
				description TEXT,
				acceptance_criteria TEXT,
				recovery_policy TEXT NOT NULL DEFAULT 'never' CHECK (recovery_policy IN ('never', 'safe_retry')),
				idempotency_key TEXT,
				execution_scope TEXT,
				status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
				parent_id TEXT,
				plan_id TEXT,
				evidence TEXT,
				verification_status TEXT CHECK (verification_status IN ('pending', 'accepted', 'rejected')),
				corrective_attempts INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				result TEXT,
				error TEXT,
				updated_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_tasks_owner_created ON tasks(owner_key, created_at DESC);
			CREATE TABLE IF NOT EXISTS task_runs (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				executor TEXT NOT NULL CHECK (executor IN ('agent', 'subagent', 'automation')),
				status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
				started_at INTEGER NOT NULL,
				lease_expires_at INTEGER,
				finished_at INTEGER,
				output TEXT,
				error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_task_runs_task_started ON task_runs(task_id, started_at DESC);
			CREATE TABLE IF NOT EXISTS task_dependencies (
				task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				PRIMARY KEY (task_id, depends_on)
			);
			CREATE INDEX IF NOT EXISTS idx_task_dependencies_upstream ON task_dependencies(depends_on);

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
		this.addColumnIfMissing("tasks", "evidence", "TEXT");
		this.addColumnIfMissing("tasks", "description", "TEXT");
		this.addColumnIfMissing("tasks", "acceptance_criteria", "TEXT");
		this.addColumnIfMissing("tasks", "recovery_policy", "TEXT NOT NULL DEFAULT 'never'");
		this.addColumnIfMissing("tasks", "idempotency_key", "TEXT");
		this.addColumnIfMissing("tasks", "execution_scope", "TEXT");
		this.addColumnIfMissing("tasks", "plan_id", "TEXT");
		this.addColumnIfMissing("tasks", "verification_status", "TEXT");
		this.addColumnIfMissing("tasks", "corrective_attempts", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("tasks", "updated_at", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("task_runs", "lease_expires_at", "INTEGER");
		this.backfillTaskPlans();
		this.addColumnIfMissing("memory_claims", "superseded_by", "TEXT REFERENCES memory_claims(id)");
		this.addColumnIfMissing("memory_evidence", "event_id", "TEXT REFERENCES memory_events(id)");
		this.db.exec(`INSERT OR IGNORE INTO tasks (id, owner_key, kind, title, status, evidence, created_at, finished_at, updated_at)
			SELECT id, 'profile', 'objective', title,
				CASE status WHEN 'open' THEN 'pending' WHEN 'in_progress' THEN 'running' WHEN 'done' THEN 'succeeded' ELSE 'cancelled' END,
				evidence, updated_at, completed_at, updated_at FROM task_ledger`);
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

	latestEvent(opts: Omit<RecallOptions, "limit">, kind: MemoryEvent["kind"] = "user"): MemoryEvent | undefined {
		const { where, params } = scopeWhere(opts, "e");
		const row = this.db.prepare(`SELECT * FROM memory_events e WHERE e.kind = ? ${where} ORDER BY e.occurred_at DESC LIMIT 1`).get(kind, ...params) as EventRow | undefined;
		return row ? mapEvent(row) : undefined;
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
		if (input.evidence?.eventId && !this.eventMatchesScope(input.evidence.eventId, input)) throw new Error("Memory evidence event is outside this user scope");
		if (input.evidence?.excerpt.trim()) this.addEvidence(id, input.evidence.kind ?? "manual", input.evidence.excerpt, input.evidence.eventId);
		return this.getClaim(id)!;
	}

	correctClaim(id: string, replacement: Pick<ClaimInput, "statement" | "confidence" | "stability" | "expiresAt" | "evidence">, opts: Omit<RecallOptions, "limit"> = {}): MemoryClaim | undefined {
		const current = this.getClaim(id, opts);
		if (!current || current.status !== "active") return undefined;
		const evidence = replacement.evidence ?? { kind: "correction" as const, excerpt: `Corrects claim ${id}: ${current.statement}` };
		const corrected = this.upsertClaim({
			platform: current.platform, chatId: current.chatId, userId: current.userId, kind: current.kind,
			statement: replacement.statement, confidence: replacement.confidence ?? Math.max(current.confidence, 0.8),
			stability: replacement.stability ?? current.stability, expiresAt: replacement.expiresAt,
			evidence: { ...evidence, kind: "correction" },
		});
		this.db.prepare("UPDATE memory_claims SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(corrected.id, Date.now(), id);
		return corrected;
	}

	forgetClaim(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const { where, params } = scopeWhere(opts, "c");
		return this.db.prepare(`DELETE FROM memory_claims c WHERE c.id = ? ${where}`).run(id, ...params).changes > 0;
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
		const evidence = this.db.prepare(`SELECT v.id, v.claim_id, v.event_id, v.kind, v.excerpt, v.created_at,
			e.id AS event_id_value, e.platform AS event_platform, e.chat_id AS event_chat_id, e.user_id AS event_user_id, e.kind AS event_kind, e.content AS event_content, e.occurred_at AS event_occurred_at, e.created_at AS event_created_at
			FROM memory_evidence v LEFT JOIN memory_events e ON e.id = v.event_id WHERE v.claim_id = ? ORDER BY v.created_at DESC`).all(id) as EvidenceRow[];
		return { claim, evidence: evidence.map(mapEvidence) };
	}

	/** Compile a small, deterministic long-term snapshot. The SQLite ledger remains the source of truth. */
	compileLongTermMemory(opts: RecallOptions & { maxChars?: number } = {}): string {
		const limit = Math.max(300, Math.min(opts.maxChars ?? 2200, 8000));
		const claims = this.listClaims({ ...opts, limit: 100 }).filter((claim) => claim.stability !== "low" || claim.confidence >= 0.85);
		const grouped = new Map<MemoryClaim["kind"], MemoryClaim[]>();
		for (const claim of claims) grouped.set(claim.kind, [...(grouped.get(claim.kind) ?? []), claim]);
		const lines = ["# BeeMax 长期记忆", "", "此文件由记忆账本生成；原始证据与可纠正版本保存在 SQLite。"];
		for (const kind of MEMORY_CLAIM_KINDS) {
			const entries = grouped.get(kind);
			if (!entries?.length) continue;
			lines.push("", `## ${MEMORY_CLAIM_KIND_LABELS[kind]}`);
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

	private eventMatchesScope(eventId: string, input: Pick<ClaimInput, "platform" | "chatId" | "userId">): boolean {
		const row = this.db.prepare("SELECT id FROM memory_events WHERE id = ? AND platform = ? AND (user_id = ? OR (? IS NULL AND chat_id = ?))")
			.get(eventId, input.platform, input.userId ?? null, input.userId ?? null, input.chatId) as { id: string } | undefined;
		return Boolean(row);
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

	upsertTask(task: Pick<TaskFactRecord, "id" | "title" | "status"> & { evidence?: string; completedAt?: number }): void {
		const now = Date.now();
		const completedAt = task.status === "done" ? task.completedAt ?? now : null;
		this.db.prepare(`
			INSERT INTO tasks (id, owner_key, kind, title, status, evidence, created_at, finished_at, updated_at)
			VALUES (?, 'profile', 'objective', ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				title = excluded.title,
				status = excluded.status,
				evidence = excluded.evidence,
				finished_at = CASE WHEN excluded.status = 'succeeded' THEN COALESCE(tasks.finished_at, excluded.finished_at) ELSE NULL END,
				updated_at = excluded.updated_at
		`).run(task.id, task.title, legacyTaskStatus(task.status), task.evidence ?? null, now, completedAt, now);
	}

	listTasks(): TaskFactRecord[] {
		const rows = this.db.prepare("SELECT id, title, status, evidence, finished_at AS completed_at, updated_at FROM tasks WHERE kind = 'objective' ORDER BY updated_at DESC, id").all() as TaskRow[];
		return rows.map((row) => ({
			id: row.id,
			title: row.title,
			status: legacyTaskFactStatus(row.status),
			evidence: row.evidence ?? undefined,
			completedAt: row.completed_at ?? undefined,
			updatedAt: row.updated_at,
		}));
	}

	record(task: RuntimeTaskRecord): void {
		this.db.prepare(`INSERT INTO tasks (id, owner_key, kind, title, description, acceptance_criteria, recovery_policy, idempotency_key, execution_scope, status, parent_id, plan_id, evidence, verification_status, corrective_attempts, created_at, started_at, finished_at, result, error, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(task.id, task.ownerKey, task.kind, task.title, task.description ?? null, task.acceptanceCriteria ?? null, task.recoveryPolicy ?? "never", task.idempotencyKey ?? null, task.executionScope ? JSON.stringify(task.executionScope) : null, task.status, task.parentId ?? null, task.planId ?? null, task.evidence ?? null, task.verificationStatus ?? null, task.correctiveAttempts ?? 0, task.createdAt, task.startedAt ?? null, task.finishedAt ?? null, task.result ?? null, task.error ?? null, task.createdAt);
	}

	transition(id: string, change: TaskTransition): void {
		const result = this.db.prepare(`UPDATE tasks SET status = ?,
			started_at = CASE WHEN ? = 'pending' THEN NULL ELSE COALESCE(?, started_at) END,
			finished_at = CASE WHEN ? IN ('pending', 'running') THEN NULL ELSE COALESCE(?, finished_at) END,
			result = CASE WHEN ? IN ('pending', 'running') THEN NULL ELSE COALESCE(?, result) END,
			error = CASE WHEN ? IN ('running', 'succeeded') THEN NULL ELSE COALESCE(?, error) END,
			evidence = COALESCE(?, evidence),
			verification_status = COALESCE(?, verification_status),
			corrective_attempts = COALESCE(?, corrective_attempts),
			updated_at = ? WHERE id = ?`)
			.run(change.status, change.status, change.startedAt ?? null, change.status, change.finishedAt ?? null, change.status, change.result ?? null, change.status, change.error ?? null, change.evidence ?? null, change.verificationStatus ?? null, change.correctiveAttempts ?? null, Date.now(), id);
		if (result.changes !== 1) throw new Error(`Task not found: ${id}`);
	}

	recordRun(run: TaskRunRecord): void {
		this.db.prepare("INSERT INTO task_runs (id, task_id, executor, status, started_at, lease_expires_at, finished_at, output, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(run.id, run.taskId, run.executor, run.status, run.startedAt, run.leaseExpiresAt ?? null, run.finishedAt ?? null, run.output ?? null, run.error ?? null);
	}

	transitionRun(id: string, change: TaskRunTransition): void {
		const result = this.db.prepare("UPDATE task_runs SET status = ?, finished_at = COALESCE(?, finished_at), output = COALESCE(?, output), error = COALESCE(?, error) WHERE id = ?")
			.run(change.status, change.finishedAt ?? null, change.output ?? null, change.error ?? null, id);
		if (result.changes !== 1) throw new Error(`Task Run not found: ${id}`);
	}

	renewTaskRunLease(id: string, leaseExpiresAt: number): boolean {
		return this.db.prepare("UPDATE task_runs SET lease_expires_at = ? WHERE id = ? AND status = 'running'").run(leaseExpiresAt, id).changes === 1;
	}

	taskRuns(taskId: string): TaskRunRecord[] {
		return (this.db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC").all(taskId) as TaskRunRow[]).map(mapTaskRun);
	}

	queryTasks(query: TaskQuery): RuntimeTaskRecord[] {
		if (query.ownerKeys.length === 0) return [];
		const conditions = [`owner_key IN (${query.ownerKeys.map(() => "?").join(", ")})`];
		const params: unknown[] = [...query.ownerKeys];
		if (query.id) { conditions.push("id = ?"); params.push(query.id); }
		if (query.kinds?.length) { conditions.push(`kind IN (${query.kinds.map(() => "?").join(", ")})`); params.push(...query.kinds); }
		if (query.statuses?.length) { conditions.push(`status IN (${query.statuses.map(() => "?").join(", ")})`); params.push(...query.statuses); }
		if (query.planIds?.length) { conditions.push(`plan_id IN (${query.planIds.map(() => "?").join(", ")})`); params.push(...query.planIds); }
		params.push(limitOf(query.limit, 50));
		const rows = this.db.prepare(`SELECT * FROM tasks WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...params) as RuntimeTaskRow[];
		return rows.map(mapRuntimeTask);
	}

	recordPlan(tasks: RuntimeTaskRecord[], dependencies: TaskDependency[], plan?: TaskPlanRecord): void {
		this.db.transaction(() => {
			if (plan) this.db.prepare(`INSERT INTO task_plans (id, owner_key, title, status, task_count, succeeded, failed, cancelled, verified, corrective_attempts, created_at, started_at, finished_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(plan.id, plan.ownerKey, plan.title, plan.status, plan.taskCount, plan.succeeded, plan.failed, plan.cancelled, plan.verified, plan.correctiveAttempts, plan.createdAt, plan.startedAt ?? null, plan.finishedAt ?? null);
			for (const task of tasks) this.record(task);
			const insert = this.db.prepare("INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)");
			for (const edge of dependencies) insert.run(edge.taskId, edge.dependsOn);
		})();
	}

	transitionPlan(id: string, change: TaskPlanTransition): void {
		const update = this.db.prepare(`UPDATE task_plans SET status = ?, task_count = ?, succeeded = ?, failed = ?, cancelled = ?, verified = ?, corrective_attempts = ?,
			started_at = COALESCE(?, started_at), finished_at = CASE WHEN ? IN ('pending', 'running') THEN NULL ELSE COALESCE(?, finished_at) END WHERE id = ?`);
		let result = update.run(change.status, change.taskCount, change.succeeded, change.failed, change.cancelled, change.verified, change.correctiveAttempts, change.startedAt ?? null, change.status, change.finishedAt ?? null, id);
		if (result.changes !== 1) {
			this.backfillTaskPlans(id);
			result = update.run(change.status, change.taskCount, change.succeeded, change.failed, change.cancelled, change.verified, change.correctiveAttempts, change.startedAt ?? null, change.status, change.finishedAt ?? null, id);
		}
		if (result.changes !== 1) throw new Error(`Task Plan not found: ${id}`);
	}

	private backfillTaskPlans(id?: string): void {
		const statement = this.db.prepare(`INSERT OR IGNORE INTO task_plans (id, owner_key, title, status, task_count, succeeded, failed, cancelled, verified, corrective_attempts, created_at, started_at, finished_at)
			SELECT plan_id, owner_key, 'Task Plan',
				CASE WHEN SUM(status = 'failed') > 0 THEN 'failed' WHEN SUM(status = 'running') > 0 THEN 'running' WHEN SUM(status = 'pending') > 0 THEN 'pending' WHEN SUM(status = 'cancelled') > 0 THEN 'cancelled' ELSE 'succeeded' END,
				COUNT(*), SUM(status = 'succeeded'), SUM(status = 'failed'), SUM(status = 'cancelled'), COALESCE(SUM(verification_status = 'accepted'), 0), COALESCE(SUM(corrective_attempts), 0),
				MIN(created_at), MIN(started_at), CASE WHEN SUM(status IN ('pending', 'running')) = 0 THEN MAX(finished_at) ELSE NULL END
			FROM tasks WHERE ${id ? "plan_id = ?" : "plan_id IS NOT NULL"} GROUP BY plan_id, owner_key`);
		if (id) statement.run(id); else statement.run();
	}

	queryTaskPlans(query: TaskPlanQuery): TaskPlanRecord[] {
		if (!query.ownerKeys.length) return [];
		const conditions = [`owner_key IN (${query.ownerKeys.map(() => "?").join(", ")})`];
		const params: unknown[] = [...query.ownerKeys];
		if (query.id) { conditions.push("id = ?"); params.push(query.id); }
		if (query.statuses?.length) { conditions.push(`status IN (${query.statuses.map(() => "?").join(", ")})`); params.push(...query.statuses); }
		params.push(limitOf(query.limit, 50));
		return (this.db.prepare(`SELECT * FROM task_plans WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...params) as TaskPlanRow[]).map(mapTaskPlan);
	}

	taskDependencies(taskIds: string[]): TaskDependency[] {
		if (taskIds.length === 0) return [];
		return this.db.prepare(`SELECT task_id, depends_on FROM task_dependencies WHERE task_id IN (${taskIds.map(() => "?").join(", ")})`)
			.all(...taskIds).map((row) => ({ taskId: (row as { task_id: string }).task_id, dependsOn: (row as { depends_on: string }).depends_on }));
	}

	reconcileExpiredTaskRuns(now = Date.now()): { retried: number; failed: number } {
		return this.db.transaction(() => {
			const rows = this.db.prepare(`SELECT r.id AS run_id, r.task_id, t.recovery_policy, t.idempotency_key
				FROM task_runs r JOIN tasks t ON t.id = r.task_id
				WHERE r.status = 'running' AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at <= ?`).all(now) as Array<{ run_id: string; task_id: string; recovery_policy: string; idempotency_key: string | null }>;
			let retried = 0; let failed = 0;
			const reason = "Task Run interrupted after its Execution Lease expired";
			for (const row of rows) {
				this.db.prepare("UPDATE task_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'").run(now, reason, row.run_id);
				if (row.recovery_policy === "safe_retry" && row.idempotency_key) {
					const changed = this.db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, finished_at = NULL, result = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(reason, now, row.task_id).changes;
					retried += changed;
				} else {
					const changed = this.db.prepare("UPDATE tasks SET status = 'failed', finished_at = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(now, reason, now, row.task_id).changes;
					failed += changed;
				}
			}
			return { retried, failed };
		})();
	}

	recoveryCandidates(limit = 100): RuntimeTaskRecord[] {
		return (this.db.prepare(`SELECT * FROM tasks WHERE status = 'pending' AND recovery_policy = 'safe_retry'
			AND idempotency_key IS NOT NULL AND plan_id IS NOT NULL AND execution_scope IS NOT NULL
			ORDER BY updated_at, created_at LIMIT ?`).all(limitOf(limit, 100)) as RuntimeTaskRow[]).map(mapRuntimeTask);
	}

	prepareTaskPlanRetry(ownerKeys: string[], planId: string): number {
		if (!ownerKeys.length || !planId.trim()) return 0;
		const changed = this.db.prepare(`UPDATE tasks SET status = 'pending', started_at = NULL, finished_at = NULL, result = NULL, error = 'Manual Task Plan retry requested', updated_at = ?
			WHERE owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND plan_id = ? AND status = 'failed'
			AND recovery_policy = 'safe_retry' AND idempotency_key IS NOT NULL AND execution_scope IS NOT NULL`)
			.run(Date.now(), ...ownerKeys, planId).changes;
		if (changed) this.syncTaskPlan(planId, "pending");
		return changed;
	}

	cancelTaskPlan(ownerKeys: string[], planId: string, now = Date.now()): number {
		if (!ownerKeys.length || !planId.trim()) return 0;
		return this.db.transaction(() => {
			const ids = this.db.prepare(`SELECT id FROM tasks WHERE owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND plan_id = ? AND status IN ('pending', 'running')`).all(...ownerKeys, planId).map((row) => (row as { id: string }).id);
			if (!ids.length) return 0;
			const placeholders = ids.map(() => "?").join(", ");
			this.db.prepare(`UPDATE task_runs SET status = 'cancelled', finished_at = ?, error = 'Task Plan cancelled by user' WHERE task_id IN (${placeholders}) AND status = 'running'`).run(now, ...ids);
			const changed = this.db.prepare(`UPDATE tasks SET status = 'cancelled', finished_at = ?, error = 'Task Plan cancelled by user', updated_at = ? WHERE id IN (${placeholders}) AND status IN ('pending', 'running')`).run(now, now, ...ids).changes;
			if (changed) this.syncTaskPlan(planId, "cancelled", now);
			return changed;
		})();
	}

	private syncTaskPlan(id: string, status: TaskPlanRecord["status"], now = Date.now()): void {
		this.backfillTaskPlans(id);
		const counts = this.db.prepare(`SELECT COUNT(*) AS task_count, SUM(status = 'succeeded') AS succeeded, SUM(status = 'failed') AS failed,
			SUM(status = 'cancelled') AS cancelled, COALESCE(SUM(verification_status = 'accepted'), 0) AS verified,
			COALESCE(SUM(corrective_attempts), 0) AS corrective_attempts FROM tasks WHERE plan_id = ?`).get(id) as { task_count: number; succeeded: number; failed: number; cancelled: number; verified: number; corrective_attempts: number };
		this.transitionPlan(id, {
			status, taskCount: counts.task_count, succeeded: counts.succeeded, failed: counts.failed, cancelled: counts.cancelled,
			verified: counts.verified, correctiveAttempts: counts.corrective_attempts,
			...(status === "running" ? { startedAt: now } : {}), ...(["succeeded", "failed", "cancelled"].includes(status) ? { finishedAt: now } : {}),
		});
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
	event_id_value: string | null;
	event_platform: string | null;
	event_chat_id: string | null;
	event_user_id: string | null;
	event_kind: MemoryEvent["kind"] | null;
	event_content: string | null;
	event_occurred_at: number | null;
	event_created_at: number | null;
}

interface EventRow {
	id: string;
	platform: string;
	chat_id: string;
	user_id: string | null;
	kind: MemoryEvent["kind"];
	content: string;
	occurred_at: number;
	created_at: number;
}

interface RuntimeTaskRow {
	id: string; owner_key: string; kind: RuntimeTaskRecord["kind"]; title: string; description: string | null; acceptance_criteria: string | null; recovery_policy: RuntimeTaskRecord["recoveryPolicy"]; idempotency_key: string | null; execution_scope: string | null; status: RuntimeTaskRecord["status"];
	parent_id: string | null; plan_id: string | null; evidence: string | null; verification_status: RuntimeTaskRecord["verificationStatus"] | null; corrective_attempts: number; created_at: number; started_at: number | null; finished_at: number | null; result: string | null; error: string | null;
}

interface TaskRunRow {
	id: string; task_id: string; executor: TaskRunRecord["executor"]; status: TaskRunRecord["status"];
	started_at: number; lease_expires_at: number | null; finished_at: number | null; output: string | null; error: string | null;
}

interface TaskPlanRow {
	id: string; owner_key: string; title: string; status: TaskPlanRecord["status"];
	task_count: number; succeeded: number; failed: number; cancelled: number; verified: number; corrective_attempts: number;
	created_at: number; started_at: number | null; finished_at: number | null;
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
	const event = row.event_id_value && row.event_platform && row.event_chat_id && row.event_kind && row.event_content && row.event_occurred_at && row.event_created_at
		? { id: row.event_id_value, platform: row.event_platform, chatId: row.event_chat_id, userId: row.event_user_id ?? undefined, kind: row.event_kind, content: row.event_content, occurredAt: row.event_occurred_at, createdAt: row.event_created_at }
		: undefined;
	return { id: row.id, claimId: row.claim_id, eventId: row.event_id ?? undefined, kind: row.kind, excerpt: row.excerpt, createdAt: row.created_at, event };
}

function mapEvent(row: EventRow): MemoryEvent {
	return { id: row.id, platform: row.platform, chatId: row.chat_id, userId: row.user_id ?? undefined, kind: row.kind, content: row.content, occurredAt: row.occurred_at, createdAt: row.created_at };
}

function mapRuntimeTask(row: RuntimeTaskRow): RuntimeTaskRecord {
	const executionScope = parseExecutionScope(row.execution_scope);
	return {
		id: row.id, ownerKey: row.owner_key, kind: row.kind, title: row.title, status: row.status,
		createdAt: row.created_at,
		...(row.description === null ? {} : { description: row.description }),
		...(row.acceptance_criteria === null ? {} : { acceptanceCriteria: row.acceptance_criteria }),
		...(row.recovery_policy === "never" || row.recovery_policy === undefined ? {} : { recoveryPolicy: row.recovery_policy }),
		...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
		...(executionScope ? { executionScope } : {}),
		...(row.parent_id === null ? {} : { parentId: row.parent_id }),
		...(row.plan_id === null ? {} : { planId: row.plan_id }),
		...(row.evidence === null ? {} : { evidence: row.evidence }),
		...(row.verification_status === null ? {} : { verificationStatus: row.verification_status }),
		...(row.corrective_attempts ? { correctiveAttempts: row.corrective_attempts } : {}),
		...(row.started_at === null ? {} : { startedAt: row.started_at }),
		...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
		...(row.result === null ? {} : { result: row.result }),
		...(row.error === null ? {} : { error: row.error }),
	};
}

function parseExecutionScope(value: string | null): RuntimeTaskRecord["executionScope"] {
	if (!value) return undefined;
	try {
		const scope = JSON.parse(value) as RuntimeTaskRecord["executionScope"];
		return scope && typeof scope.platform === "string" && typeof scope.chatId === "string" && typeof scope.chatType === "string" ? scope : undefined;
	} catch { return undefined; }
}

function mapTaskRun(row: TaskRunRow): TaskRunRecord {
	return {
		id: row.id, taskId: row.task_id, executor: row.executor, status: row.status, startedAt: row.started_at,
		...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
		...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
		...(row.output === null ? {} : { output: row.output }),
		...(row.error === null ? {} : { error: row.error }),
	};
}

function mapTaskPlan(row: TaskPlanRow): TaskPlanRecord {
	return {
		id: row.id, ownerKey: row.owner_key, title: row.title, status: row.status, taskCount: row.task_count,
		succeeded: row.succeeded, failed: row.failed, cancelled: row.cancelled, verified: row.verified, correctiveAttempts: row.corrective_attempts,
		createdAt: row.created_at, ...(row.started_at === null ? {} : { startedAt: row.started_at }), ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
	};
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
function legacyTaskStatus(status: TaskFactRecord["status"]): RuntimeTaskRecord["status"] {
	if (status === "open") return "pending";
	if (status === "in_progress") return "running";
	if (status === "done") return "succeeded";
	return "cancelled";
}
function legacyTaskFactStatus(status: string): TaskFactRecord["status"] {
	if (status === "pending") return "open";
	if (status === "running") return "in_progress";
	if (status === "succeeded") return "done";
	return "cancelled";
}

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

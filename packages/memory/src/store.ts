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
import { containsCredentialMaterial, redactCredentialMaterial, type TaskCandidateVerificationResolution, type TaskDependency, type TaskPlanCompletionNotice, type TaskPlanQuery, type TaskPlanRecord, type TaskPlanTransition, type TaskQuery, type TaskRecord as RuntimeTaskRecord, type TaskRecoveryResult, type TaskRunRecord, type TaskRunTransition, type TaskTransition } from "@beemax/core";

export const MEMORY_CLAIM_KINDS = ["preference", "fact", "decision", "goal", "project", "relationship", "workflow"] as const;
export type MemoryClaimKind = typeof MEMORY_CLAIM_KINDS[number];
export const MEMORY_CLAIM_KIND_LABELS: Record<MemoryClaimKind, string> = { preference: "沟通与偏好", fact: "稳定事实", decision: "关键决策", goal: "长期目标", project: "项目", relationship: "重要关系", workflow: "工作方式" };

export interface MemoryRecord {
	id: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	role: "user" | "assistant" | "memory";
	content: string;
	createdAt: number;
	/** Provenance used by context assembly to keep unconfirmed evidence distinguishable from durable facts. */
	memoryType?: "curated" | "claim" | "candidate";
	confidence?: number;
}

export interface RecallOptions {
	profileId?: string;
	limit?: number;
	platform?: string;
	chatId?: string;
	userId?: string;
	threadId?: string;
	projectId?: string;
	organizationId?: string;
	subject?: { type: string; id: string };
	object?: { type: string; id: string };
	/** Pending conversation evidence is excluded unless the caller explicitly opts in. */
	includeCandidates?: boolean;
}

export interface MemoryCandidate extends MemoryRecord {
	status: "pending" | "promoted" | "rejected";
}

/** A durable, explainable statement about the user or their work. */
export interface MemoryClaim {
	profileId?: string;
	id: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	projectId?: string;
	organizationId?: string;
	kind: MemoryClaimKind;
	statement: string;
	confidence: number;
	stability: "low" | "medium" | "high";
	status: "candidate" | "active" | "superseded" | "conflicted" | "rejected" | "archived";
	subject?: { type: string; id: string };
	object?: { type: string; id: string };
	source?: { type: "message" | "document" | "meeting" | "tool" | "manual" | "import"; ref?: string };
	visibility: "private" | "conversation" | "team" | "organization";
	validFrom?: number;
	validUntil?: number;
	conflictsWith: string[];
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
	threadId?: string;
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
	profileId?: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	projectId?: string;
	organizationId?: string;
	kind: MemoryClaim["kind"];
	statement: string;
	confidence?: number;
	stability?: MemoryClaim["stability"];
	expiresAt?: number;
	subject?: MemoryClaim["subject"];
	object?: MemoryClaim["object"];
	source?: MemoryClaim["source"];
	visibility?: MemoryClaim["visibility"];
	validFrom?: number;
	validUntil?: number;
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
	private readonly profileId: string;

	constructor(dbPath: string, profileId = "default") {
		this.profileId = profileId;
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
				thread_id TEXT,
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
			CREATE INDEX IF NOT EXISTS idx_memories_scope_created ON memories(platform, chat_id, user_id, created_at DESC);

			CREATE TABLE IF NOT EXISTS memory_candidates (
				id TEXT PRIMARY KEY,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
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
			CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_created ON memory_candidates(platform, chat_id, user_id, created_at DESC);

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
				,paused_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_task_plans_owner_created ON task_plans(owner_key, created_at DESC);
			CREATE TABLE IF NOT EXISTS task_plan_execution_claims (
				plan_id TEXT PRIMARY KEY REFERENCES task_plans(id) ON DELETE CASCADE,
				owner_key TEXT NOT NULL,
				holder_id TEXT NOT NULL,
				lease_expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_task_plan_execution_claims_expiry ON task_plan_execution_claims(lease_expires_at);
			CREATE TABLE IF NOT EXISTS task_plan_completion_notices (
				id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, owner_key TEXT NOT NULL,
				platform TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT, thread_id TEXT,
				plan_status TEXT NOT NULL CHECK (plan_status IN ('succeeded', 'failed', 'cancelled')),
				title TEXT NOT NULL, task_count INTEGER NOT NULL, succeeded INTEGER NOT NULL,
				failed INTEGER NOT NULL, cancelled INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'delivered')), claim_token TEXT,
				attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, abandoned_at INTEGER, last_error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_task_plan_completion_notices_due ON task_plan_completion_notices(status, next_attempt_at);
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
				verification_outcome TEXT CHECK (verification_outcome IN ('pending', 'accepted', 'rejected', 'unavailable')),
				verification_feedback TEXT,
				verification_attempts INTEGER NOT NULL DEFAULT 0,
				verification_retry_at INTEGER,
				corrective_attempts INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				result TEXT,
				candidate_result TEXT,
				error TEXT,
				checkpoint TEXT,
				checkpoint_at INTEGER,
				routes TEXT,
				route_index INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_tasks_owner_created ON tasks(owner_key, created_at DESC);
			CREATE INDEX IF NOT EXISTS idx_tasks_owner_parent ON tasks(owner_key, parent_id);
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
				thread_id TEXT,
				kind TEXT NOT NULL,
				content TEXT NOT NULL,
				occurred_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_events_scope_time ON memory_events(platform, user_id, chat_id, occurred_at DESC);

			CREATE TABLE IF NOT EXISTS memory_claims (
				id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL DEFAULT 'default',
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
				project_id TEXT,
				organization_id TEXT,
				kind TEXT NOT NULL,
				statement TEXT NOT NULL,
				subject_type TEXT,
				subject_id TEXT,
				object_type TEXT,
				object_id TEXT,
				source_type TEXT,
				source_ref TEXT,
				visibility TEXT NOT NULL DEFAULT 'private',
				valid_from INTEGER,
				valid_until INTEGER,
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
			CREATE TABLE IF NOT EXISTS memory_claim_conflicts (
				claim_id TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
				conflicts_with TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (claim_id, conflicts_with),
				CHECK (claim_id <> conflicts_with)
			);
		`);
		this.addColumnIfMissing("tasks", "evidence", "TEXT");
		this.addColumnIfMissing("tasks", "description", "TEXT");
		this.addColumnIfMissing("tasks", "acceptance_criteria", "TEXT");
		this.addColumnIfMissing("tasks", "recovery_policy", "TEXT NOT NULL DEFAULT 'never'");
		this.addColumnIfMissing("tasks", "idempotency_key", "TEXT");
		this.addColumnIfMissing("tasks", "execution_scope", "TEXT");
		this.addColumnIfMissing("tasks", "plan_id", "TEXT");
		this.addColumnIfMissing("tasks", "verification_status", "TEXT");
		this.addColumnIfMissing("tasks", "verification_outcome", "TEXT");
		this.addColumnIfMissing("tasks", "verification_feedback", "TEXT");
		this.addColumnIfMissing("tasks", "verification_attempts", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("tasks", "verification_retry_at", "INTEGER");
		this.addColumnIfMissing("tasks", "candidate_result", "TEXT");
		this.addColumnIfMissing("tasks", "corrective_attempts", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("tasks", "updated_at", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("tasks", "checkpoint", "TEXT");
		this.addColumnIfMissing("tasks", "checkpoint_at", "INTEGER");
		this.addColumnIfMissing("tasks", "routes", "TEXT");
		this.addColumnIfMissing("tasks", "route_index", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("task_plans", "paused_at", "INTEGER");
		this.addColumnIfMissing("task_runs", "lease_expires_at", "INTEGER");
		this.addColumnIfMissing("task_plan_completion_notices", "claim_token", "TEXT");
		this.addColumnIfMissing("task_plan_completion_notices", "abandoned_at", "INTEGER");
		this.addColumnIfMissing("task_plan_completion_notices", "last_error", "TEXT");
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_verification_due ON tasks(verification_outcome, verification_retry_at)");
		this.backfillTaskPlans();
		this.addColumnIfMissing("memory_claims", "superseded_by", "TEXT REFERENCES memory_claims(id)");
		this.addColumnIfMissing("memories", "thread_id", "TEXT");
		this.addColumnIfMissing("memory_candidates", "thread_id", "TEXT");
		this.addColumnIfMissing("memory_events", "thread_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "thread_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "profile_id", "TEXT NOT NULL DEFAULT 'default'");
		this.addColumnIfMissing("memory_claims", "project_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "organization_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "subject_type", "TEXT");
		this.addColumnIfMissing("memory_claims", "subject_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "object_type", "TEXT");
		this.addColumnIfMissing("memory_claims", "object_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "source_type", "TEXT");
		this.addColumnIfMissing("memory_claims", "source_ref", "TEXT");
		this.addColumnIfMissing("memory_claims", "visibility", "TEXT NOT NULL DEFAULT 'private'");
		this.addColumnIfMissing("memory_claims", "valid_from", "INTEGER");
		this.addColumnIfMissing("memory_claims", "valid_until", "INTEGER");
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_memories_exact_scope ON memories(platform, chat_id, user_id, thread_id, created_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_candidates_exact_scope ON memory_candidates(platform, chat_id, user_id, thread_id, status, created_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_events_exact_scope ON memory_events(platform, chat_id, user_id, thread_id, occurred_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_claims_exact_scope ON memory_claims(profile_id, platform, chat_id, user_id, thread_id, status, valid_from, valid_until, updated_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_claims_object ON memory_claims(object_type, object_id, status, updated_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_claims_business_scope ON memory_claims(profile_id, organization_id, project_id, visibility, status, updated_at DESC);
		`);
		this.addColumnIfMissing("memory_evidence", "event_id", "TEXT REFERENCES memory_events(id)");
		this.db.exec("CREATE TABLE IF NOT EXISTS memory_store_identity (id INTEGER PRIMARY KEY CHECK (id = 1), profile_id TEXT NOT NULL)");
		this.db.prepare("INSERT OR IGNORE INTO memory_store_identity (id, profile_id) VALUES (1, ?)").run(this.profileId);
		const identity = this.db.prepare("SELECT profile_id FROM memory_store_identity WHERE id = 1").get() as { profile_id: string };
		if (identity.profile_id === "default" && this.profileId !== "default") {
			this.db.prepare("UPDATE memory_store_identity SET profile_id = ? WHERE id = 1 AND profile_id = 'default'").run(this.profileId);
			identity.profile_id = this.profileId;
		}
		if (identity.profile_id !== this.profileId) {
			this.db.close();
			throw new Error(`Memory database belongs to Profile '${identity.profile_id}', not '${this.profileId}'`);
		}
		this.db.prepare("UPDATE memory_claims SET profile_id = ? WHERE profile_id = 'default'").run(this.profileId);
		this.db.exec("UPDATE tasks SET verification_outcome = verification_status WHERE verification_outcome IS NULL AND verification_status IS NOT NULL");
		this.db.exec(`INSERT OR IGNORE INTO tasks (id, owner_key, kind, title, status, evidence, created_at, finished_at, updated_at)
			SELECT id, 'profile', 'objective', title,
				CASE status WHEN 'open' THEN 'pending' WHEN 'in_progress' THEN 'running' WHEN 'done' THEN 'succeeded' ELSE 'cancelled' END,
				evidence, updated_at, completed_at, updated_at FROM task_ledger`);
	}

	private addColumnIfMissing(table: string, column: string, definition: string): void {
		const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
		if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}

	/** Persist a source record as immutable evidence while retained; unreferenced raw events use a bounded per-conversation retention window. */
	recordEvent(record: { platform: string; chatId: string; userId?: string; threadId?: string; kind: "user" | "assistant" | "import" | "feedback"; content: string; occurredAt?: number }): string {
		const id = cryptoRandom();
		const now = Date.now();
		this.db.prepare("INSERT INTO memory_events (id, platform, chat_id, user_id, thread_id, kind, content, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(id, record.platform, record.chatId, record.userId ?? null, record.threadId ?? null, record.kind, record.content, record.occurredAt ?? now, now);
		this.db.prepare(`DELETE FROM memory_events WHERE platform = ? AND chat_id = ? AND user_id IS ? AND id NOT IN (SELECT event_id FROM memory_evidence WHERE event_id IS NOT NULL) AND id NOT IN
			(SELECT id FROM memory_events WHERE platform = ? AND chat_id = ? AND user_id IS ? ORDER BY occurred_at DESC LIMIT 5000)`)
			.run(record.platform, record.chatId, record.userId ?? null, record.platform, record.chatId, record.userId ?? null);
		return id;
	}

	latestEvent(opts: Omit<RecallOptions, "limit">, kind: MemoryEvent["kind"] = "user"): MemoryEvent | undefined {
		const { where, params } = scopeWhere(opts, "e");
		const row = this.db.prepare(`SELECT * FROM memory_events e WHERE e.kind = ? ${where} ORDER BY e.occurred_at DESC LIMIT 1`).get(kind, ...params) as EventRow | undefined;
		return row ? mapEvent(row) : undefined;
	}

	/** Store or reinforce a named understanding with optional provenance. */
	upsertClaim(input: ClaimInput): MemoryClaim {
		if ((input.profileId ?? this.profileId) !== this.profileId) throw new Error("Memory claim is outside this Profile store");
		const statement = input.statement.trim();
		if (!statement) throw new Error("Memory claim statement cannot be empty");
		const now = Date.now();
		const scope = [input.profileId ?? this.profileId, input.platform, input.chatId, input.userId ?? null, input.threadId ?? null, input.kind, statement,
			input.subject?.type ?? null, input.subject?.id ?? null, input.object?.type ?? null, input.object?.id ?? null,
			input.projectId ?? null, input.organizationId ?? null, input.visibility ?? "private"];
		const existing = this.db.prepare(`SELECT * FROM memory_claims
			WHERE profile_id = ? AND platform = ? AND chat_id = ? AND user_id IS ? AND thread_id IS ? AND kind = ? AND statement = ?
			AND subject_type IS ? AND subject_id IS ? AND object_type IS ? AND object_id IS ? AND status = 'active'
			AND project_id IS ? AND organization_id IS ? AND visibility = ?
			ORDER BY updated_at DESC LIMIT 1`).get(...scope) as ClaimRow | undefined;
		let id: string;
		if (existing) {
			id = existing.id;
			this.db.prepare(`UPDATE memory_claims SET confidence = MAX(confidence, ?), stability = ?, last_confirmed_at = ?,
				source_type = COALESCE(?, source_type), source_ref = COALESCE(?, source_ref), visibility = COALESCE(?, visibility),
				valid_from = COALESCE(?, valid_from), valid_until = COALESCE(?, valid_until), expires_at = COALESCE(?, expires_at), updated_at = ? WHERE id = ?`)
				.run(clampConfidence(input.confidence ?? existing.confidence), strongerStability(existing.stability, input.stability ?? "low"), now,
					input.source?.type ?? null, input.source?.ref ?? null, input.visibility ?? null, input.validFrom ?? null,
					input.validUntil ?? input.expiresAt ?? null, input.validUntil ?? input.expiresAt ?? null, now, id);
		} else {
			id = cryptoRandom();
			this.db.prepare(`INSERT INTO memory_claims (id, profile_id, platform, chat_id, user_id, thread_id, project_id, organization_id, kind, statement, subject_type, subject_id, object_type, object_id, source_type, source_ref, visibility, valid_from, valid_until, confidence, stability, status, first_observed_at, last_confirmed_at, expires_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
				.run(id, input.profileId ?? this.profileId, input.platform, input.chatId, input.userId ?? null, input.threadId ?? null, input.projectId ?? null, input.organizationId ?? null, input.kind, statement,
					input.subject?.type ?? null, input.subject?.id ?? null, input.object?.type ?? null, input.object?.id ?? null,
					input.source?.type ?? null, input.source?.ref ?? null, input.visibility ?? "private", input.validFrom ?? null,
					input.validUntil ?? input.expiresAt ?? null, clampConfidence(input.confidence ?? 0.7), input.stability ?? "low", now, now,
					input.validUntil ?? input.expiresAt ?? null, now, now);
		}
		if (input.evidence?.eventId && !this.eventMatchesScope(input.evidence.eventId, input)) throw new Error("Memory evidence event is outside this memory scope");
		if (input.evidence?.excerpt.trim()) this.addEvidence(id, input.evidence.kind ?? "manual", input.evidence.excerpt, input.evidence.eventId);
		return this.getClaim(id, input)!;
	}

	/** Preserve contradictory facts and their provenance instead of silently choosing one. */
	markClaimsConflicted(firstId: string, secondId: string, opts: Omit<RecallOptions, "limit">): boolean {
		if (firstId === secondId) return false;
		const first = this.getClaim(firstId, opts);
		const second = this.getClaim(secondId, opts);
		if (!first || !second || first.status === "superseded" || second.status === "superseded") return false;
		if (!sameClaimScope(first, second)) return false;
		const now = Date.now();
		this.db.transaction(() => {
			this.db.prepare("INSERT OR IGNORE INTO memory_claim_conflicts (claim_id, conflicts_with, created_at) VALUES (?, ?, ?), (?, ?, ?)")
				.run(firstId, secondId, now, secondId, firstId, now);
			this.db.prepare("UPDATE memory_claims SET status = 'conflicted', updated_at = ? WHERE id IN (?, ?)").run(now, firstId, secondId);
		})();
		return true;
	}

	correctClaim(id: string, replacement: Pick<ClaimInput, "statement" | "confidence" | "stability" | "expiresAt" | "evidence">, opts: Omit<RecallOptions, "limit"> = {}): MemoryClaim | undefined {
		const current = this.getClaim(id, opts);
		if (!current || current.status !== "active") return undefined;
		const evidence = replacement.evidence ?? { kind: "correction" as const, excerpt: `Corrects claim ${id}: ${current.statement}` };
		const corrected = this.upsertClaim({
			profileId: current.profileId, platform: current.platform, chatId: current.chatId, userId: current.userId, threadId: current.threadId,
			projectId: current.projectId, organizationId: current.organizationId, kind: current.kind,
			subject: current.subject, object: current.object, source: current.source, visibility: current.visibility,
			validFrom: current.validFrom, validUntil: replacement.expiresAt ?? current.validUntil,
			statement: replacement.statement, confidence: replacement.confidence ?? Math.max(current.confidence, 0.8),
			stability: replacement.stability ?? current.stability, expiresAt: replacement.expiresAt,
			evidence: { ...evidence, kind: "correction" },
		});
		this.db.prepare("UPDATE memory_claims SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(corrected.id, Date.now(), id);
		return corrected;
	}

	forgetClaim(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const access = claimReadWhere(opts, "c");
		return this.db.prepare(`DELETE FROM memory_claims c WHERE c.id = ? ${access.where}`).run(id, ...access.params).changes > 0;
	}

	listClaims(opts: RecallOptions & { status?: MemoryClaim["status"]; limit?: number } = {}): MemoryClaim[] {
		const access = claimReadWhere(opts, "c");
		const status = opts.status ?? "active";
		const rows = this.db.prepare(`SELECT * FROM memory_claims c WHERE c.status = ? ${access.where}
			AND (c.valid_from IS NULL OR c.valid_from <= ?) AND (c.valid_until IS NULL OR c.valid_until > ?)
			ORDER BY CASE c.stability WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, c.confidence DESC, c.updated_at DESC LIMIT ?`)
			.all(status, ...access.params, Date.now(), Date.now(), limitOf(opts.limit, 50)) as ClaimRow[];
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

	private eventMatchesScope(eventId: string, input: Pick<ClaimInput, "platform" | "chatId" | "userId" | "threadId">): boolean {
		const row = this.db.prepare("SELECT id FROM memory_events WHERE id = ? AND platform = ? AND chat_id = ? AND user_id IS ? AND thread_id IS ?")
			.get(eventId, input.platform, input.chatId, input.userId ?? null, input.threadId ?? null) as { id: string } | undefined;
		return Boolean(row);
	}

	private getClaim(id: string, opts: Omit<RecallOptions, "limit"> = {}): MemoryClaim | undefined {
		const access = claimReadWhere(opts, "c");
		const row = this.db.prepare(`SELECT * FROM memory_claims c WHERE c.id = ? ${access.where}`).get(id, ...access.params) as ClaimRow | undefined;
		if (!row) return undefined;
		const conflicts = this.db.prepare("SELECT conflicts_with FROM memory_claim_conflicts WHERE claim_id = ? ORDER BY conflicts_with").all(id) as Array<{ conflicts_with: string }>;
		return { ...mapClaim(row), conflictsWith: conflicts.map((item) => item.conflicts_with) };
	}

	private searchClaims(match: string, opts: RecallOptions): MemoryClaim[] {
		const access = claimReadWhere(opts, "c");
		const rows = this.db.prepare(`SELECT c.* FROM memory_claims_fts f JOIN memory_claims c ON c.rowid = f.rowid
			WHERE memory_claims_fts MATCH ? AND c.status IN ('active', 'conflicted') ${access.where}
			AND (c.valid_from IS NULL OR c.valid_from <= ?) AND (c.valid_until IS NULL OR c.valid_until > ?)
			ORDER BY rank, c.confidence DESC, c.updated_at DESC LIMIT ?`)
			.all(match, ...access.params, Date.now(), Date.now(), limitOf(opts.limit, 5)) as ClaimRow[];
		return rows.map(mapClaim);
	}

	private searchClaimsLike(query: string, opts: RecallOptions): MemoryClaim[] {
		const access = claimReadWhere(opts, "c");
		const rows = this.db.prepare(`SELECT c.* FROM memory_claims c
			WHERE c.statement LIKE ? AND c.status IN ('active', 'conflicted') ${access.where}
			AND (c.valid_from IS NULL OR c.valid_from <= ?) AND (c.valid_until IS NULL OR c.valid_until > ?)
			ORDER BY c.confidence DESC, c.updated_at DESC LIMIT ?`)
			.all(`%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, ...access.params, Date.now(), Date.now(), limitOf(opts.limit, 5)) as ClaimRow[];
		return rows.map(mapClaim);
	}

	remember(record: Omit<MemoryRecord, "id" | "createdAt">): string {
		const id = cryptoRandom();
		const createdAt = Date.now();
		this.db
			.prepare(
				"INSERT INTO memories (id, platform, chat_id, user_id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
				.run(id, record.platform, record.chatId, record.userId ?? null, record.threadId ?? null, record.role, record.content, createdAt);
		this.db.prepare(`DELETE FROM memories WHERE platform = ? AND chat_id = ? AND user_id IS ? AND id NOT IN
			(SELECT id FROM memories WHERE platform = ? AND chat_id = ? AND user_id IS ? ORDER BY created_at DESC LIMIT 5000)`)
			.run(record.platform, record.chatId, record.userId ?? null, record.platform, record.chatId, record.userId ?? null);
		return id;
	}

	/** Store a raw turn as a retrievable candidate, not as curated long-term memory. */
	recordCandidate(record: Omit<MemoryRecord, "id" | "createdAt" | "role"> & { role: "user" | "assistant" }): string {
		const existing = this.db.prepare(
			"SELECT id FROM memory_candidates WHERE platform = ? AND chat_id = ? AND user_id IS ? AND thread_id IS ? AND role = ? AND content = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
		).get(record.platform, record.chatId, record.userId ?? null, record.threadId ?? null, record.role, record.content) as { id: string } | undefined;
		if (existing) return existing.id;
		const id = cryptoRandom();
		this.db.prepare(
			"INSERT INTO memory_candidates (id, platform, chat_id, user_id, thread_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
		).run(id, record.platform, record.chatId, record.userId ?? null, record.threadId ?? null, record.role, record.content, Date.now());
		this.db.prepare(`DELETE FROM memory_candidates WHERE platform = ? AND chat_id = ? AND user_id IS ? AND id NOT IN
			(SELECT id FROM memory_candidates WHERE platform = ? AND chat_id = ? AND user_id IS ? ORDER BY created_at DESC LIMIT 5000)`)
			.run(record.platform, record.chatId, record.userId ?? null, record.platform, record.chatId, record.userId ?? null);
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
		if (opts.chatId) {
			conditions.push("m.chat_id = ?");
			params.push(opts.chatId);
		}
		if (opts.userId) {
			conditions.push("m.user_id = ?");
			params.push(opts.userId);
		}
		if (opts.chatId) {
			conditions.push("m.thread_id IS ?");
			params.push(opts.threadId ?? null);
		}
		const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";
		const ftsRows = this.db
			.prepare(
				`SELECT m.id, m.platform, m.chat_id, m.user_id, m.thread_id, m.role, m.content, m.created_at
				 FROM memories_fts f
				 JOIN memories m ON m.rowid = f.rowid
				 WHERE memories_fts MATCH ?
				 ${where}
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(...params, limit) as MemoryRow[];
		const likeRows = this.searchMemoryRowsLike(query, opts, limit);
		const records = uniqueById([...ftsRows, ...likeRows]).map((row) => ({ ...mapRow(row), memoryType: "curated" as const, confidence: 1 }));
		const claims = this.searchClaims(match, opts);
		if (claims.length === 0) claims.push(...this.searchClaimsLike(query.trim(), opts));
		const claimRecords = claims.map((claim) => ({
			id: claim.id, platform: claim.platform, chatId: claim.chatId, userId: claim.userId,
			role: "memory" as const, content: claim.statement, createdAt: claim.updatedAt, memoryType: "claim" as const, confidence: claim.confidence,
		}));
		const candidates = opts.includeCandidates ? this.searchCandidateRowsLike(query, opts, limit).map((row) => ({
			...mapRow(row), memoryType: "candidate" as const, confidence: 0.35,
		})) : [];
		return uniqueById([...claimRecords, ...records, ...candidates]).slice(0, limit);
	}

	private searchMemoryRowsLike(query: string, opts: RecallOptions, limit: number): MemoryRow[] {
		const lexical = lexicalWhere(query, "m.content");
		if (!lexical) return [];
		const scope = scopeWhere(opts, "m");
		return this.db.prepare(`SELECT m.id, m.platform, m.chat_id, m.user_id, m.thread_id, m.role, m.content, m.created_at
			FROM memories m WHERE ${lexical.where} ${scope.where} ORDER BY m.created_at DESC LIMIT ?`)
			.all(...lexical.params, ...scope.params, limit) as MemoryRow[];
	}

	private searchCandidateRowsLike(query: string, opts: RecallOptions, limit: number): MemoryRow[] {
		const lexical = lexicalWhere(query, "c.content");
		if (!lexical) return [];
		const scope = scopeWhere(opts, "c");
		return this.db.prepare(`SELECT c.id, c.platform, c.chat_id, c.user_id, c.thread_id, c.role, c.content, c.created_at
			FROM memory_candidates c WHERE c.status = 'pending' AND ${lexical.where} ${scope.where} ORDER BY c.created_at DESC LIMIT ?`)
			.all(...lexical.params, ...scope.params, limit) as MemoryRow[];
	}

	list(opts: RecallOptions = {}): MemoryRecord[] {
		const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
		const conditions = ["role = 'memory'"];
		const params: unknown[] = [];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
		const rows = this.db.prepare(
			`SELECT id, platform, chat_id, user_id, thread_id, role, content, created_at
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
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
		const rows = this.db.prepare(
			`SELECT id, platform, chat_id, user_id, thread_id, role, content, status, created_at FROM memory_candidates WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
		).all(...params, limit) as CandidateRow[];
		return rows.map(mapCandidate);
	}

	promoteCandidate(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const conditions = ["id = ?", "status = 'pending'"];
		const params: unknown[] = [id];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
		const row = this.db.prepare(
			`SELECT id, platform, chat_id, user_id, thread_id, content FROM memory_candidates WHERE ${conditions.join(" AND ")}`,
		).get(...params) as Pick<MemoryRow, "id" | "platform" | "chat_id" | "user_id" | "thread_id" | "content"> | undefined;
		if (!row) return false;
		const candidate = mapRow({ ...row, role: "memory", created_at: Date.now() });
		this.db.transaction(() => {
			this.remember({ platform: candidate.platform, chatId: candidate.chatId, userId: candidate.userId, threadId: candidate.threadId, role: "memory", content: candidate.content });
			this.db.prepare("UPDATE memory_candidates SET status = 'promoted' WHERE id = ?").run(id);
		})();
		return true;
	}

	rejectCandidate(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const conditions = ["id = ?", "status = 'pending'"];
		const params: unknown[] = [id];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
		return this.db.prepare(`UPDATE memory_candidates SET status = 'rejected' WHERE ${conditions.join(" AND ")}`).run(...params).changes > 0;
	}

	stats(opts: Omit<RecallOptions, "limit"> = {}): { curated: number; pending: number; promoted: number; rejected: number } {
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
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

	hasTask(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE id = ? LIMIT 1").get(id)); }

	record(task: RuntimeTaskRecord): void {
		this.db.prepare(`INSERT INTO tasks (id, owner_key, kind, title, description, acceptance_criteria, recovery_policy, idempotency_key, execution_scope, status, parent_id, plan_id, evidence, verification_outcome, verification_feedback, corrective_attempts, created_at, started_at, finished_at, result, candidate_result, error, checkpoint, checkpoint_at, routes, route_index, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(task.id, task.ownerKey, task.kind, task.title, safeTaskText(task.description), task.acceptanceCriteria ?? null, task.recoveryPolicy ?? "never", task.idempotencyKey ?? null, task.executionScope ? JSON.stringify(task.executionScope) : null, task.status, task.parentId ?? null, task.planId ?? null, safeTaskText(task.evidence), task.verificationStatus ?? null, safeTaskText(task.verificationFeedback), task.correctiveAttempts ?? 0, task.createdAt, task.startedAt ?? null, task.finishedAt ?? null, safeTaskText(task.result), safeTaskText(task.candidateResult), safeTaskText(task.error), task.checkpoint ?? null, task.checkpointAt ?? null, task.routes ? JSON.stringify(task.routes) : null, task.routeIndex ?? 0, task.createdAt);
	}

	transition(id: string, change: TaskTransition): boolean {
		const resultText = safeTaskText(change.result);
		const candidateResult = safeTaskText(change.candidateResult);
		const error = safeTaskText(change.error);
		const evidence = safeTaskText(change.evidence);
		const verificationFeedback = safeTaskText(change.verificationFeedback);
		const result = this.db.prepare(`UPDATE tasks SET status = ?,
			started_at = CASE WHEN ? = 'pending' THEN NULL ELSE COALESCE(?, started_at) END,
			finished_at = CASE WHEN ? IN ('pending', 'running') THEN NULL ELSE COALESCE(?, finished_at) END,
			result = CASE WHEN ? IN ('pending', 'running') THEN NULL ELSE COALESCE(?, result) END,
			candidate_result = CASE WHEN ? IN ('pending', 'running', 'succeeded') THEN NULL ELSE COALESCE(?, candidate_result) END,
			error = CASE WHEN ? IN ('running', 'succeeded') THEN NULL ELSE COALESCE(?, error) END,
			evidence = COALESCE(?, evidence),
			verification_outcome = COALESCE(?, verification_outcome),
			verification_feedback = CASE WHEN ? = 'succeeded' THEN NULL ELSE COALESCE(?, verification_feedback) END,
			corrective_attempts = COALESCE(?, corrective_attempts),
			updated_at = ? WHERE id = ? AND ((? = 'pending' AND status = 'running') OR (? = 'running' AND status = 'pending') OR (? IN ('succeeded', 'failed', 'cancelled') AND status IN ('pending', 'running')))`)
			.run(change.status, change.status, change.startedAt ?? null, change.status, change.finishedAt ?? null, change.status, resultText, change.status, candidateResult, change.status, error, evidence, change.verificationStatus ?? null, change.status, verificationFeedback, change.correctiveAttempts ?? null, Date.now(), id, change.status, change.status, change.status);
		return result.changes === 1;
	}

	retryObjective(ownerKey: string, id: string, now = Date.now()): boolean {
		return this.db.prepare(`UPDATE tasks SET status = 'running', started_at = ?, finished_at = NULL, result = NULL, error = NULL, updated_at = ?
			WHERE id = ? AND owner_key = ? AND kind = 'objective' AND status = 'failed'`).run(now, now, id, ownerKey).changes === 1;
	}

	cancelObjectives(ownerKey: string, now = Date.now()): number {
		return this.db.prepare("UPDATE tasks SET status = 'cancelled', finished_at = ?, error = 'Cancelled by user', updated_at = ? WHERE owner_key = ? AND kind = 'objective' AND status IN ('pending', 'running')").run(now, now, ownerKey).changes;
	}

	activeObjectivePlanIds(ownerKey: string): string[] {
		return (this.db.prepare(`SELECT DISTINCT child.plan_id FROM tasks child JOIN tasks objective ON objective.id = child.parent_id
			WHERE objective.owner_key = ? AND objective.kind = 'objective' AND objective.status IN ('pending', 'running') AND child.plan_id IS NOT NULL`).all(ownerKey) as Array<{ plan_id: string }>).map((row) => row.plan_id);
	}

	recordRun(run: TaskRunRecord): void {
		this.db.prepare("INSERT INTO task_runs (id, task_id, executor, status, started_at, lease_expires_at, finished_at, output, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(run.id, run.taskId, run.executor, run.status, run.startedAt, run.leaseExpiresAt ?? null, run.finishedAt ?? null, safeTaskText(run.output), safeTaskText(run.error));
	}

	transitionRun(id: string, change: TaskRunTransition): boolean {
		const result = this.db.prepare("UPDATE task_runs SET status = ?, finished_at = COALESCE(?, finished_at), output = COALESCE(?, output), error = COALESCE(?, error) WHERE id = ? AND status = 'running'")
			.run(change.status, change.finishedAt ?? null, safeTaskText(change.output), safeTaskText(change.error), id);
		return result.changes === 1;
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
		if (query.parentIds?.length) { conditions.push(`parent_id IN (${query.parentIds.map(() => "?").join(", ")})`); params.push(...query.parentIds); }
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

	transitionPlan(id: string, change: TaskPlanTransition): boolean {
		const update = this.db.prepare(`UPDATE task_plans SET status = ?, task_count = ?, succeeded = ?, failed = ?, cancelled = ?, verified = ?, corrective_attempts = ?,
			started_at = COALESCE(?, started_at), finished_at = CASE WHEN ? IN ('pending', 'running') THEN NULL ELSE COALESCE(?, finished_at) END
			WHERE id = ? AND ((? = 'running' AND status IN ('pending', 'running')) OR (? IN ('succeeded', 'failed', 'cancelled') AND status IN ('pending', 'running')))`);
		let result = update.run(change.status, change.taskCount, change.succeeded, change.failed, change.cancelled, change.verified, change.correctiveAttempts, change.startedAt ?? null, change.status, change.finishedAt ?? null, id, change.status, change.status);
		if (result.changes !== 1) {
			this.backfillTaskPlans(id);
			result = update.run(change.status, change.taskCount, change.succeeded, change.failed, change.cancelled, change.verified, change.correctiveAttempts, change.startedAt ?? null, change.status, change.finishedAt ?? null, id, change.status, change.status);
		}
		return result.changes === 1;
	}

	claimTaskPlanExecution(ownerKey: string, planId: string, holderId: string, leaseExpiresAt: number, now = Date.now()): boolean {
		if (!ownerKey.trim() || !planId.trim() || !holderId.trim() || leaseExpiresAt <= now) return false;
		this.backfillTaskPlans(planId);
		return this.db.prepare(`INSERT INTO task_plan_execution_claims (plan_id, owner_key, holder_id, lease_expires_at)
			SELECT id, owner_key, ?, ? FROM task_plans WHERE id = ? AND owner_key = ? AND status IN ('pending', 'running', 'failed')
			ON CONFLICT(plan_id) DO UPDATE SET owner_key = excluded.owner_key, holder_id = excluded.holder_id, lease_expires_at = excluded.lease_expires_at
			WHERE task_plan_execution_claims.owner_key = excluded.owner_key
				AND (task_plan_execution_claims.holder_id = excluded.holder_id OR task_plan_execution_claims.lease_expires_at <= ?)`)
			.run(holderId, leaseExpiresAt, planId, ownerKey, now).changes === 1;
	}

	renewTaskPlanExecution(ownerKey: string, planId: string, holderId: string, leaseExpiresAt: number, now = Date.now()): boolean {
		if (leaseExpiresAt <= now) return false;
		return this.db.prepare(`UPDATE task_plan_execution_claims SET lease_expires_at = ?
			WHERE plan_id = ? AND owner_key = ? AND holder_id = ? AND lease_expires_at > ?`)
			.run(leaseExpiresAt, planId, ownerKey, holderId, now).changes === 1;
	}

	releaseTaskPlanExecution(ownerKey: string, planId: string, holderId: string): boolean {
		return this.db.prepare("DELETE FROM task_plan_execution_claims WHERE plan_id = ? AND owner_key = ? AND holder_id = ?")
			.run(planId, ownerKey, holderId).changes === 1;
	}

	private backfillTaskPlans(id?: string): void {
		const statement = this.db.prepare(`INSERT OR IGNORE INTO task_plans (id, owner_key, title, status, task_count, succeeded, failed, cancelled, verified, corrective_attempts, created_at, started_at, finished_at)
			SELECT plan_id, owner_key, 'Task Plan',
				CASE WHEN SUM(status = 'failed') > 0 THEN 'failed' WHEN SUM(status = 'running') > 0 THEN 'running' WHEN SUM(status = 'pending') > 0 THEN 'pending' WHEN SUM(status = 'cancelled') > 0 THEN 'cancelled' ELSE 'succeeded' END,
				COUNT(*), SUM(status = 'succeeded'), SUM(status = 'failed'), SUM(status = 'cancelled'), COALESCE(SUM(verification_outcome = 'accepted'), 0), COALESCE(SUM(corrective_attempts), 0),
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

	checkpointTask(ownerKey: string, taskId: string, checkpoint: string, now = Date.now()): boolean {
		if (containsCredentialMaterial(checkpoint)) return false;
		return this.db.prepare("UPDATE tasks SET checkpoint = ?, checkpoint_at = ?, updated_at = ? WHERE id = ? AND owner_key = ? AND status = 'running'")
			.run(checkpoint.slice(0, 50_000), now, now, taskId, ownerKey).changes === 1;
	}

	advanceTaskRoute(ownerKey: string, taskId: string, error: string, now = Date.now()): boolean {
		return this.db.prepare(`UPDATE tasks SET status = 'pending', started_at = NULL, finished_at = NULL, error = ?, route_index = route_index + 1,
			verification_outcome = CASE WHEN acceptance_criteria IS NULL THEN NULL ELSE 'pending' END, verification_feedback = NULL,
			candidate_result = NULL, corrective_attempts = 0, updated_at = ?
			WHERE id = ? AND owner_key = ? AND status = 'running' AND routes IS NOT NULL AND route_index + 1 < json_array_length(routes)`)
			.run(redactCredentialMaterial(`Route failed; switching strategy: ${error}`.slice(0, 5_000)), now, taskId, ownerKey).changes === 1;
	}

	pauseTaskPlan(ownerKeys: string[], planId: string, now = Date.now()): boolean {
		if (!ownerKeys.length || !planId.trim()) return false;
		return this.db.prepare(`UPDATE task_plans SET paused_at = ? WHERE id = ? AND owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND status IN ('pending', 'running') AND paused_at IS NULL`)
			.run(now, planId, ...ownerKeys).changes === 1;
	}

	resumeTaskPlan(ownerKeys: string[], planId: string): boolean {
		if (!ownerKeys.length || !planId.trim()) return false;
		return this.db.prepare(`UPDATE task_plans SET paused_at = NULL WHERE id = ? AND owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND paused_at IS NOT NULL`)
			.run(planId, ...ownerKeys).changes === 1;
	}

	reconcileExpiredTaskRuns(now = Date.now()): TaskRecoveryResult {
		return this.db.transaction(() => {
			const rows = this.db.prepare(`SELECT r.id AS run_id, r.task_id, t.owner_key, t.plan_id, t.recovery_policy, t.idempotency_key
				FROM task_runs r JOIN tasks t ON t.id = r.task_id
				WHERE r.status = 'running' AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at <= ?`).all(now) as Array<{ run_id: string; task_id: string; owner_key: string; plan_id: string | null; recovery_policy: string; idempotency_key: string | null }>;
			let retried = 0; let failed = 0;
			const affectedPlans = new Map<string, { ownerKey: string; planId: string }>();
			const reason = "Task Run interrupted after its Execution Lease expired";
			for (const row of rows) {
				this.db.prepare("UPDATE task_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'").run(now, reason, row.run_id);
				if (row.recovery_policy === "safe_retry" && row.idempotency_key) {
					const changed = this.db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, finished_at = NULL, result = NULL, candidate_result = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(reason, now, row.task_id).changes;
					retried += changed;
				} else {
					const changed = this.db.prepare("UPDATE tasks SET status = 'failed', finished_at = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(now, reason, now, row.task_id).changes;
					failed += changed;
				}
				if (row.plan_id) affectedPlans.set(`${row.owner_key}\0${row.plan_id}`, { ownerKey: row.owner_key, planId: row.plan_id });
			}
			for (const { planId } of affectedPlans.values()) this.syncTaskPlanFromTasks(planId, now);
			return { retried, failed, affectedPlans: [...affectedPlans.values()].sort((left, right) => left.planId.localeCompare(right.planId)) };
		})();
	}

	recoveryCandidates(limit = 100, excludePlanIds: string[] = []): RuntimeTaskRecord[] {
		const excluded = [...new Set(excludePlanIds.filter((id) => id.trim()))];
		return (this.db.prepare(`SELECT tasks.* FROM tasks LEFT JOIN task_plans ON task_plans.id = tasks.plan_id WHERE tasks.status = 'pending' AND tasks.recovery_policy = 'safe_retry'
			AND idempotency_key IS NOT NULL AND plan_id IS NOT NULL AND execution_scope IS NOT NULL
			AND task_plans.paused_at IS NULL
			${excluded.length ? "AND plan_id NOT IN (SELECT value FROM json_each(?))" : ""}
			ORDER BY updated_at, created_at LIMIT ?`).all(...(excluded.length ? [JSON.stringify(excluded)] : []), limitOf(limit, 100)) as RuntimeTaskRow[]).map(mapRuntimeTask);
	}

	verificationCandidates(now = Date.now(), limit = 100, excludePlanIds: string[] = []): RuntimeTaskRecord[] {
		const excluded = [...new Set(excludePlanIds.filter((id) => id.trim()))];
		return (this.db.prepare(`SELECT tasks.* FROM tasks LEFT JOIN task_plans ON task_plans.id = tasks.plan_id WHERE tasks.status = 'failed' AND verification_outcome = 'unavailable'
			AND candidate_result IS NOT NULL AND acceptance_criteria IS NOT NULL AND plan_id IS NOT NULL
			AND task_plans.paused_at IS NULL
			AND (verification_retry_at IS NULL OR verification_retry_at <= ?)
			${excluded.length ? "AND plan_id NOT IN (SELECT value FROM json_each(?))" : ""}
			ORDER BY COALESCE(verification_retry_at, 0), updated_at, created_at LIMIT ?`)
			.all(now, ...(excluded.length ? [JSON.stringify(excluded)] : []), limitOf(limit, 100)) as RuntimeTaskRow[]).map(mapRuntimeTask);
	}

	deferCandidateVerification(ownerKeys: string[], taskId: string, now = Date.now()): boolean {
		if (!ownerKeys.length || !taskId.trim()) return false;
		const row = this.db.prepare(`SELECT verification_attempts FROM tasks WHERE id = ? AND owner_key IN (${ownerKeys.map(() => "?").join(", ")})
			AND status = 'failed' AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL`).get(taskId, ...ownerKeys) as { verification_attempts: number } | undefined;
		if (!row) return false;
		const attempts = Math.max(0, row.verification_attempts) + 1;
		const delay = Math.min(60 * 60_000, 60_000 * (2 ** Math.min(attempts - 1, 6)));
		return this.db.prepare(`UPDATE tasks SET verification_attempts = ?, verification_retry_at = ?, updated_at = ?
			WHERE id = ? AND status = 'failed' AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL AND verification_attempts = ?`)
			.run(attempts, now + delay, now, taskId, row.verification_attempts).changes === 1;
	}

	resolveCandidateVerification(ownerKeys: string[], taskId: string, resolution: TaskCandidateVerificationResolution, now = Date.now()): boolean {
		if (!ownerKeys.length || !taskId.trim()) return false;
		return this.db.transaction(() => {
			const row = this.db.prepare(`SELECT plan_id FROM tasks WHERE id = ? AND owner_key IN (${ownerKeys.map(() => "?").join(", ")})
				AND status = 'failed' AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL`).get(taskId, ...ownerKeys) as { plan_id: string | null } | undefined;
			if (!row) return false;
			const changed = resolution.accepted
				? this.db.prepare(`UPDATE tasks SET status = 'succeeded', result = candidate_result, candidate_result = NULL, evidence = COALESCE(?, evidence),
					verification_outcome = 'accepted', verification_feedback = NULL, verification_retry_at = NULL, error = NULL, finished_at = ?, updated_at = ?
					WHERE id = ? AND status = 'failed' AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL`).run(resolution.evidence ?? null, now, now, taskId).changes
				: this.db.prepare(`UPDATE tasks SET verification_outcome = 'rejected', verification_feedback = ?, verification_retry_at = NULL, error = ?, updated_at = ?
					WHERE id = ? AND status = 'failed' AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL`)
					.run(resolution.feedback.slice(0, 5_000), `Task verification rejected: ${resolution.feedback}`.slice(0, 5_000), now, taskId).changes;
			if (changed && row.plan_id) this.syncTaskPlanAfterCandidateVerification(row.plan_id, now);
			return changed === 1;
		})();
	}

	prepareTaskCorrections(maxCorrectiveAttempts: number, now = Date.now()): number {
		const budget = Math.max(0, Math.min(Math.trunc(maxCorrectiveAttempts), 2));
		if (!budget) return 0;
		return this.db.transaction(() => {
			const planIds = this.db.prepare(`SELECT DISTINCT plan_id FROM tasks WHERE status = 'failed' AND verification_outcome = 'rejected'
				AND verification_feedback IS NOT NULL AND candidate_result IS NOT NULL AND corrective_attempts < ?
				AND recovery_policy = 'safe_retry' AND idempotency_key IS NOT NULL AND execution_scope IS NOT NULL AND plan_id IS NOT NULL`)
				.all(budget).map((row) => (row as { plan_id: string }).plan_id);
			if (!planIds.length) return 0;
			const changed = this.db.prepare(`UPDATE tasks SET status = 'pending', started_at = NULL, finished_at = NULL, result = NULL,
				error = 'Automatic Corrective Attempt scheduled', updated_at = ?
				WHERE status = 'failed' AND verification_outcome = 'rejected' AND verification_feedback IS NOT NULL AND candidate_result IS NOT NULL
				AND corrective_attempts < ? AND recovery_policy = 'safe_retry' AND idempotency_key IS NOT NULL AND execution_scope IS NOT NULL AND plan_id IS NOT NULL`)
				.run(now, budget).changes;
			for (const planId of planIds) this.syncTaskPlan(planId, "pending", now, true);
			return changed;
		})();
	}

	enqueueTaskPlanCompletionNotice(ownerKey: string, planId: string, now = Date.now()): boolean {
		if (!ownerKey.trim() || !planId.trim()) return false;
		const plan = this.db.prepare(`SELECT * FROM task_plans WHERE id = ? AND owner_key = ? AND status IN ('succeeded', 'failed', 'cancelled')`).get(planId, ownerKey) as TaskPlanRow | undefined;
		if (!plan) return false;
		const scopeRow = this.db.prepare("SELECT execution_scope FROM tasks WHERE plan_id = ? AND owner_key = ? AND execution_scope IS NOT NULL ORDER BY created_at LIMIT 1").get(planId, ownerKey) as { execution_scope: string } | undefined;
		const target = parseExecutionScope(scopeRow?.execution_scope ?? null);
		if (!target?.platform || !target.chatId) return false;
		const id = `${plan.id}:${plan.finished_at ?? now}:${plan.status}`;
		return this.db.prepare(`INSERT OR IGNORE INTO task_plan_completion_notices
			(id, plan_id, owner_key, platform, chat_id, user_id, thread_id, plan_status, title, task_count, succeeded, failed, cancelled, status, attempts, next_attempt_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`)
			.run(id, plan.id, plan.owner_key, target.platform, target.chatId, target.userId ?? null, target.threadId ?? null, plan.status, plan.title, plan.task_count, plan.succeeded, plan.failed, plan.cancelled, now, now).changes === 1;
	}

	claimTaskPlanCompletionNotices(platform: string, now = Date.now(), limit = 10, leaseMs = 5 * 60_000): TaskPlanCompletionNotice[] {
		if (!platform.trim()) return [];
		return this.db.transaction(() => {
			const rows = this.db.prepare(`SELECT id FROM task_plan_completion_notices
				WHERE platform = ? AND (status = 'queued' OR status = 'delivering') AND next_attempt_at <= ?
				ORDER BY next_attempt_at, created_at LIMIT ?`).all(platform, now, limitOf(limit, 10)) as Array<{ id: string }>;
			for (const row of rows) this.db.prepare("UPDATE task_plan_completion_notices SET status = 'delivering', claim_token = ?, attempts = attempts + 1, next_attempt_at = ? WHERE id = ?").run(crypto.randomUUID(), now + Math.max(1, leaseMs), row.id);
			return rows.map((row) => mapTaskPlanCompletionNotice(this.db.prepare("SELECT * FROM task_plan_completion_notices WHERE id = ?").get(row.id) as TaskPlanCompletionNoticeRow));
		})();
	}

	completeTaskPlanCompletionNotice(id: string, claimToken: string): boolean {
		return this.db.prepare("UPDATE task_plan_completion_notices SET status = 'delivered', claim_token = NULL WHERE id = ? AND status = 'delivering' AND claim_token = ?").run(id, claimToken).changes === 1;
	}

	renewTaskPlanCompletionNotice(id: string, claimToken: string, leaseExpiresAt: number): boolean {
		return this.db.prepare("UPDATE task_plan_completion_notices SET next_attempt_at = ? WHERE id = ? AND status = 'delivering' AND claim_token = ?").run(leaseExpiresAt, id, claimToken).changes === 1;
	}

	abandonTaskPlanCompletionNotice(id: string, claimToken: string, error: string, now = Date.now()): boolean {
		return this.db.prepare("UPDATE task_plan_completion_notices SET status = 'delivered', claim_token = NULL, abandoned_at = ?, last_error = ? WHERE id = ? AND status = 'delivering' AND claim_token = ?")
			.run(now, redactCredentialMaterial(error).slice(0, 5_000), id, claimToken).changes === 1;
	}

	failTaskPlanCompletionNotice(id: string, claimToken: string, now = Date.now()): boolean {
		const row = this.db.prepare("SELECT attempts FROM task_plan_completion_notices WHERE id = ? AND status = 'delivering' AND claim_token = ?").get(id, claimToken) as { attempts: number } | undefined;
		if (!row) return false;
		const delay = Math.min(60 * 60_000, 30_000 * (2 ** Math.min(Math.max(0, row.attempts - 1), 7)));
		return this.db.prepare("UPDATE task_plan_completion_notices SET status = 'queued', claim_token = NULL, next_attempt_at = ? WHERE id = ? AND status = 'delivering' AND claim_token = ?").run(now + delay, id, claimToken).changes === 1;
	}

	prepareTaskPlanRetry(ownerKeys: string[], planId: string, maxCorrectiveAttempts = 1): number {
		if (!ownerKeys.length || !planId.trim()) return 0;
		const budget = Math.max(0, Math.min(Math.trunc(maxCorrectiveAttempts), 2));
		const changed = this.db.prepare(`UPDATE tasks SET status = 'pending', started_at = NULL, finished_at = NULL, result = NULL, candidate_result = CASE WHEN verification_outcome = 'rejected' THEN candidate_result ELSE NULL END, error = 'Manual Task Plan retry requested', updated_at = ?
			WHERE owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND plan_id = ? AND status = 'failed'
			AND COALESCE(verification_outcome, '') <> 'unavailable'
			AND (COALESCE(verification_outcome, '') <> 'rejected' OR corrective_attempts < ?)
			AND recovery_policy = 'safe_retry' AND idempotency_key IS NOT NULL AND execution_scope IS NOT NULL`)
			.run(Date.now(), ...ownerKeys, planId, budget).changes;
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

	failTaskPlan(ownerKeys: string[], planId: string, holderId: string, error: string, now = Date.now()): number {
		if (!ownerKeys.length || !planId.trim() || !holderId.trim()) return 0;
		return this.db.transaction(() => {
			const claim = this.db.prepare(`SELECT 1 FROM task_plan_execution_claims WHERE plan_id = ? AND owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND holder_id = ? AND lease_expires_at > ?`).get(planId, ...ownerKeys, holderId, now);
			if (!claim) return 0;
			const ids = this.db.prepare(`SELECT id FROM tasks WHERE owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND plan_id = ? AND status IN ('pending', 'running')`).all(...ownerKeys, planId).map((row) => (row as { id: string }).id);
			if (!ids.length) return 0;
			const placeholders = ids.map(() => "?").join(", ");
			const message = safeTaskText(error) ?? "Background Task Plan execution failed";
			this.db.prepare(`UPDATE task_runs SET status = 'failed', finished_at = ?, error = ? WHERE task_id IN (${placeholders}) AND status = 'running'`).run(now, message, ...ids);
			const changed = this.db.prepare(`UPDATE tasks SET status = 'failed', finished_at = ?, error = ?, updated_at = ? WHERE id IN (${placeholders}) AND status IN ('pending', 'running')`).run(now, message, now, ...ids).changes;
			if (changed) this.syncTaskPlan(planId, "failed", now);
			return changed;
		})();
	}

	private syncTaskPlanFromTasks(id: string, now: number): void {
		const statuses = this.db.prepare(`SELECT SUM(status = 'failed') AS failed, SUM(status = 'running') AS running,
			SUM(status = 'pending') AS pending, SUM(status = 'cancelled') AS cancelled FROM tasks WHERE plan_id = ?`).get(id) as { failed: number; running: number; pending: number; cancelled: number };
		const status: TaskPlanRecord["status"] = statuses.failed ? "failed" : statuses.running ? "running" : statuses.pending ? "pending" : statuses.cancelled ? "cancelled" : "succeeded";
		this.syncTaskPlan(id, status, now, status === "pending");
	}

	private syncTaskPlanAfterCandidateVerification(id: string, now: number): void {
		const counts = this.db.prepare(`SELECT COUNT(*) AS task_count, SUM(status = 'succeeded') AS succeeded, SUM(status = 'failed') AS failed,
			SUM(status = 'running') AS running, SUM(status = 'pending') AS pending, SUM(status = 'cancelled') AS cancelled,
			COALESCE(SUM(verification_outcome = 'accepted'), 0) AS verified, COALESCE(SUM(corrective_attempts), 0) AS corrective_attempts
			FROM tasks WHERE plan_id = ?`).get(id) as { task_count: number; succeeded: number; failed: number; running: number; pending: number; cancelled: number; verified: number; corrective_attempts: number };
		const status: TaskPlanRecord["status"] = counts.failed ? "failed" : counts.running ? "running" : counts.pending ? "pending" : counts.cancelled ? "cancelled" : "succeeded";
		this.db.prepare(`UPDATE task_plans SET status = ?, task_count = ?, succeeded = ?, failed = ?, cancelled = ?, verified = ?, corrective_attempts = ?,
			finished_at = CASE WHEN ? IN ('succeeded', 'failed', 'cancelled') THEN ? ELSE NULL END WHERE id = ? AND status = 'failed'`)
			.run(status, counts.task_count, counts.succeeded, counts.failed, counts.cancelled, counts.verified, counts.corrective_attempts, status, now, id);
	}

	private syncTaskPlan(id: string, status: TaskPlanRecord["status"], now = Date.now(), reopenRunning = false): void {
		this.backfillTaskPlans(id);
		const counts = this.db.prepare(`SELECT COUNT(*) AS task_count, SUM(status = 'succeeded') AS succeeded, SUM(status = 'failed') AS failed,
			SUM(status = 'cancelled') AS cancelled, COALESCE(SUM(verification_outcome = 'accepted'), 0) AS verified,
			COALESCE(SUM(corrective_attempts), 0) AS corrective_attempts FROM tasks WHERE plan_id = ?`).get(id) as { task_count: number; succeeded: number; failed: number; cancelled: number; verified: number; corrective_attempts: number };
		const change: TaskPlanTransition = {
			status, taskCount: counts.task_count, succeeded: counts.succeeded, failed: counts.failed, cancelled: counts.cancelled,
			verified: counts.verified, correctiveAttempts: counts.corrective_attempts,
			...(status === "running" ? { startedAt: now } : {}), ...(["succeeded", "failed", "cancelled"].includes(status) ? { finishedAt: now } : {}),
		};
		if (status === "pending") {
			this.db.prepare(`UPDATE task_plans SET status = 'pending', task_count = ?, succeeded = ?, failed = ?, cancelled = ?, verified = ?, corrective_attempts = ?, finished_at = NULL
				WHERE id = ? AND status IN (${reopenRunning ? "'pending', 'running', 'failed'" : "'pending', 'failed'"})`).run(change.taskCount, change.succeeded, change.failed, change.cancelled, change.verified, change.correctiveAttempts, id);
		} else this.transitionPlan(id, change);
	}

	forget(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const conditions = ["id = ?", "role = 'memory'"];
		const params: unknown[] = [id];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
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
	thread_id: string | null;
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
	profile_id: string;
	platform: string;
	chat_id: string;
	user_id: string | null;
	thread_id: string | null;
	project_id: string | null;
	organization_id: string | null;
	kind: MemoryClaim["kind"];
	statement: string;
	subject_type: string | null;
	subject_id: string | null;
	object_type: string | null;
	object_id: string | null;
	source_type: NonNullable<MemoryClaim["source"]>["type"] | null;
	source_ref: string | null;
	visibility: MemoryClaim["visibility"];
	valid_from: number | null;
	valid_until: number | null;
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
	thread_id: string | null;
	kind: MemoryEvent["kind"];
	content: string;
	occurred_at: number;
	created_at: number;
}

interface RuntimeTaskRow {
	id: string; owner_key: string; kind: RuntimeTaskRecord["kind"]; title: string; description: string | null; acceptance_criteria: string | null; recovery_policy: RuntimeTaskRecord["recoveryPolicy"]; idempotency_key: string | null; execution_scope: string | null; status: RuntimeTaskRecord["status"];
	parent_id: string | null; plan_id: string | null; evidence: string | null; verification_outcome: RuntimeTaskRecord["verificationStatus"] | null; verification_feedback: string | null; verification_attempts: number; verification_retry_at: number | null; corrective_attempts: number; created_at: number; started_at: number | null; finished_at: number | null; result: string | null; candidate_result: string | null; error: string | null;
	checkpoint: string | null; checkpoint_at: number | null; routes: string | null; route_index: number;
}

interface TaskRunRow {
	id: string; task_id: string; executor: TaskRunRecord["executor"]; status: TaskRunRecord["status"];
	started_at: number; lease_expires_at: number | null; finished_at: number | null; output: string | null; error: string | null;
}

interface TaskPlanRow {
	id: string; owner_key: string; title: string; status: TaskPlanRecord["status"];
	task_count: number; succeeded: number; failed: number; cancelled: number; verified: number; corrective_attempts: number;
	created_at: number; started_at: number | null; finished_at: number | null;
	paused_at: number | null;
}

interface TaskPlanCompletionNoticeRow {
	id: string; plan_id: string; owner_key: string; platform: string; chat_id: string; user_id: string | null; thread_id: string | null;
	plan_status: TaskPlanCompletionNotice["planStatus"]; title: string; task_count: number; succeeded: number; failed: number; cancelled: number;
	status: Exclude<TaskPlanCompletionNotice["status"], "abandoned">; claim_token: string | null; attempts: number; next_attempt_at: number; created_at: number; abandoned_at: number | null; last_error: string | null;
}

function mapRow(row: MemoryRow): MemoryRecord {
	return {
		id: row.id,
		platform: row.platform,
		chatId: row.chat_id,
		userId: row.user_id ?? undefined,
		threadId: row.thread_id ?? undefined,
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
		id: row.id, profileId: row.profile_id, platform: row.platform, chatId: row.chat_id, userId: row.user_id ?? undefined, threadId: row.thread_id ?? undefined,
		projectId: row.project_id ?? undefined, organizationId: row.organization_id ?? undefined,
		kind: row.kind, statement: row.statement, confidence: row.confidence, stability: row.stability,
		subject: row.subject_type && row.subject_id ? { type: row.subject_type, id: row.subject_id } : undefined,
		object: row.object_type && row.object_id ? { type: row.object_type, id: row.object_id } : undefined,
		source: row.source_type ? { type: row.source_type, ...(row.source_ref ? { ref: row.source_ref } : {}) } : undefined,
		visibility: row.visibility, validFrom: row.valid_from ?? undefined, validUntil: row.valid_until ?? undefined, conflictsWith: [],
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
	return { id: row.id, platform: row.platform, chatId: row.chat_id, userId: row.user_id ?? undefined, threadId: row.thread_id ?? undefined, kind: row.kind, content: row.content, occurredAt: row.occurred_at, createdAt: row.created_at };
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
		...(row.verification_outcome === null ? {} : { verificationStatus: row.verification_outcome }),
		...(row.verification_feedback === null ? {} : { verificationFeedback: row.verification_feedback }),
		...(row.verification_attempts ? { verificationAttempts: row.verification_attempts } : {}),
		...(row.verification_retry_at === null ? {} : { verificationRetryAt: row.verification_retry_at }),
		...(row.corrective_attempts ? { correctiveAttempts: row.corrective_attempts } : {}),
		...(row.started_at === null ? {} : { startedAt: row.started_at }),
		...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
		...(row.result === null ? {} : { result: row.result }),
		...(row.candidate_result === null ? {} : { candidateResult: row.candidate_result }),
		...(row.error === null ? {} : { error: row.error }),
		...(row.checkpoint === null ? {} : { checkpoint: row.checkpoint }),
		...(row.checkpoint_at === null ? {} : { checkpointAt: row.checkpoint_at }),
		...(row.routes === null ? {} : { routes: JSON.parse(row.routes) as string[], routeIndex: row.route_index }),
	};
}

function mapTaskPlanCompletionNotice(row: TaskPlanCompletionNoticeRow): TaskPlanCompletionNotice {
	return {
		id: row.id, planId: row.plan_id, ownerKey: row.owner_key,
		target: { platform: row.platform, chatId: row.chat_id, ...(row.user_id ? { userId: row.user_id } : {}), ...(row.thread_id ? { threadId: row.thread_id } : {}) },
		planStatus: row.plan_status, title: row.title, taskCount: row.task_count, succeeded: row.succeeded, failed: row.failed, cancelled: row.cancelled,
		status: row.abandoned_at === null ? row.status : "abandoned", ...(row.claim_token ? { claimToken: row.claim_token } : {}), attempts: row.attempts, nextAttemptAt: row.next_attempt_at, createdAt: row.created_at,
		...(row.abandoned_at === null ? {} : { abandonedAt: row.abandoned_at }), ...(row.last_error ? { error: row.last_error } : {}),
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
		...(row.paused_at === null ? {} : { pausedAt: row.paused_at }),
		createdAt: row.created_at, ...(row.started_at === null ? {} : { startedAt: row.started_at }), ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
	};
}

function safeTaskText(value: string | undefined): string | null {
	return value === undefined ? null : redactCredentialMaterial(value);
}

function scopeWhere(opts: Omit<RecallOptions, "limit">, alias: string): { where: string; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];
	if (opts.platform) { conditions.push(`${alias}.platform = ?`); params.push(opts.platform); }
	if (opts.chatId) { conditions.push(`${alias}.chat_id = ?`); params.push(opts.chatId); }
	if (opts.userId) { conditions.push(`${alias}.user_id = ?`); params.push(opts.userId); }
	if (opts.chatId) { conditions.push(`${alias}.thread_id IS ?`); params.push(opts.threadId ?? null); }
	return { where: conditions.length ? `AND ${conditions.join(" AND ")}` : "", params };
}

function clampConfidence(value: number): number { return Math.max(0, Math.min(1, value)); }
function strongerStability(a: MemoryClaim["stability"], b: MemoryClaim["stability"]): MemoryClaim["stability"] {
	const order = { low: 1, medium: 2, high: 3 } as const;
	return order[a] >= order[b] ? a : b;
}
function sameClaimScope(a: MemoryClaim, b: MemoryClaim): boolean {
	return a.profileId === b.profileId && a.platform === b.platform && a.chatId === b.chatId && a.userId === b.userId && a.threadId === b.threadId
		&& a.projectId === b.projectId && a.organizationId === b.organizationId && a.visibility === b.visibility;
}

function claimReadWhere(opts: Omit<RecallOptions, "limit">, alias: string): { where: string; params: unknown[] } {
	const profileId = opts.profileId ?? "default";
	const entityConditions: string[] = [];
	const entityParams: unknown[] = [];
	if (opts.subject) {
		entityConditions.push(`${alias}.subject_type = ? AND ${alias}.subject_id = ?`);
		entityParams.push(opts.subject.type, opts.subject.id);
	}
	if (opts.object) {
		entityConditions.push(`${alias}.object_type = ? AND ${alias}.object_id = ?`);
		entityParams.push(opts.object.type, opts.object.id);
	}
	return {
		where: `AND ${alias}.profile_id = ? AND (
			(${alias}.visibility = 'private' AND ${alias}.platform = ? AND ${alias}.user_id = ?)
			OR (${alias}.visibility = 'conversation' AND ${alias}.platform = ? AND ${alias}.chat_id = ? AND ${alias}.thread_id IS ?)
			OR (${alias}.visibility = 'team' AND ${alias}.project_id IS NOT NULL AND ${alias}.project_id = ?)
			OR (${alias}.visibility = 'organization' AND ${alias}.organization_id IS NOT NULL AND ${alias}.organization_id = ?))
			${entityConditions.length ? `AND ${entityConditions.join(" AND ")}` : ""}`,
		params: [profileId, opts.platform ?? "", opts.userId ?? "", opts.platform ?? "", opts.chatId ?? "", opts.threadId ?? null, opts.projectId ?? "", opts.organizationId ?? "", ...entityParams],
	};
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
	return lexicalTerms(query)
		.map((token) => `"${token.replaceAll('"', '""')}"${/^[a-z0-9]+$/i.test(token) ? "*" : ""}`)
		.join(" OR ");
}

function lexicalTerms(query: string): string[] {
	const raw = query.normalize("NFKC").toLocaleLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
	const terms = raw.flatMap((term) => {
		if (/^\p{Script=Han}+$/u.test(term)) {
			if (term.length <= 2) return [term];
			return Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2));
		}
		if (/^[a-z]+$/i.test(term) && term.length > 4) return [term.replace(/(?:ies|ing|ed|es|s)$/i, (suffix) => suffix.toLowerCase() === "ies" ? "y" : "")];
		return [term];
	});
	return [...new Set(terms.filter((term) => term.length > 0))];
}

function lexicalWhere(query: string, column: string): { where: string; params: string[] } | undefined {
	const terms = lexicalTerms(query);
	if (!terms.length) return undefined;
	return {
		where: `(${terms.map(() => `lower(${column}) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
		params: terms.map((term) => `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`),
	};
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
	const seen = new Set<string>();
	return items.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));
}

function cryptoRandom(): string {
	// 16 random bytes -> 32 hex chars. Good enough as a unique row id.
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

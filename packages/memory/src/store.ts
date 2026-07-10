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

export class MemoryStore {
	private readonly db: DatabaseType;

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
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
		`);
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
		return rows.map(mapRow);
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

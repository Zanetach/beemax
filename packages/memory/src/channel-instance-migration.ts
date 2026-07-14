import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createHash } from "node:crypto";

export type ChannelRouteStorage = "channel_instance_column" | "encoded_platform";

export interface ChannelInstanceMigrationTablePlan {
	table: string;
	storage: ChannelRouteStorage;
	rows: number;
}

export interface ChannelInstanceMigrationPlan {
	platform: string;
	channelInstanceId: string;
	legacyAddress: string;
	targetAddress: string;
	tables: ChannelInstanceMigrationTablePlan[];
	totalRows: number;
	blockers: string[];
}

export interface ApplyChannelInstanceMigrationInput {
	id: string;
	platform: string;
	channelInstanceId: string;
	backupRef: string;
	appliedAt?: number;
}

export interface AppliedChannelInstanceMigration extends ChannelInstanceMigrationPlan {
	id: string;
	backupRef: string;
	appliedAt: number;
}

export interface PreparedChannelInstanceMigration {
	result: AppliedChannelInstanceMigration;
	preMigrationDigest: string;
	postMigrationDigest: string;
}

interface ChannelRouteTableDescriptor {
	table: string;
	storage: ChannelRouteStorage;
	scopeKey?: boolean;
	structuredRouteColumns?: readonly string[];
}

interface TableInfoRow { name: string; }
interface NamedTableRow { name: string; }
interface SchemaRow { type: string; name: string; tbl_name: string; sql: string | null; }
interface CountRow { count: number; }
interface UserRow { user_id: string; }
interface CanonicalRow { canonical_value: string; }

const MIGRATION_TABLE = "channel_instance_migrations";
const ROUTE_TABLES: readonly ChannelRouteTableDescriptor[] = [
	{ table: "automation_deliveries", storage: "channel_instance_column" },
	{ table: "automation_jobs", storage: "channel_instance_column" },
	{ table: "automation_routes", storage: "channel_instance_column" },
	{ table: "initiative_observations", storage: "channel_instance_column" },
	{ table: "initiative_triggers", storage: "channel_instance_column", structuredRouteColumns: ["delivery_target", "execution_scope"] },
	{ table: "media_deliveries", storage: "channel_instance_column" },
	{ table: "memories", storage: "encoded_platform" },
	{ table: "memory_candidates", storage: "encoded_platform" },
	{ table: "memory_claims", storage: "encoded_platform" },
	{ table: "memory_convention_candidates", storage: "encoded_platform", scopeKey: true },
	{ table: "memory_episodes", storage: "encoded_platform" },
	{ table: "memory_events", storage: "encoded_platform" },
	{ table: "memory_workflow_candidates", storage: "encoded_platform", scopeKey: true },
	{ table: "task_plan_completion_notices", storage: "channel_instance_column" },
];

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function validateAddressPart(label: string, value: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 200 || normalized.includes("@") || /[\u0000-\u001f\u007f]/u.test(normalized)) {
		throw new Error(`${label} must be a non-empty route segment without '@' or control characters`);
	}
	return normalized;
}

function requireText(label: string, value: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} is required`);
	return normalized;
}

/**
 * Assigns ambiguous pre-multi-instance route data to one administrator-selected
 * channel instance. The Profile database is the transaction boundary, so Memory
 * and Automation ownership can never be partially changed.
 */
export class ProfileChannelInstanceMigration {
	private readonly db: DatabaseType;
	private readonly path: string;
	private closed = false;

	constructor(path: string) {
		this.path = path;
		this.db = new Database(path);
		this.db.pragma("foreign_keys = ON");
		this.db.pragma("busy_timeout = 5000");
	}

	plan(platform: string, channelInstanceId: string): ChannelInstanceMigrationPlan {
		this.assertOpen();
		return this.planInternal(
			validateAddressPart("platform", platform),
			validateAddressPart("channelInstanceId", channelInstanceId),
		);
	}

	apply(input: ApplyChannelInstanceMigrationInput): AppliedChannelInstanceMigration {
		this.assertOpen();
		const normalized = this.normalizeInput(input);
		return this.db.transaction(() => this.applyInternal(normalized))();
	}

	/** Holds SQLite's write fence across the verified before snapshot, mutation, and prepared recovery manifest. */
	async applyWithBackup(
		input: ApplyChannelInstanceMigrationInput,
		backupPath: string,
		prepareCommit: (prepared: PreparedChannelInstanceMigration) => void | Promise<void>,
	): Promise<PreparedChannelInstanceMigration> {
		this.assertOpen();
		const normalized = this.normalizeInput(input);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const backupSource = new Database(this.path, { readonly: true, fileMustExist: true });
			try { await backupSource.backup(backupPath); }
			finally { backupSource.close(); }
			verifyDatabase(this.path, backupPath);
			const preMigrationDigest = digestDatabase(this.db);
			if (digestSqliteDatabase(backupPath) !== preMigrationDigest) throw new Error("SQLite backup does not match the fenced pre-migration state");
			const result = this.applyInternal(normalized);
			const prepared = { result, preMigrationDigest, postMigrationDigest: digestDatabase(this.db) };
			await prepareCommit(prepared);
			this.db.exec("COMMIT");
			return prepared;
		} catch (error) {
			if (this.db.inTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	private planInternal(platform: string, channelInstanceId: string): ChannelInstanceMigrationPlan {
		const tables: ChannelInstanceMigrationTablePlan[] = [];
		const blockers: string[] = [];
		const existing = new Set(this.userTables());
		for (const descriptor of ROUTE_TABLES) {
			if (!existing.has(descriptor.table)) continue;
			const columns = this.columns(descriptor.table);
			const required = descriptor.storage === "channel_instance_column" ? ["platform", "channel_instance_id"] : ["platform"];
			if (!required.every((column) => columns.has(column))) {
				blockers.push(`${descriptor.table} schema does not support ${descriptor.storage}`);
				continue;
			}
			const where = descriptor.storage === "channel_instance_column"
				? "platform = ? AND (channel_instance_id IS NULL OR channel_instance_id = '')"
				: "platform = ?";
			const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(descriptor.table)} WHERE ${where}`).get(platform) as CountRow;
			if (row.count > 0) tables.push({ table: descriptor.table, storage: descriptor.storage, rows: row.count });
		}

		if (this.hasColumns("automation_routes", ["platform", "channel_instance_id", "user_id"])) {
			const collisions = this.db.prepare(`
				SELECT legacy.user_id
				FROM automation_routes AS legacy
				JOIN automation_routes AS target
				  ON target.platform = legacy.platform
				 AND target.channel_instance_id = ?
				 AND target.user_id = legacy.user_id
				WHERE legacy.platform = ?
				  AND (legacy.channel_instance_id IS NULL OR legacy.channel_instance_id = '')
				ORDER BY legacy.user_id
			`).all(channelInstanceId, platform) as UserRow[];
			for (const collision of collisions) {
				blockers.push(`automation_routes target for user ${collision.user_id} already exists`);
			}
		}
		for (const [table, canonicalColumn] of [
			["memory_convention_candidates", "canonical_statement"],
			["memory_workflow_candidates", "canonical_title"],
		] as const) {
			if (!this.hasColumns(table, ["profile_id", "platform", "chat_id", "user_id", "thread_id", "scope_key", canonicalColumn])) continue;
			const identifier = quoteIdentifier(table);
			const canonical = quoteIdentifier(canonicalColumn);
			const collisions = this.db.prepare(`
				SELECT legacy.${canonical} AS canonical_value
				FROM ${identifier} AS legacy
				JOIN ${identifier} AS target
				  ON target.profile_id = legacy.profile_id
				 AND target.scope_key = json_array(?, legacy.chat_id, legacy.user_id, legacy.thread_id)
				 AND target.${canonical} = legacy.${canonical}
				WHERE legacy.platform = ?
				ORDER BY legacy.${canonical}
			`).all(`${platform}@${channelInstanceId}`, platform) as CanonicalRow[];
			for (const collision of collisions) {
				blockers.push(`${table} target for ${collision.canonical_value} already exists`);
			}
		}

		if (this.hasColumns("initiative_triggers", ["platform", "channel_instance_id"])) {
			for (const column of ["delivery_target", "execution_scope"]) {
				if (!this.columns("initiative_triggers").has(column)) continue;
				const invalid = this.db.prepare(`
					SELECT COUNT(*) AS count FROM initiative_triggers
					WHERE platform = ? AND (channel_instance_id IS NULL OR channel_instance_id = '')
					  AND ${quoteIdentifier(column)} IS NOT NULL
					  AND (NOT json_valid(${quoteIdentifier(column)}) OR json_type(${quoteIdentifier(column)}) <> 'object')
				`).get(platform) as CountRow;
				if (invalid.count > 0) blockers.push(`initiative_triggers contains ${invalid.count} invalid or non-object ${column} JSON value(s)`);
			}
		}

		return {
			platform,
			channelInstanceId,
			legacyAddress: platform,
			targetAddress: `${platform}@${channelInstanceId}`,
			tables,
			totalRows: tables.reduce((sum, table) => sum + table.rows, 0),
			blockers,
		};
	}

	private applyTable(table: ChannelInstanceMigrationTablePlan, platform: string, channelInstanceId: string): void {
		const identifier = quoteIdentifier(table.table);
		const descriptor = ROUTE_TABLES.find((candidate) => candidate.table === table.table);
		if (!descriptor || descriptor.storage !== table.storage) throw new Error(`No migration descriptor owns ${table.table}`);
		let result: Database.RunResult;
		if (table.storage === "channel_instance_column") {
			const columns = this.columns(table.table);
			const assignments = ["channel_instance_id = ?"];
			const params: unknown[] = [channelInstanceId];
			if (descriptor.structuredRouteColumns) {
				for (const column of descriptor.structuredRouteColumns) {
					if (!columns.has(column)) continue;
					assignments.push(`${quoteIdentifier(column)} = CASE WHEN ${quoteIdentifier(column)} IS NULL THEN NULL ELSE json_set(${quoteIdentifier(column)}, '$.channelInstanceId', ?) END`);
					params.push(channelInstanceId);
				}
			}
			params.push(platform);
			result = this.db.prepare(`UPDATE ${identifier} SET ${assignments.join(", ")} WHERE platform = ? AND (channel_instance_id IS NULL OR channel_instance_id = '')`).run(...params);
		} else {
			const columns = this.columns(table.table);
			const assignments = ["platform = ?"];
			const params: unknown[] = [`${platform}@${channelInstanceId}`];
			if (descriptor.scopeKey && ["scope_key", "chat_id", "user_id", "thread_id"].every((column) => columns.has(column))) {
				assignments.push("scope_key = json_array(?, chat_id, user_id, thread_id)");
				params.push(`${platform}@${channelInstanceId}`);
			}
			params.push(platform);
			result = this.db.prepare(`UPDATE ${identifier} SET ${assignments.join(", ")} WHERE platform = ?`).run(...params);
		}
		if (result.changes !== table.rows) {
			throw new Error(`Concurrent change detected while migrating ${table.table}: planned ${table.rows}, changed ${result.changes}`);
		}
	}

	private createAuditTable(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
				id TEXT PRIMARY KEY,
				base_platform TEXT NOT NULL,
				channel_instance_id TEXT NOT NULL,
				backup_ref TEXT NOT NULL,
				row_counts_json TEXT NOT NULL,
				total_rows INTEGER NOT NULL,
				applied_at INTEGER NOT NULL
			)
		`);
	}

	private normalizeInput(input: ApplyChannelInstanceMigrationInput): Required<ApplyChannelInstanceMigrationInput> {
		return {
			id: requireText("migration id", input.id),
			backupRef: requireText("backupRef", input.backupRef),
			platform: validateAddressPart("platform", input.platform),
			channelInstanceId: validateAddressPart("channelInstanceId", input.channelInstanceId),
			appliedAt: input.appliedAt ?? Date.now(),
		};
	}

	private applyInternal(input: Required<ApplyChannelInstanceMigrationInput>): AppliedChannelInstanceMigration {
		const plan = this.planInternal(input.platform, input.channelInstanceId);
		if (plan.blockers.length > 0) throw new Error(`Channel instance migration is blocked:\n${plan.blockers.join("\n")}`);
		if (plan.totalRows === 0) throw new Error("Channel instance migration has no legacy route data to assign");
		this.createAuditTable();
		for (const table of plan.tables) this.applyTable(table, input.platform, input.channelInstanceId);
		this.db.prepare(`
			INSERT INTO ${MIGRATION_TABLE}
				(id, base_platform, channel_instance_id, backup_ref, row_counts_json, total_rows, applied_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(input.id, input.platform, input.channelInstanceId, input.backupRef, JSON.stringify(plan.tables), plan.totalRows, input.appliedAt);
		return { ...plan, id: input.id, backupRef: input.backupRef, appliedAt: input.appliedAt };
	}

	private userTables(): string[] {
		return (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as NamedTableRow[])
			.map((row) => row.name)
			.filter((name) => name !== MIGRATION_TABLE);
	}

	private columns(table: string): Set<string> {
		return new Set((this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableInfoRow[]).map((row) => row.name));
	}

	private hasColumns(table: string, expected: string[]): boolean {
		if (!this.userTables().includes(table)) return false;
		const columns = this.columns(table);
		return expected.every((column) => columns.has(column));
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("ProfileChannelInstanceMigration is closed");
	}
}

/** Stable, bounded-memory digest of one logical SQLite state, including schema and all table rows. */
export function digestSqliteDatabase(path: string): string {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		db.exec("BEGIN");
		const digest = digestDatabase(db);
		db.exec("COMMIT");
		return digest;
	}
	catch (error) {
		if (db.inTransaction) db.exec("ROLLBACK");
		throw error;
	}
	finally { db.close(); }
}

function digestDatabase(db: DatabaseType): string {
	const hash = createHash("sha256");
	const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
		WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as SchemaRow[];
	for (const row of schema) {
		hashValue(hash, row.type);
		hashValue(hash, row.name);
		hashValue(hash, row.tbl_name);
		hashValue(hash, row.sql);
	}
	for (const table of schema.filter((row) => row.type === "table")) {
		const columns = (db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as TableInfoRow[]).map((row) => row.name);
		if (columns.length === 0) continue;
		const projection = columns.map(quoteIdentifier).join(", ");
		hashValue(hash, table.name);
		for (const row of db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table.name)} ORDER BY ${projection}`).iterate() as Iterable<Record<string, unknown>>) {
			for (const column of columns) hashValue(hash, row[column]);
		}
	}
	return hash.digest("hex");
}

function hashValue(hash: ReturnType<typeof createHash>, value: unknown): void {
	let type: string = typeof value;
	let bytes: Buffer;
	if (value === null) { type = "null"; bytes = Buffer.alloc(0); }
	else if (Buffer.isBuffer(value)) { type = "buffer"; bytes = value; }
	else bytes = Buffer.from(String(value), "utf8");
	hash.update(`${type}:${bytes.byteLength}:`);
	hash.update(bytes);
}

function verifyDatabase(sourcePath: string, backupPath: string): void {
	const db = new Database(backupPath, { readonly: true, fileMustExist: true });
	try {
		const result = db.pragma("integrity_check", { simple: true });
		if (result !== "ok") throw new Error(`SQLite backup integrity check failed for ${sourcePath}: ${String(result)}`);
	} finally { db.close(); }
}

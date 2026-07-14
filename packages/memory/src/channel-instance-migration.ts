import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

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

interface TableInfoRow { name: string; }
interface NamedTableRow { name: string; }
interface CountRow { count: number; }
interface UserRow { user_id: string; }
interface CanonicalRow { canonical_value: string; }

const MIGRATION_TABLE = "channel_instance_migrations";

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
	private closed = false;

	constructor(path: string) {
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
		const id = requireText("migration id", input.id);
		const backupRef = requireText("backupRef", input.backupRef);
		const platform = validateAddressPart("platform", input.platform);
		const channelInstanceId = validateAddressPart("channelInstanceId", input.channelInstanceId);
		const appliedAt = input.appliedAt ?? Date.now();

		return this.db.transaction(() => {
			const plan = this.planInternal(platform, channelInstanceId);
			if (plan.blockers.length > 0) {
				throw new Error(`Channel instance migration is blocked:\n${plan.blockers.join("\n")}`);
			}
			if (plan.totalRows === 0) throw new Error("Channel instance migration has no legacy route data to assign");

			this.createAuditTable();
			for (const table of plan.tables) this.applyTable(table, platform, channelInstanceId);
			this.db.prepare(`
				INSERT INTO ${MIGRATION_TABLE}
					(id, base_platform, channel_instance_id, backup_ref, row_counts_json, total_rows, applied_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(id, platform, channelInstanceId, backupRef, JSON.stringify(plan.tables), plan.totalRows, appliedAt);

			return { ...plan, id, backupRef, appliedAt };
		})();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	private planInternal(platform: string, channelInstanceId: string): ChannelInstanceMigrationPlan {
		const tables: ChannelInstanceMigrationTablePlan[] = [];
		const blockers: string[] = [];
		for (const table of this.userTables()) {
			const columns = this.columns(table);
			if (!columns.has("platform")) continue;
			const storage: ChannelRouteStorage = columns.has("channel_instance_id")
				? "channel_instance_column"
				: "encoded_platform";
			const where = storage === "channel_instance_column"
				? "platform = ? AND (channel_instance_id IS NULL OR channel_instance_id = '')"
				: "platform = ?";
			const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE ${where}`).get(platform) as CountRow;
			if (row.count > 0) tables.push({ table, storage, rows: row.count });
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
		let result: Database.RunResult;
		if (table.storage === "channel_instance_column") {
			const columns = this.columns(table.table);
			const assignments = ["channel_instance_id = ?"];
			const params: unknown[] = [channelInstanceId];
			if (table.table === "initiative_triggers") {
				for (const column of ["delivery_target", "execution_scope"]) {
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
			if (["scope_key", "chat_id", "user_id", "thread_id"].every((column) => columns.has(column))) {
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

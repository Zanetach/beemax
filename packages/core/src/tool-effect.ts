import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { BoundedJsonlJournal } from "./bounded-jsonl-journal.ts";
import { sessionKeyForSource } from "./session-coordinator.ts";
import type { ToolPolicy } from "./tool-runtime.ts";
import { containsCredentialMaterial } from "./credential-material.ts";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { chmodSync, existsSync } from "node:fs";
import { responsibilityOwnerKey } from "./agent-scope.ts";
import type { ExecutionEnvelope } from "./execution-envelope.ts";
import type { ExecutionTraceSink } from "./execution-trace.ts";

export type ToolEffectStatus = "planned" | "executing" | "committed" | "failed" | "unknown";
export interface ToolEffectProof { provider: string; resourceType: string; resourceId: string; }
export interface ToolEffectReceipt { status: "committed"; occurredAt: number; operation: string; externalRef?: string; idempotencyKey?: string; proof?: ToolEffectProof; }
export class ToolEffectConflictError extends Error { override readonly name = "ToolEffectConflictError"; }

export interface ToolEffectRecord {
	id: string;
	taskId?: string;
	taskRunId?: string;
	toolCallId: string;
	toolName: string;
	sideEffect: "local" | "external";
	status: ToolEffectStatus;
	at: number;
	scope: { ownerKey?: string; platform: string; chatId: string; userId?: string; threadId?: string };
	idempotencyKey?: string;
	compensatesEffectId?: string;
	receipt?: ToolEffectReceipt;
	executionEnvelope?: Readonly<ExecutionEnvelope>;
}

export interface ToolEffectStart {
	source: BeeMaxRuntimeSource;
	executionEnvelope?: Readonly<ExecutionEnvelope>;
	taskId?: string;
	toolCallId: string;
	toolName: string;
	policy: ToolPolicy;
	args?: unknown;
}

export interface ToolEffectFinish extends Omit<ToolEffectStart, "taskId"> {
	isError: boolean;
	details?: unknown;
}

export interface ToolEffectSink {
	begin(input: ToolEffectStart): string | undefined;
	finish(input: ToolEffectFinish): void;
	interruptTask?(taskId: string): number;
	reconcile?(effectId: string, resolution: { status: "committed" | "failed"; operation?: string; externalRef?: string }): boolean;
	close?(): void;
}

/** Safe, read-only Task projection derived from Effect authority state. */
export interface TaskEffectProjection {
	id: string;
	taskRunId: string;
	tool: string;
	status: "committed" | "unknown";
	occurredAt: number;
	operation?: string;
	externalRef?: string;
	idempotencyKey?: string;
	compensatesEffectId?: string;
}

export interface ToolEffectProjectionReader {
	taskProjection(query: { ownerKey: string; taskId: string }): TaskEffectProjection[];
	taskRunReplayState?(query: { ownerKey: string; taskId: string; taskRunId: string }): "clear" | "blocked";
	unresolvedTaskEffects?(query: { ownerKey: string; taskIds: string[] }): number;
}

export interface ToolEffectAuthorityPort extends ToolEffectSink, ToolEffectProjectionReader {}

/** Content-free, profile-local Effect journal for reconciling interrupted mutations. */
export class FileToolEffectJournal implements ToolEffectAuthorityPort {
	private readonly journal: BoundedJsonlJournal<ToolEffectRecord>;
	private readonly active = new Map<string, ToolEffectRecord>();
	private readonly authority: ToolEffectAuthority;
	private readonly executionTrace?: ExecutionTraceSink;

	constructor(path: string, limit = 5_000, executionTrace?: ExecutionTraceSink) {
		this.journal = new BoundedJsonlJournal({ path, limit, minLimit: 100, maxLimit: 50_000, isRecord: isEffectRecord });
		this.authority = new ToolEffectAuthority(`${path}.authority.sqlite`, limit);
		this.executionTrace = executionTrace;
		this.authority.importLegacyProjection(this.journal.records());
		for (const record of this.authority.recoverOrphans()) {
			this.append(record);
			this.recordTrace(record.executionEnvelope, { type: "effect.settled", effectId: record.id, toolCallId: record.toolCallId, status: "unknown" });
		}
	}

	begin(input: ToolEffectStart): string | undefined {
		if (input.policy.sideEffect === "none") return undefined;
		if (input.executionEnvelope?.taskId && !input.executionEnvelope.taskRunId) throw new ToolEffectConflictError("Durable mutation requires a Task Run identity");
		const idempotencyKey = safeText(recordOf(input.args).idempotencyKey, 256);
		const scope = scopeOf(input.source);
		const compensatesEffectId = input.executionEnvelope?.compensatesEffectId;
		if (compensatesEffectId) {
			const original = this.authority.effect(compensatesEffectId);
			if (!original || original.status !== "committed" || !original.receipt) throw new ToolEffectConflictError("Compensation requires an existing committed Effect receipt");
			if (original.compensatesEffectId) throw new ToolEffectConflictError("A Compensation Effect cannot itself be compensated proactively");
			if (original.scope.ownerKey !== scope.ownerKey) throw new ToolEffectConflictError("Compensation Effect scope does not match the committed Effect");
			if (original.sideEffect === "external" && original.receipt.proof?.provider !== input.policy.effectProofProvider) throw new ToolEffectConflictError("Compensation capability does not match the committed Effect proof provider");
			const prior = this.authority.effectForIdentity(compensationIdentity(scope, compensatesEffectId));
			if (prior?.status === "committed") throw new ToolEffectConflictError("Effect is already compensated in the current owner scope");
			if (prior && prior.status !== "failed") throw new ToolEffectConflictError("Compensation Effect is unresolved; reconcile it before retrying");
		}
		const taskId = input.executionEnvelope?.taskId ?? input.taskId;
		const taskRunId = input.executionEnvelope?.taskRunId;
		const at = Date.now();
		const recordId = crypto.randomUUID();
		const record: ToolEffectRecord = {
			id: recordId,
			...(taskId ? { taskId } : {}),
			...(taskRunId ? { taskRunId } : {}),
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			sideEffect: input.policy.sideEffect,
			status: "planned",
			at,
			scope,
			...(idempotencyKey ? { idempotencyKey } : {}),
			...(compensatesEffectId ? { compensatesEffectId } : {}),
			...(input.executionEnvelope ? { executionEnvelope: input.executionEnvelope } : {}),
		};
		const executing = this.authority.begin(record, [...(idempotencyKey ? identitiesFor(scope, idempotencyKey) : []), ...(compensatesEffectId ? [compensationIdentity(scope, compensatesEffectId)] : [])]);
		this.append(record);
		this.append(executing);
		this.active.set(callKey(input.source, input.toolCallId), executing);
		this.recordTrace(input.executionEnvelope, { type: "effect.started", effectId: record.id, toolCallId: input.toolCallId, status: "executing" });
		return record.id;
	}

	finish(input: ToolEffectFinish): void {
		const key = callKey(input.source, input.toolCallId);
		const active = this.active.get(key);
		if (!active) return;
		this.active.delete(key);
		const at = Date.now();
		const metadata = effectMetadata(input.details);
		const trustedProof = metadata.proof && input.policy.effectProofProvider === metadata.proof.provider ? metadata.proof : undefined;
		const trustedMetadata = { ...metadata, proof: trustedProof };
		const status = input.isError || active.sideEffect === "external" && !trustedProof ? "unknown" : "committed";
		const completed: ToolEffectRecord = {
			...active,
			status,
			at,
			...(status === "committed" ? { receipt: receiptOf(active, trustedMetadata, at) } : {}),
		};
		if (this.authority.transition(active.id, ["planned", "executing"], completed)) {
			this.append(completed);
			this.recordTrace(input.executionEnvelope ?? active.executionEnvelope, { type: "effect.settled", effectId: active.id, toolCallId: input.toolCallId, status });
		}
	}

	interruptTask(taskId: string): number {
		let interrupted = 0;
		for (const [key, record] of this.active) {
			if (record.taskId !== taskId) continue;
			this.active.delete(key);
			const at = Date.now();
			const unknown = { ...record, status: "unknown" as const, at, receipt: undefined };
			if (this.authority.transition(record.id, ["planned", "executing"], unknown)) {
				this.append(unknown);
				this.recordTrace(record.executionEnvelope, { type: "effect.settled", effectId: record.id, toolCallId: record.toolCallId, status: "unknown" });
			}
			interrupted++;
		}
		return interrupted;
	}

	reconcile(effectId: string, resolution: { status: "committed" | "failed"; operation?: string; externalRef?: string }): boolean {
		const current = this.authority.effect(effectId);
		if (!current || current.status !== "unknown") return false;
		const at = Date.now();
		const operation = safeText(resolution.operation, 1_000) ?? current.toolName;
		const externalRef = safeText(resolution.externalRef, 1_000);
		const reconciled: ToolEffectRecord = {
			...current,
			status: resolution.status,
			at,
			receipt: resolution.status === "committed" ? { status: "committed", occurredAt: at, operation, ...(externalRef ? { externalRef } : {}), ...(current.idempotencyKey ? { idempotencyKey: current.idempotencyKey } : {}) } : undefined,
		};
		if (!this.authority.transition(current.id, ["unknown"], reconciled)) return false;
		this.append(reconciled);
		this.recordTrace(current.executionEnvelope, { type: "effect.settled", effectId: current.id, toolCallId: current.toolCallId, status: resolution.status });
		return true;
	}

	events(): ToolEffectRecord[] { return this.authority.events(); }
	effect(effectId: string | undefined): ToolEffectRecord | undefined { return effectId ? this.authority.effect(effectId) : undefined; }
	taskProjection(query: { ownerKey: string; taskId: string }): TaskEffectProjection[] {
		return this.authority.effectsForTask(query).flatMap((record): TaskEffectProjection[] => {
			if (!record.taskRunId || record.status !== "committed" && record.status !== "unknown") return [];
			const receipt = record.receipt;
			return [{
				id: record.id, taskRunId: record.taskRunId, tool: record.toolName, status: record.status, occurredAt: record.at,
				...(receipt?.operation ? { operation: receipt.operation } : {}),
				...(receipt?.externalRef ? { externalRef: receipt.externalRef } : {}),
				...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
				...(record.compensatesEffectId ? { compensatesEffectId: record.compensatesEffectId } : {}),
			}];
		});
	}
	taskRunReplayState(query: { ownerKey: string; taskId: string; taskRunId: string }): "clear" | "blocked" {
		return this.authority.effectsForTask(query).some((record) => record.taskRunId === query.taskRunId && record.status !== "failed") ? "blocked" : "clear";
	}
	unresolvedTaskEffects(query: { ownerKey: string; taskIds: string[] }): number {
		return this.authority.unresolvedTaskEffects(query);
	}
	close(): void {
		for (const [key, record] of this.active) {
			this.active.delete(key);
			const unknown = { ...record, status: "unknown" as const, at: Date.now(), receipt: undefined };
			if (this.authority.transition(record.id, ["planned", "executing"], unknown)) {
				this.append(unknown);
				this.recordTrace(record.executionEnvelope, { type: "effect.settled", effectId: record.id, toolCallId: record.toolCallId, status: "unknown" });
			}
		}
		this.authority.close();
	}

	private append(record: ToolEffectRecord): void { try { this.journal.append(record); } catch { /* SQLite remains the Effect authority. */ } }
	private recordTrace(envelope: Readonly<ExecutionEnvelope> | undefined, event: { type: "effect.started"; effectId: string; toolCallId: string; status: "executing" } | { type: "effect.settled"; effectId: string; toolCallId: string; status: "committed" | "failed" | "unknown" }): void {
		try { if (envelope) this.executionTrace?.record({ ...event, executionEnvelope: envelope }); } catch { /* Trace is a diagnostic projection, never Effect authority. */ }
	}
}

interface StoredEffectRow { record_json: string; }

/** Atomic replay authority kept separate from the bounded operational event journal. */
class ToolEffectAuthority {
	private readonly db: DatabaseType;
	private readonly eventLimit: number;

	constructor(path: string, eventLimit: number) {
		this.eventLimit = Math.max(100, Math.min(eventLimit, 50_000));
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this.db.pragma("foreign_keys = ON");
		this.db.exec(`CREATE TABLE IF NOT EXISTS tool_effects (
			id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('planned','executing','committed','failed','unknown')), updated_at INTEGER NOT NULL, record_json TEXT NOT NULL, holder_pid INTEGER, owner_key TEXT, task_id TEXT, task_run_id TEXT
		);
		CREATE TABLE IF NOT EXISTS tool_effect_identities (
			identity TEXT PRIMARY KEY, effect_id TEXT NOT NULL REFERENCES tool_effects(id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS tool_effect_events (
			seq INTEGER PRIMARY KEY AUTOINCREMENT, effect_id TEXT NOT NULL, record_json TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS tool_effect_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		const columns = this.db.prepare("PRAGMA table_info(tool_effects)").all() as Array<{ name: string }>;
		for (const [name, sql] of [["holder_pid", "ALTER TABLE tool_effects ADD COLUMN holder_pid INTEGER"], ["owner_key", "ALTER TABLE tool_effects ADD COLUMN owner_key TEXT"], ["task_id", "ALTER TABLE tool_effects ADD COLUMN task_id TEXT"], ["task_run_id", "ALTER TABLE tool_effects ADD COLUMN task_run_id TEXT"]] as const) {
			if (!columns.some((column) => column.name === name)) this.db.exec(sql);
		}
		this.backfillTaskProjectionColumns();
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_tool_effects_task_projection ON tool_effects(owner_key,task_id,updated_at)");
		this.migrateLegacyAuthority();
		this.pruneTerminalWithoutReplayIdentity(Date.now() - 90 * 24 * 60 * 60_000);
		if (existsSync(path)) chmodSync(path, 0o600);
	}

	begin(planned: ToolEffectRecord, identities: string[]): ToolEffectRecord {
		return this.db.transaction(() => {
			for (const identity of identities) {
				const current = this.db.prepare(`SELECT e.status FROM tool_effect_identities i JOIN tool_effects e ON e.id = i.effect_id WHERE i.identity = ?`).get(identity) as { status: ToolEffectStatus } | undefined;
				if (current?.status === "committed") throw new ToolEffectConflictError("Effect with this idempotency key is already committed in the current owner scope");
				if (current && current.status !== "failed") throw new ToolEffectConflictError("Effect with this idempotency key is unresolved in the current owner scope; reconcile it before retrying");
				if (current?.status === "failed") this.db.prepare("DELETE FROM tool_effect_identities WHERE identity = ?").run(identity);
			}
			this.insertState(planned); this.insertEvent(planned);
			for (const identity of identities) this.db.prepare("INSERT INTO tool_effect_identities(identity, effect_id) VALUES (?, ?)").run(identity, planned.id);
			const executing = { ...planned, status: "executing" as const, at: Date.now() };
			this.updateState(executing); this.insertEvent(executing); this.trimEvents();
			return executing;
		}).immediate();
	}

	importLegacyProjection(records: Iterable<ToolEffectRecord>): void {
		const migrate = this.db.transaction(() => {
			if (this.db.prepare("SELECT 1 FROM tool_effect_meta WHERE key='jsonl_projection_imported'").get()) return;
			for (const record of records) {
				const current = this.effect(record.id);
				if (current && current.at > record.at) continue;
				if (current) this.updateState(record); else this.insertState(record);
				this.insertEventIfMissing(record);
				if (record.idempotencyKey) for (const identity of identitiesFor(record.scope, record.idempotencyKey)) this.db.prepare("INSERT OR IGNORE INTO tool_effect_identities(identity, effect_id) VALUES (?, ?)").run(identity, record.id);
			}
			this.db.prepare("INSERT INTO tool_effect_meta(key,value) VALUES ('jsonl_projection_imported','1')").run();
			this.trimEvents();
		});
		migrate.immediate();
	}

	transition(effectId: string, expected: ToolEffectStatus[], record: ToolEffectRecord): boolean {
		return this.db.transaction(() => {
			const placeholders = expected.map(() => "?").join(",");
			const result = this.db.prepare(`UPDATE tool_effects SET status=?,updated_at=?,record_json=?,holder_pid=NULL WHERE id=? AND status IN (${placeholders})`).run(record.status, record.at, JSON.stringify(record), effectId, ...expected);
			if (result.changes !== 1) return false;
			this.insertEvent(record); this.trimEvents(); return true;
		}).immediate();
	}

	recoverOrphans(): ToolEffectRecord[] {
		const rows = this.db.prepare("SELECT record_json,holder_pid FROM tool_effects WHERE status IN ('planned','executing')").all() as Array<StoredEffectRow & { holder_pid: number | null }>;
		const recovered: ToolEffectRecord[] = [];
		for (const row of rows) {
			if (row.holder_pid === process.pid || row.holder_pid && processIsAlive(row.holder_pid)) continue;
			const current = parseEffect(row.record_json);
			const unknown = { ...current, status: "unknown" as const, at: Date.now(), receipt: undefined };
			if (this.transition(current.id, ["planned", "executing"], unknown)) recovered.push(unknown);
		}
		return recovered;
	}

	effect(effectId: string): ToolEffectRecord | undefined { const row = this.db.prepare("SELECT record_json FROM tool_effects WHERE id = ?").get(effectId) as StoredEffectRow | undefined; return row ? parseEffect(row.record_json) : undefined; }
	effectForIdentity(identity: string): ToolEffectRecord | undefined {
		const row = this.db.prepare(`SELECT e.record_json FROM tool_effect_identities i JOIN tool_effects e ON e.id = i.effect_id WHERE i.identity = ?`).get(identity) as StoredEffectRow | undefined;
		return row ? parseEffect(row.record_json) : undefined;
	}
	effectsForTask(query: { ownerKey: string; taskId: string }): ToolEffectRecord[] {
		return (this.db.prepare("SELECT record_json FROM tool_effects WHERE owner_key = ? AND task_id = ? ORDER BY updated_at").all(query.ownerKey, query.taskId) as StoredEffectRow[]).map((row) => parseEffect(row.record_json));
	}
	unresolvedTaskEffects(query: { ownerKey: string; taskIds: string[] }): number {
		const taskIds = [...new Set(query.taskIds.filter((id) => id.trim()))];
		if (!taskIds.length) return 0;
		return (this.db.prepare(`SELECT COUNT(*) AS count FROM tool_effects WHERE owner_key = ? AND status IN ('planned','executing','unknown')
			AND task_id IN (${taskIds.map(() => "?").join(",")})`).get(query.ownerKey, ...taskIds) as { count: number }).count;
	}
	events(): ToolEffectRecord[] { return (this.db.prepare("SELECT record_json FROM tool_effect_events ORDER BY seq").all() as StoredEffectRow[]).map((row) => parseEffect(row.record_json)); }
	close(): void { this.db.pragma("wal_checkpoint(TRUNCATE)"); this.db.close(); }
	private insertState(record: ToolEffectRecord): void { this.db.prepare("INSERT INTO tool_effects(id,status,updated_at,record_json,holder_pid,owner_key,task_id,task_run_id) VALUES (?,?,?,?,?,?,?,?)").run(record.id, record.status, record.at, JSON.stringify(record), process.pid, record.scope.ownerKey ?? null, record.taskId ?? null, record.taskRunId ?? null); }
	private updateState(record: ToolEffectRecord): void { this.db.prepare("UPDATE tool_effects SET status=?,updated_at=?,record_json=?,holder_pid=?,owner_key=?,task_id=?,task_run_id=? WHERE id=?").run(record.status, record.at, JSON.stringify(record), record.status === "planned" || record.status === "executing" ? process.pid : null, record.scope.ownerKey ?? null, record.taskId ?? null, record.taskRunId ?? null, record.id); }
	private insertEvent(record: ToolEffectRecord): void { this.db.prepare("INSERT INTO tool_effect_events(effect_id,record_json) VALUES (?,?)").run(record.id, JSON.stringify(record)); }
	private insertEventIfMissing(record: ToolEffectRecord): void { const json = JSON.stringify(record); this.db.prepare("INSERT INTO tool_effect_events(effect_id,record_json) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM tool_effect_events WHERE effect_id=? AND record_json=?)").run(record.id, json, record.id, json); }
	private trimEvents(): void { this.db.prepare("DELETE FROM tool_effect_events WHERE seq <= COALESCE((SELECT MAX(seq) - ? FROM tool_effect_events), 0)").run(this.eventLimit); }
	private pruneTerminalWithoutReplayIdentity(olderThan: number): void {
		this.db.prepare(`DELETE FROM tool_effects WHERE updated_at < ? AND status IN ('committed','failed')
			AND NOT EXISTS (SELECT 1 FROM tool_effect_identities WHERE effect_id = tool_effects.id)`).run(olderThan);
	}
	private backfillTaskProjectionColumns(): void {
		if (this.db.prepare("SELECT 1 FROM tool_effect_meta WHERE key='task_projection_backfilled_v1'").get()) return;
		const rows = this.db.prepare("SELECT id,record_json FROM tool_effects WHERE owner_key IS NULL OR task_id IS NULL").all() as Array<StoredEffectRow & { id: string }>;
		const update = this.db.prepare("UPDATE tool_effects SET owner_key=?,task_id=?,task_run_id=? WHERE id=?");
		this.db.transaction(() => {
			for (const row of rows) {
				let record: ToolEffectRecord;
				try { record = parseEffect(row.record_json); } catch { continue; }
				update.run(record.scope.ownerKey ?? null, record.taskId ?? null, record.taskRunId ?? null, row.id);
			}
			this.db.prepare("INSERT INTO tool_effect_meta(key,value) VALUES ('task_projection_backfilled_v1','1')").run();
		}).immediate();
	}
	private migrateLegacyAuthority(): void {
		const exists = this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='tool_effect_authority'").get() as { present: number } | undefined;
		if (!exists) return;
		const rows = this.db.prepare("SELECT identity,effect_id,status,updated_at FROM tool_effect_authority").all() as Array<{ identity: string; effect_id: string; status: ToolEffectStatus; updated_at: number }>;
		this.db.transaction(() => {
			for (const row of rows) {
				let ownerKey = "legacy"; let idempotencyKey: string | undefined;
				try { const identity = JSON.parse(row.identity) as unknown; if (Array.isArray(identity)) { ownerKey = String(identity.at(-2) ?? "legacy"); idempotencyKey = safeText(identity.at(-1), 256); } } catch { /* retain an opaque tombstone */ }
				const record: ToolEffectRecord = { id: row.effect_id, toolCallId: "legacy", toolName: "legacy_effect", sideEffect: "external", status: row.status, at: row.updated_at, scope: { ownerKey, platform: "legacy", chatId: ownerKey }, ...(idempotencyKey ? { idempotencyKey } : {}) };
				if (!this.effect(record.id)) { this.insertState(record); this.insertEvent(record); }
				this.db.prepare("INSERT OR IGNORE INTO tool_effect_identities(identity,effect_id) VALUES (?,?)").run(row.identity, row.effect_id);
				if (idempotencyKey) this.db.prepare("INSERT OR IGNORE INTO tool_effect_identities(identity,effect_id) VALUES (?,?)").run(JSON.stringify(["v2", ownerKey, idempotencyKey]), row.effect_id);
			}
			this.trimEvents();
		}).immediate();
	}
}

function callKey(source: BeeMaxRuntimeSource, toolCallId: string): string { return `${sessionKeyForSource(source)}:${toolCallId}`; }

function scopeOf(source: BeeMaxRuntimeSource): ToolEffectRecord["scope"] {
	const ownerKey = source.delegatedTask?.ownerKey ?? responsibilityOwnerKey(source);
	return { ownerKey, platform: source.platform, chatId: source.chatId, userId: source.userIdAlt ?? source.userId, threadId: source.threadId };
}

function identitiesFor(scope: ToolEffectRecord["scope"], key: string): string[] {
	const legacyOwner = `${scope.platform}:${scope.chatId}:${scope.userId ?? "anon"}`;
	const owner = scope.ownerKey ?? legacyOwner;
	return [...new Set([JSON.stringify(["v2", owner, key]), ...(scope.ownerKey ? [] : [...(scope.userId ? [JSON.stringify(["v2", `user:${scope.userId}`, key])] : []), JSON.stringify(["v1", legacyOwner, key])])])];
}

function compensationIdentity(scope: ToolEffectRecord["scope"], effectId: string): string {
	return JSON.stringify(["compensation", scope.ownerKey ?? `${scope.platform}:${scope.chatId}:${scope.userId ?? "anon"}`, effectId]);
}

export function createToolEffectDetails(input: { operation: string; provider: string; resourceType: string; resourceId: string; idempotencyKey?: string }): { beemaxEffect: { operation: string; externalRef: string; idempotencyKey?: string; proof: ToolEffectProof } } {
	const operation = requiredSafeText(input.operation, 1_000, "operation");
	const proof = { provider: requiredSafeText(input.provider, 128, "provider"), resourceType: requiredSafeText(input.resourceType, 128, "resourceType"), resourceId: requiredSafeText(input.resourceId, 512, "resourceId") };
	const idempotencyKey = safeText(input.idempotencyKey, 256);
	return { beemaxEffect: { operation, externalRef: `${proof.provider}:${proof.resourceType}:${proof.resourceId}`, ...(idempotencyKey ? { idempotencyKey } : {}), proof } };
}

function receiptOf(record: ToolEffectRecord, metadata: { operation?: string; externalRef?: string; proof?: ToolEffectProof }, occurredAt: number): ToolEffectReceipt {
	const operation = metadata.operation ?? record.toolName;
	const idempotencyKey = record.idempotencyKey;
	return { status: "committed", occurredAt, operation, ...(metadata.externalRef ? { externalRef: metadata.externalRef } : {}), ...(idempotencyKey ? { idempotencyKey } : {}), ...(metadata.proof ? { proof: metadata.proof } : {}) };
}

function effectMetadata(details: unknown): { operation?: string; externalRef?: string; proof?: ToolEffectProof } {
	const effect = recordOf(recordOf(details).beemaxEffect);
	const rawProof = recordOf(effect.proof);
	const provider = safeText(rawProof.provider, 128); const resourceType = safeText(rawProof.resourceType, 128); const resourceId = safeText(rawProof.resourceId, 512);
	return {
		operation: safeText(effect.operation, 1_000),
		externalRef: safeText(effect.externalRef, 1_000),
		...(provider && resourceType && resourceId ? { proof: { provider, resourceType, resourceId } } : {}),
	};
}

function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text && text.length <= maxLength && !containsCredentialMaterial(text) ? text : undefined;
}
function requiredSafeText(value: unknown, maxLength: number, field: string): string { const text = safeText(value, maxLength); if (!text) throw new Error(`Tool Effect ${field} is invalid`); return text; }

function parseEffect(json: string): ToolEffectRecord {
	const value = JSON.parse(json) as ToolEffectRecord;
	if (!isEffectRecord(value)) throw new Error("Tool Effect Ledger is corrupt");
	return value;
}

function processIsAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function isEffectRecord(value: ToolEffectRecord): boolean {
	return Boolean(value && typeof value === "object" && typeof value.id === "string" && typeof value.toolCallId === "string"
		&& typeof value.toolName === "string" && (value.sideEffect === "local" || value.sideEffect === "external")
		&& ["planned", "executing", "committed", "failed", "unknown"].includes(value.status) && typeof value.at === "number"
		&& (value.compensatesEffectId === undefined || typeof value.compensatesEffectId === "string" && value.compensatesEffectId.length > 0 && value.compensatesEffectId.length <= 512)
		&& value.scope && typeof value.scope.platform === "string" && typeof value.scope.chatId === "string");
}

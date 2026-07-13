import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { BoundedJsonlJournal } from "./bounded-jsonl-journal.ts";
import { sessionKeyForSource } from "./session-coordinator.ts";
import type { ToolPolicy } from "./tool-runtime.ts";
import { containsCredentialMaterial } from "./credential-material.ts";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { chmodSync, existsSync } from "node:fs";
import { conversationOwnerKey } from "./agent-scope.ts";

export type ToolEffectStatus = "planned" | "executing" | "committed" | "failed" | "unknown";
export interface ToolEffectReceipt { status: "committed"; occurredAt: number; operation: string; externalRef?: string; idempotencyKey?: string; }
export class ToolEffectConflictError extends Error { override readonly name = "ToolEffectConflictError"; }

export interface ToolEffectRecord {
	id: string;
	taskId?: string;
	toolCallId: string;
	toolName: string;
	sideEffect: "local" | "external";
	status: ToolEffectStatus;
	at: number;
	scope: { ownerKey?: string; platform: string; chatId: string; userId?: string; threadId?: string };
	idempotencyKey?: string;
	receipt?: ToolEffectReceipt;
}

export interface ToolEffectStart {
	source: BeeMaxRuntimeSource;
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
}

/** Content-free, profile-local Effect journal for reconciling interrupted mutations. */
export class FileToolEffectJournal implements ToolEffectSink {
	private readonly journal: BoundedJsonlJournal<ToolEffectRecord>;
	private readonly active = new Map<string, ToolEffectRecord>();
	private readonly latest = new Map<string, ToolEffectRecord>();
	private readonly authority: ToolEffectAuthority;

	constructor(path: string, limit = 5_000) {
		this.journal = new BoundedJsonlJournal({ path, limit, minLimit: 100, maxLimit: 50_000, isRecord: isEffectRecord });
		this.authority = new ToolEffectAuthority(`${path}.authority.sqlite`);
		this.rebuildIndexes();
		this.authority.import(this.latest.values());
		this.recoverInterrupted();
		this.rebuildIndexes();
	}

	begin(input: ToolEffectStart): string | undefined {
		if (input.policy.sideEffect === "none") return undefined;
		const idempotencyKey = safeText(recordOf(input.args).idempotencyKey, 256);
		const scope = scopeOf(input.source);
		const at = Date.now();
		const recordId = crypto.randomUUID();
		if (idempotencyKey) this.authority.reserve(idempotencyIdentity(scope, idempotencyKey), recordId, at);
		const record: ToolEffectRecord = {
			id: recordId,
			...(input.taskId ? { taskId: input.taskId } : {}),
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			sideEffect: input.policy.sideEffect,
			status: "planned",
			at,
			scope,
			...(idempotencyKey ? { idempotencyKey } : {}),
		};
		this.append(record);
		const executing = { ...record, status: "executing" as const, at: Date.now() };
		this.append(executing);
		this.active.set(callKey(input.source, input.toolCallId), executing);
		return record.id;
	}

	finish(input: ToolEffectFinish): void {
		const key = callKey(input.source, input.toolCallId);
		const active = this.active.get(key);
		if (!active) return;
		this.active.delete(key);
		const at = Date.now();
		const metadata = effectMetadata(input.details);
		const status = input.isError || active.sideEffect === "external" && !metadata.externalRef ? "unknown" : "committed";
		this.append({
			...active,
			status,
			at,
			...(status === "committed" ? { receipt: receiptOf(active, metadata, at) } : {}),
		});
		if (active.idempotencyKey) this.authority.setStatus(active.id, status, at);
	}

	interruptTask(taskId: string): number {
		let interrupted = 0;
		for (const [key, record] of this.active) {
			if (record.taskId !== taskId) continue;
			this.active.delete(key);
			const at = Date.now();
			this.append({ ...record, status: "unknown", at, receipt: undefined });
			if (record.idempotencyKey) this.authority.setStatus(record.id, "unknown", at);
			interrupted++;
		}
		return interrupted;
	}

	reconcile(effectId: string, resolution: { status: "committed" | "failed"; operation?: string; externalRef?: string }): boolean {
		const current = this.latest.get(effectId);
		if (!current || current.status !== "unknown") return false;
		const at = Date.now();
		const operation = safeText(resolution.operation, 1_000) ?? current.toolName;
		const externalRef = safeText(resolution.externalRef, 1_000);
		this.append({
			...current,
			status: resolution.status,
			at,
			receipt: resolution.status === "committed" ? { status: "committed", occurredAt: at, operation, ...(externalRef ? { externalRef } : {}), ...(current.idempotencyKey ? { idempotencyKey: current.idempotencyKey } : {}) } : undefined,
		});
		if (current.idempotencyKey) this.authority.setStatus(current.id, resolution.status, at);
		return true;
	}

	events(): ToolEffectRecord[] { return this.journal.records(); }

	private recoverInterrupted(): void {
		const latest = new Map<string, ToolEffectRecord>();
		for (const record of this.journal.records()) latest.set(record.id, record);
		for (const record of latest.values()) {
			if (record.status !== "planned" && record.status !== "executing") continue;
			this.append({ ...record, status: "unknown", at: Date.now(), receipt: undefined });
		}
	}

	private append(record: ToolEffectRecord): void {
		this.journal.append(record);
		this.latest.set(record.id, record);
	}

	private rebuildIndexes(): void {
		this.latest.clear();
		for (const record of this.journal.records()) this.latest.set(record.id, record);
	}
}

interface EffectAuthorityRow { status: ToolEffectStatus; }

/** Atomic replay authority kept separate from the bounded operational event journal. */
class ToolEffectAuthority {
	private readonly db: DatabaseType;
	private readonly reserveTransaction: (identity: string, effectId: string, at: number) => void;

	constructor(path: string) {
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this.db.exec(`CREATE TABLE IF NOT EXISTS tool_effect_authority (
			identity TEXT PRIMARY KEY,
			effect_id TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL CHECK (status IN ('planned','executing','committed','failed','unknown')),
			updated_at INTEGER NOT NULL
		)`);
		if (existsSync(path)) chmodSync(path, 0o600);
		this.reserveTransaction = this.db.transaction((identity: string, effectId: string, at: number) => {
			const current = this.db.prepare("SELECT status FROM tool_effect_authority WHERE identity = ?").get(identity) as EffectAuthorityRow | undefined;
			if (current?.status === "committed") throw new ToolEffectConflictError("Effect with this idempotency key is already committed in the current owner scope");
			if (current && current.status !== "failed") throw new ToolEffectConflictError("Effect with this idempotency key is unresolved in the current owner scope; reconcile it before retrying");
			this.db.prepare(`INSERT INTO tool_effect_authority(identity, effect_id, status, updated_at) VALUES (?, ?, 'executing', ?)
				ON CONFLICT(identity) DO UPDATE SET effect_id = excluded.effect_id, status = excluded.status, updated_at = excluded.updated_at`).run(identity, effectId, at);
		}).immediate;
	}

	reserve(identity: string, effectId: string, at: number): void { this.reserveTransaction(identity, effectId, at); }

	setStatus(effectId: string, status: ToolEffectStatus, at: number): void {
		this.db.prepare("UPDATE tool_effect_authority SET status = ?, updated_at = ? WHERE effect_id = ?").run(status, at, effectId);
	}

	import(records: Iterable<ToolEffectRecord>): void {
		const statement = this.db.prepare(`INSERT INTO tool_effect_authority(identity, effect_id, status, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(identity) DO UPDATE SET effect_id = excluded.effect_id, status = excluded.status, updated_at = excluded.updated_at
			WHERE excluded.updated_at >= tool_effect_authority.updated_at`);
		const migrate = this.db.transaction(() => {
			for (const record of records) if (record.idempotencyKey) statement.run(idempotencyIdentity(record.scope, record.idempotencyKey), record.id, record.status, record.at);
		});
		migrate.immediate();
	}
}

function callKey(source: BeeMaxRuntimeSource, toolCallId: string): string { return `${sessionKeyForSource(source)}:${toolCallId}`; }

function scopeOf(source: BeeMaxRuntimeSource): ToolEffectRecord["scope"] {
	const ownerKey = source.delegatedTask?.ownerKey ?? (source.userIdAlt ? `user:${source.userIdAlt}` : conversationOwnerKey(source));
	return { ownerKey, platform: source.platform, chatId: source.chatId, userId: source.userIdAlt ?? source.userId, threadId: source.threadId };
}

function idempotencyIdentity(scope: ToolEffectRecord["scope"], key: string): string {
	return JSON.stringify([scope.ownerKey ?? `${scope.platform}:${scope.chatId}:${scope.userId ?? "anon"}`, key]);
}

function receiptOf(record: ToolEffectRecord, metadata: { operation?: string; externalRef?: string }, occurredAt: number): ToolEffectReceipt {
	const operation = metadata.operation ?? record.toolName;
	const idempotencyKey = record.idempotencyKey;
	return { status: "committed", occurredAt, operation, ...(metadata.externalRef ? { externalRef: metadata.externalRef } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) };
}

function effectMetadata(details: unknown): { operation?: string; externalRef?: string } {
	const effect = recordOf(recordOf(details).beemaxEffect);
	return {
		operation: safeText(effect.operation, 1_000),
		externalRef: safeText(effect.externalRef, 1_000),
	};
}

function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text && text.length <= maxLength && !containsCredentialMaterial(text) ? text : undefined;
}

function isEffectRecord(value: ToolEffectRecord): boolean {
	return Boolean(value && typeof value === "object" && typeof value.id === "string" && typeof value.toolCallId === "string"
		&& typeof value.toolName === "string" && (value.sideEffect === "local" || value.sideEffect === "external")
		&& ["planned", "executing", "committed", "failed", "unknown"].includes(value.status) && typeof value.at === "number"
		&& value.scope && typeof value.scope.platform === "string" && typeof value.scope.chatId === "string");
}

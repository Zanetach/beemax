import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { BoundedJsonlJournal } from "./bounded-jsonl-journal.ts";
import { sessionKeyForSource } from "./session-coordinator.ts";
import type { ToolPolicy } from "./tool-runtime.ts";
import { containsCredentialMaterial } from "./credential-material.ts";

export type ToolEffectStatus = "planned" | "executing" | "committed" | "failed" | "unknown";
export interface ToolEffectReceipt { status: "committed"; occurredAt: number; operation: string; externalRef?: string; idempotencyKey?: string; }

export interface ToolEffectRecord {
	id: string;
	taskId?: string;
	toolCallId: string;
	toolName: string;
	sideEffect: "local" | "external";
	status: ToolEffectStatus;
	at: number;
	scope: { platform: string; chatId: string; userId?: string; threadId?: string };
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
	private readonly idempotencyStates = new Map<string, ToolEffectStatus>();

	constructor(path: string, limit = 5_000) {
		this.journal = new BoundedJsonlJournal({ path, limit, minLimit: 100, maxLimit: 50_000, isRecord: isEffectRecord });
		this.rebuildIndexes();
		this.recoverInterrupted();
		this.rebuildIndexes();
	}

	begin(input: ToolEffectStart): string | undefined {
		if (input.policy.sideEffect === "none") return undefined;
		const idempotencyKey = safeText(recordOf(input.args).idempotencyKey, 256);
		const scope = scopeOf(input.source);
		if (idempotencyKey) {
			const state = this.idempotencyStates.get(idempotencyIdentity(scope, idempotencyKey));
			if (state === "committed") throw new Error("Effect with this idempotency key is already committed in the current scope");
			if (state === "planned" || state === "executing" || state === "unknown") throw new Error("Effect with this idempotency key is unresolved in the current scope; reconcile it before retrying");
		}
		const at = Date.now();
		const record: ToolEffectRecord = {
			id: crypto.randomUUID(),
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
		this.append({
			...active,
			status: input.isError ? "unknown" : "committed",
			at,
			...(input.isError ? {} : { receipt: receiptOf(active, metadata, at) }),
		});
	}

	interruptTask(taskId: string): number {
		let interrupted = 0;
		for (const [key, record] of this.active) {
			if (record.taskId !== taskId) continue;
			this.active.delete(key);
			this.append({ ...record, status: "unknown", at: Date.now(), receipt: undefined });
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
		if (record.idempotencyKey) this.idempotencyStates.set(idempotencyIdentity(record.scope, record.idempotencyKey), record.status);
	}

	private rebuildIndexes(): void {
		this.latest.clear(); this.idempotencyStates.clear();
		for (const record of this.journal.records()) this.latest.set(record.id, record);
		for (const record of this.journal.records()) if (record.idempotencyKey) this.idempotencyStates.set(idempotencyIdentity(record.scope, record.idempotencyKey), record.status);
	}
}

function callKey(source: BeeMaxRuntimeSource, toolCallId: string): string { return `${sessionKeyForSource(source)}:${toolCallId}`; }

function scopeOf(source: BeeMaxRuntimeSource): ToolEffectRecord["scope"] {
	return { platform: source.platform, chatId: source.chatId, userId: source.userIdAlt ?? source.userId, threadId: source.threadId };
}

function idempotencyIdentity(scope: ToolEffectRecord["scope"], key: string): string {
	return JSON.stringify([scope.platform, scope.chatId, scope.userId ?? "", scope.threadId ?? "", key]);
}

function receiptOf(record: ToolEffectRecord, metadata: { operation?: string; externalRef?: string; idempotencyKey?: string }, occurredAt: number): ToolEffectReceipt {
	const operation = metadata.operation ?? record.toolName;
	const idempotencyKey = record.idempotencyKey ?? metadata.idempotencyKey;
	return { status: "committed", occurredAt, operation, ...(metadata.externalRef ? { externalRef: metadata.externalRef } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) };
}

function effectMetadata(details: unknown): { operation?: string; externalRef?: string; idempotencyKey?: string } {
	const effect = recordOf(recordOf(details).beemaxEffect);
	return {
		operation: safeText(effect.operation, 1_000),
		externalRef: safeText(effect.externalRef, 1_000),
		idempotencyKey: safeText(effect.idempotencyKey, 256),
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

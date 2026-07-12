import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { BoundedJsonlJournal } from "./bounded-jsonl-journal.ts";
import { sessionKeyForSource } from "./session-coordinator.ts";
import type { ToolPolicy } from "./tool-runtime.ts";

export type ToolEffectStatus = "planned" | "executing" | "committed" | "unknown";

export interface ToolEffectRecord {
	id: string;
	taskId?: string;
	toolCallId: string;
	toolName: string;
	sideEffect: "local" | "external";
	status: ToolEffectStatus;
	at: number;
	scope: { platform: string; chatId: string; userId?: string; threadId?: string };
	receipt?: { status: "committed"; occurredAt: number };
}

export interface ToolEffectStart {
	source: BeeMaxRuntimeSource;
	taskId?: string;
	toolCallId: string;
	toolName: string;
	policy: ToolPolicy;
}

export interface ToolEffectFinish extends Omit<ToolEffectStart, "taskId"> {
	isError: boolean;
}

export interface ToolEffectSink {
	begin(input: ToolEffectStart): string | undefined;
	finish(input: ToolEffectFinish): void;
	interruptTask?(taskId: string): number;
}

/** Content-free, profile-local Effect journal for reconciling interrupted mutations. */
export class FileToolEffectJournal implements ToolEffectSink {
	private readonly journal: BoundedJsonlJournal<ToolEffectRecord>;
	private readonly active = new Map<string, ToolEffectRecord>();

	constructor(path: string, limit = 5_000) {
		this.journal = new BoundedJsonlJournal({ path, limit, minLimit: 100, maxLimit: 50_000, isRecord: isEffectRecord });
		this.recoverInterrupted();
	}

	begin(input: ToolEffectStart): string | undefined {
		if (input.policy.sideEffect === "none") return undefined;
		const at = Date.now();
		const record: ToolEffectRecord = {
			id: crypto.randomUUID(),
			...(input.taskId ? { taskId: input.taskId } : {}),
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			sideEffect: input.policy.sideEffect,
			status: "planned",
			at,
			scope: scopeOf(input.source),
		};
		this.journal.append(record);
		const executing = { ...record, status: "executing" as const, at: Date.now() };
		this.journal.append(executing);
		this.active.set(callKey(input.source, input.toolCallId), executing);
		return record.id;
	}

	finish(input: ToolEffectFinish): void {
		const key = callKey(input.source, input.toolCallId);
		const active = this.active.get(key);
		if (!active) return;
		this.active.delete(key);
		const at = Date.now();
		this.journal.append({
			...active,
			status: input.isError ? "unknown" : "committed",
			at,
			...(input.isError ? {} : { receipt: { status: "committed" as const, occurredAt: at } }),
		});
	}

	interruptTask(taskId: string): number {
		let interrupted = 0;
		for (const [key, record] of this.active) {
			if (record.taskId !== taskId) continue;
			this.active.delete(key);
			this.journal.append({ ...record, status: "unknown", at: Date.now(), receipt: undefined });
			interrupted++;
		}
		return interrupted;
	}

	events(): ToolEffectRecord[] { return this.journal.records(); }

	private recoverInterrupted(): void {
		const latest = new Map<string, ToolEffectRecord>();
		for (const record of this.journal.records()) latest.set(record.id, record);
		for (const record of latest.values()) {
			if (record.status !== "planned" && record.status !== "executing") continue;
			this.journal.append({ ...record, status: "unknown", at: Date.now(), receipt: undefined });
		}
	}
}

function callKey(source: BeeMaxRuntimeSource, toolCallId: string): string { return `${sessionKeyForSource(source)}:${toolCallId}`; }

function scopeOf(source: BeeMaxRuntimeSource): ToolEffectRecord["scope"] {
	return { platform: source.platform, chatId: source.chatId, userId: source.userIdAlt ?? source.userId, threadId: source.threadId };
}

function isEffectRecord(value: ToolEffectRecord): boolean {
	return Boolean(value && typeof value === "object" && typeof value.id === "string" && typeof value.toolCallId === "string"
		&& typeof value.toolName === "string" && (value.sideEffect === "local" || value.sideEffect === "external")
		&& ["planned", "executing", "committed", "unknown"].includes(value.status) && typeof value.at === "number"
		&& value.scope && typeof value.scope.platform === "string" && typeof value.scope.chatId === "string");
}

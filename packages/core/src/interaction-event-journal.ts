import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { InteractionEvent } from "./interaction-runtime.ts";
import { BoundedJsonlJournal } from "./bounded-jsonl-journal.ts";

/** Durable state transitions only. Answer/reasoning deltas are deliberately excluded. */
export type DurableInteractionEvent = Exclude<InteractionEvent, { type: "answer.delta" } | { type: "reasoning.delta" }>;

export interface InteractionEventJournal {
	append(event: InteractionEvent): void;
	events(sessionId: string, afterSequence?: number): DurableInteractionEvent[];
	lastSequence(sessionId: string): number;
}

/**
 * Append-only local journal for reconnect and crash recovery. It never writes
 * user messages, assistant text, reasoning, or tool output summaries.
 */
export class FileInteractionEventJournal implements InteractionEventJournal {
	private readonly journal: BoundedJsonlJournal<DurableInteractionEvent>;
	private readonly sequencePath: string;
	private readonly lastSequences = new Map<string, number>();
	private sequenceFloor = 0;

	constructor(path: string, limit = 2_000) {
		this.sequencePath = `${path}.sequences.json`;
		this.loadSequenceIndex();
		this.journal = new BoundedJsonlJournal({ path, limit, minLimit: 20, maxLimit: 20_000, isRecord: isDurableEvent, onCompacting: (records) => this.persistSequenceIndex(records.slice(-Math.max(1, Math.floor(Math.max(20, Math.min(limit, 20_000)) * 0.8)))) });
		for (const event of this.journal.records()) this.rememberSequence(event);
	}

	append(event: InteractionEvent): void {
		const durable = durableEvent(event);
		if (!durable) return;
		this.rememberSequence(durable);
		this.journal.append(durable);
	}

	events(sessionId: string, afterSequence = 0): DurableInteractionEvent[] {
		return this.journal.records().filter((event) => event.sessionId === sessionId && event.sequence > afterSequence);
	}

	lastSequence(sessionId: string): number { return this.lastSequences.get(sessionId) ?? this.sequenceFloor; }

	private rememberSequence(event: DurableInteractionEvent): void {
		this.lastSequences.set(event.sessionId, Math.max(this.lastSequences.get(event.sessionId) ?? 0, event.sequence));
	}

	private loadSequenceIndex(): void {
		if (!existsSync(this.sequencePath)) return;
		try {
			chmodSync(this.sequencePath, 0o600);
			const value = JSON.parse(readFileSync(this.sequencePath, "utf8")) as Record<string, unknown>;
			for (const [sessionId, sequence] of Object.entries(value)) if (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0) {
				if (sessionId === "__sequenceFloor") this.sequenceFloor = sequence; else this.lastSequences.set(sessionId, sequence);
			}
		} catch { /* The event journal remains authoritative when the optional index is corrupt. */ }
	}

	private persistSequenceIndex(retained: DurableInteractionEvent[]): void {
		const live = new Set(retained.map((event) => event.sessionId));
		for (const [sessionId, sequence] of this.lastSequences) if (!live.has(sessionId)) { this.sequenceFloor = Math.max(this.sequenceFloor, sequence); this.lastSequences.delete(sessionId); }
		const temporary = `${this.sequencePath}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ __sequenceFloor: this.sequenceFloor, ...Object.fromEntries(this.lastSequences) }), { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, this.sequencePath);
	}
}

export function durableEvent(event: InteractionEvent): DurableInteractionEvent | undefined {
	if (event.type === "answer.delta" || event.type === "reasoning.delta") return undefined;
	if (event.type === "turn.finished") return { ...event, result: { ...event.result, answer: "[not persisted]" } };
	if (event.type === "turn.failed") return { ...event, error: "Turn failed (details are not persisted)" };
	if (event.type === "tool.changed") {
		const { summary: _summary, ...safe } = event;
		return safe;
	}
	return event;
}

function isDurableEvent(event: DurableInteractionEvent): boolean {
	return Boolean(event && typeof event === "object" && typeof event.type === "string" && typeof event.sessionId === "string" && typeof event.sequence === "number");
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InteractionEvent } from "./interaction-runtime.ts";

/** Durable state transitions only. Answer/reasoning deltas are deliberately excluded. */
export type DurableInteractionEvent = Exclude<InteractionEvent, { type: "answer.delta" } | { type: "reasoning.delta" }>;

export interface InteractionEventJournal {
	append(event: InteractionEvent): void;
	events(sessionId: string, afterSequence?: number): DurableInteractionEvent[];
}

/**
 * Append-only local journal for reconnect and crash recovery. It never writes
 * user messages, assistant text, reasoning, or tool output summaries.
 */
export class FileInteractionEventJournal implements InteractionEventJournal {
	private readonly path: string;
	private readonly limit: number;

	constructor(path: string, limit = 2_000) {
		this.path = path;
		this.limit = Math.max(20, Math.min(limit, 20_000));
		mkdirSync(dirname(path), { recursive: true });
	}

	append(event: InteractionEvent): void {
		const durable = durableEvent(event);
		if (!durable) return;
		appendFileSync(this.path, `${JSON.stringify(durable)}\n`, { encoding: "utf8", mode: 0o600 });
		this.compactIfNeeded();
	}

	events(sessionId: string, afterSequence = 0): DurableInteractionEvent[] {
		return this.read().filter((event) => event.sessionId === sessionId && event.sequence > afterSequence);
	}

	private read(): DurableInteractionEvent[] {
		if (!existsSync(this.path)) return [];
		try {
			return readFileSync(this.path, "utf8").split("\n").flatMap((line) => {
				if (!line.trim()) return [];
				try { const event = JSON.parse(line) as DurableInteractionEvent; return isDurableEvent(event) ? [event] : []; }
				catch { return []; }
			}).slice(-this.limit);
		} catch { return []; }
	}

	private compactIfNeeded(): void {
		const events = this.read();
		if (events.length < this.limit) return;
		// A bounded rewrite is safe here because each record is an independent
		// recovery hint; a malformed or interrupted line is ignored on read.
		writeFileSync(this.path, `${events.slice(-this.limit).map((event) => JSON.stringify(event)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
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

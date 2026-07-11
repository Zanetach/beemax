import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolRuntimeAuditEvent, ToolRuntimeAuditSink } from "./tool-runtime.ts";

export interface DurableToolAuditEvent extends Omit<ToolRuntimeAuditEvent, "source" | "reason"> {
	scope: { platform: string; chatId: string; userId?: string; threadId?: string };
	hasReason?: boolean;
}

/** Profile-local, content-free JSONL audit journal for Tool policy decisions and executions. */
export class FileToolAuditJournal {
	private readonly path: string;
	private readonly limit: number;
	readonly append: ToolRuntimeAuditSink;

	constructor(path: string, limit = 5_000) {
		this.path = path;
		this.limit = Math.max(100, Math.min(limit, 50_000));
		mkdirSync(dirname(path), { recursive: true });
		if (existsSync(path)) chmodSync(path, 0o600);
		this.append = (event) => {
			const { source, reason, ...operational } = event;
			const durable: DurableToolAuditEvent = {
				...operational,
				hasReason: reason ? true : undefined,
				scope: { platform: source.platform, chatId: source.chatId, userId: source.userIdAlt ?? source.userId, threadId: source.threadId },
			};
			appendFileSync(this.path, `${JSON.stringify(durable)}\n`, { encoding: "utf8", mode: 0o600 });
			this.compactIfNeeded();
		};
	}

	events(): DurableToolAuditEvent[] {
		if (!existsSync(this.path)) return [];
		try {
			return readFileSync(this.path, "utf8").split("\n").flatMap((line) => {
				if (!line.trim()) return [];
				try { const event = JSON.parse(line) as DurableToolAuditEvent; return isAuditEvent(event) ? [event] : []; } catch { return []; }
			}).slice(-this.limit);
		} catch { return []; }
	}

	private compactIfNeeded(): void {
		const lines = readFileSync(this.path, "utf8").split("\n").filter((line) => line.trim());
		if (lines.length <= this.limit) return;
		// Keep headroom so a busy Agent does not rewrite the journal on every Tool event.
		const retained = lines.slice(-Math.max(100, Math.floor(this.limit * 0.8)));
		writeFileSync(this.path, `${retained.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
	}
}

function isAuditEvent(event: DurableToolAuditEvent): boolean {
	return Boolean(event && typeof event === "object" && typeof event.phase === "string" && typeof event.toolName === "string" && typeof event.at === "number" && event.scope && typeof event.scope.platform === "string");
}

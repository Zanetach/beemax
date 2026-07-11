import type { ToolRuntimeAuditEvent, ToolRuntimeAuditSink } from "./tool-runtime.ts";
import { BoundedJsonlJournal } from "./bounded-jsonl-journal.ts";

export interface DurableToolAuditEvent extends Omit<ToolRuntimeAuditEvent, "source" | "reason"> {
	scope: { platform: string; chatId: string; userId?: string; threadId?: string };
	hasReason?: boolean;
}

/** Profile-local, content-free JSONL audit journal for Tool policy decisions and executions. */
export class FileToolAuditJournal {
	private readonly journal: BoundedJsonlJournal<DurableToolAuditEvent>;
	readonly append: ToolRuntimeAuditSink;

	constructor(path: string, limit = 5_000) {
		this.journal = new BoundedJsonlJournal({ path, limit, minLimit: 100, maxLimit: 50_000, isRecord: isAuditEvent });
		this.append = (event) => {
			const { source, reason, ...operational } = event;
			const durable: DurableToolAuditEvent = {
				...operational,
				hasReason: reason ? true : undefined,
				scope: { platform: source.platform, chatId: source.chatId, userId: source.userIdAlt ?? source.userId, threadId: source.threadId },
			};
			this.journal.append(durable);
		};
	}

	events(): DurableToolAuditEvent[] {
		return this.journal.records();
	}
}

function isAuditEvent(event: DurableToolAuditEvent): boolean {
	return Boolean(event && typeof event === "object" && typeof event.phase === "string" && typeof event.toolName === "string" && typeof event.at === "number" && event.scope && typeof event.scope.platform === "string");
}

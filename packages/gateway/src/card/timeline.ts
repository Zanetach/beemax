/**
 * Card timeline: ordered list of reasoning / tool / notice entries rendered
 * into the collapsible "思考与工具" panel. Ported from card_timeline.py.
 */

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

export type TimelineKind = "reasoning" | "tool" | "notice";

export interface TimelineEntry {
	kind: TimelineKind;
	title: string;
	status: string;
	content: string;
	detail: string;
	toolId: string;
	noticeId: string;
}

export class CardTimeline {
	private entries: TimelineEntry[] = [];
	private openReasoningIndex: number | null = null;
	private reasoningCount = 0;
	private toolEntryById = new Map<string, number>();
	private noticeEntryById = new Map<string, number>();

	get entryCount(): number {
		return this.entries.length;
	}

	recordReasoning(text: string, replace = false): void {
		if (!text && !replace) return;
		if (replace && this.openReasoningIndex !== null) {
			this.entries[this.openReasoningIndex].content = text;
			return;
		}
		if (!text) return;
		if (this.openReasoningIndex === null) {
			this.reasoningCount++;
			this.entries.push({
				kind: "reasoning",
				title: `思考 ${this.reasoningCount}`,
				status: "running",
				content: text,
				detail: "",
				toolId: "",
				noticeId: "",
			});
			this.openReasoningIndex = this.entries.length - 1;
			return;
		}
		this.entries[this.openReasoningIndex].content += text;
	}

	recordTool(toolId: string, name: string, status: string, detail = ""): void {
		if (!toolId) return;
		this.finishOpenReasoning();
		const title = name || toolId;
		const normalized = status || "running";
		const existing = this.toolEntryById.get(toolId);
		if (existing !== undefined) {
			const entry = this.entries[existing];
			if (!TERMINAL_TOOL_STATUSES.has(entry.status.toLowerCase())) {
				entry.title = title;
				entry.status = normalized;
				if (detail) entry.detail = detail;
				return;
			}
		}
		this.entries.push({ kind: "tool", title, status: normalized, detail, content: "", toolId, noticeId: "" });
		this.toolEntryById.set(toolId, this.entries.length - 1);
	}

	recordNotice(noticeId: string, title: string, status: string, content: string): void {
		if (!content && !title) return;
		this.finishOpenReasoning();
		const id = noticeId?.trim() ?? "";
		const t = title?.trim() || "运行提示";
		const s = status?.trim() || "info";
		const existing = id ? this.noticeEntryById.get(id) : undefined;
		if (existing !== undefined) {
			const entry = this.entries[existing];
			entry.title = t;
			entry.status = s;
			entry.content = content;
			return;
		}
		this.entries.push({ kind: "notice", title: t, status: s, content, detail: "", toolId: "", noticeId: id });
		if (id) this.noticeEntryById.set(id, this.entries.length - 1);
	}

	complete(): void {
		this.finishOpenReasoning();
	}

	snapshot(maxItems?: number): TimelineEntry[] {
		if (!maxItems || maxItems <= 0 || this.entries.length <= maxItems) return [...this.entries];
		return this.entries.slice(-maxItems);
	}

	foldedCount(maxItems?: number): number {
		if (!maxItems || maxItems <= 0) return 0;
		return Math.max(0, this.entries.length - maxItems);
	}

	private finishOpenReasoning(): void {
		if (this.openReasoningIndex === null) return;
		this.entries[this.openReasoningIndex].status = "completed";
		this.openReasoningIndex = null;
	}
}

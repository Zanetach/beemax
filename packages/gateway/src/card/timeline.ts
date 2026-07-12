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
	private static readonly maxEntries = 100;
	private static readonly maxEntryChars = 50_000;
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
			this.entries[this.openReasoningIndex].content = text.slice(-CardTimeline.maxEntryChars);
			return;
		}
		if (!text) return;
		if (this.openReasoningIndex === null) {
			this.reasoningCount++;
			this.entries.push({
				kind: "reasoning",
				title: `思考 ${this.reasoningCount}`,
				status: "running",
					content: bounded(text),
				detail: "",
				toolId: "",
				noticeId: "",
			});
			this.openReasoningIndex = this.entries.length - 1;
			this.prune();
			return;
		}
		this.entries[this.openReasoningIndex].content = `${this.entries[this.openReasoningIndex].content}${text}`.slice(-CardTimeline.maxEntryChars);
	}

	recordTool(toolId: string, name: string, status: string, detail = ""): void {
		if (!toolId) return;
		this.finishOpenReasoning();
		const title = bounded(name || toolId, 1_000);
		const normalized = status || "running";
		const existing = this.toolEntryById.get(toolId);
		if (existing !== undefined) {
			const entry = this.entries[existing];
			if (!TERMINAL_TOOL_STATUSES.has(entry.status.toLowerCase())) {
				entry.title = title;
				entry.status = normalized;
					if (detail) entry.detail = bounded(detail);
				return;
			}
		}
		this.entries.push({ kind: "tool", title, status: normalized, detail: bounded(detail), content: "", toolId, noticeId: "" });
		this.toolEntryById.set(toolId, this.entries.length - 1);
		this.prune();
	}

	recordNotice(noticeId: string, title: string, status: string, content: string): void {
		if (!content && !title) return;
		this.finishOpenReasoning();
		const id = noticeId?.trim() ?? "";
		const t = bounded(title?.trim() || "运行提示", 1_000);
		const s = status?.trim() || "info";
		const existing = id ? this.noticeEntryById.get(id) : undefined;
		if (existing !== undefined) {
			const entry = this.entries[existing];
			entry.title = t;
			entry.status = s;
			entry.content = bounded(content);
			return;
		}
		this.entries.push({ kind: "notice", title: t, status: s, content: bounded(content), detail: "", toolId: "", noticeId: id });
		if (id) this.noticeEntryById.set(id, this.entries.length - 1);
		this.prune();
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
	private prune(): void {
		if (this.entries.length <= CardTimeline.maxEntries) return;
		const removed = this.entries.length - CardTimeline.maxEntries;
		this.entries = this.entries.slice(-CardTimeline.maxEntries);
		this.openReasoningIndex = this.openReasoningIndex === null || this.openReasoningIndex < removed ? null : this.openReasoningIndex - removed;
		this.toolEntryById.clear(); this.noticeEntryById.clear();
		this.entries.forEach((entry, index) => { if (entry.toolId) this.toolEntryById.set(entry.toolId, index); if (entry.noticeId) this.noticeEntryById.set(entry.noticeId, index); });
	}
}

function bounded(value: string, max = 50_000): string { return value.length <= max ? value : `${value.slice(0, max)}[truncated]`; }

/**
 * CardSession: accumulates streaming events into Feishu card state.
 * Stripped of interaction (approval/clarify) and attachment handling -
 * BeeMax's first cut needs answer + tools + footer.
 */

import { CardTimeline } from "./timeline.ts";
import { StreamingTextNormalizer, normalizeStreamText } from "./text.ts";

const MAX_ANSWER_CHARS = 200_000;
const ANSWER_TRUNCATED = "\n[answer truncated]";

export interface ToolState {
	toolId: string;
	name: string;
	status: string;
	detail: string;
}

export type CardStatus = "thinking" | "completed" | "incomplete" | "rejected" | "failed" | "cancelled";

export interface CardEventData {
	/** answer (message.completed) | text (thinking/answer delta) | error (failed) */
	[key: string]: unknown;
}

export class CardSession {
	status: CardStatus = "thinking";
	answerText = "";
	tools = new Map<string, ToolState>();
	tokens: Record<string, number> = {};
	model = "Unknown";
	context: Record<string, number> = {};
	duration = 0;
	private toolCallCount = 0;
	timeline = new CardTimeline();
	private thinkingNormalizer = new StreamingTextNormalizer();
	private answerNormalizer = new StreamingTextNormalizer();
	pendingApprovalId?: string;
	progressText = "";

	get toolCount(): number {
		return this.toolCallCount;
	}

	get visibleMainText(): string {
		return this.answerText;
	}

	apply(event: string, data: CardEventData): boolean {
		if (this.status !== "thinking") return false;

		switch (event) {
			case "thinking.delta": {
				const raw = String(data.text ?? "");
				const delta = this.thinkingNormalizer.feed(raw);
				if (delta) {
					this.timeline.recordReasoning(delta);
				}
				break;
			}
			case "answer.delta": {
				const delta = this.answerNormalizer.feed(String(data.text ?? ""));
				if (delta) this.answerText = boundedAnswer(this.answerText, delta);
				break;
			}
			case "tool.updated": {
				const toolId = String(data.tool_id ?? "");
				if (!toolId) return true;
				const name = String(data.name ?? toolId);
				const status = String(data.status ?? "running");
				const detail = toolDetailFromEvent(data);
				const isNewTool = !this.tools.has(toolId);
				this.tools.set(toolId, { toolId, name: name.slice(0, 1_000), status, detail: detail.slice(0, 50_000) });
				while (this.tools.size > 100) this.tools.delete(this.tools.keys().next().value!);
				this.timeline.recordTool(toolId, name, status, detail);
				if (isNewTool) this.toolCallCount++;
				break;
			}
			case "message.completed": {
				this.applyTerminalMessage(data, "completed", true);
				break;
			}
			case "message.incomplete": {
				this.applyTerminalMessage(data, "incomplete");
				break;
			}
			case "message.rejected": {
				this.applyTerminalMessage(data, "rejected");
				break;
			}
			case "message.failed": {
				this.timeline.complete();
				this.status = "failed";
				this.answerText = boundedAnswer("", typeof data.error === "string" ? data.error : "消息处理失败");
				break;
			}
			case "message.cancelled": {
				this.timeline.complete();
				this.status = "cancelled";
				this.answerText = boundedAnswer("", typeof data.message === "string" ? data.message : "运行已取消");
				break;
			}
			case "approval.updated": {
				const status = String(data.status ?? "pending");
				this.pendingApprovalId = status === "pending" ? String(data.id ?? "approval") : undefined;
				this.timeline.recordNotice(String(data.id ?? "approval"), "工具审批", String(data.status ?? "pending"), String(data.message ?? ""));
				break;
			}
			case "notice.updated": {
				if (String(data.id ?? "") === "turn:status" && typeof data.message === "string") this.progressText = data.message.slice(0, 1_000);
				this.timeline.recordNotice(String(data.id ?? "notice"), String(data.label ?? "状态"), String(data.status ?? "info"), String(data.message ?? ""));
				break;
			}
		}
		return true;
	}

	private applyTerminalMessage(data: CardEventData, status: "completed" | "incomplete" | "rejected", includeContext = false): void {
		const answer = normalizeStreamText(String(data.answer ?? ""));
		if (answer.trim()) this.answerText = boundedAnswer("", answer);
		this.timeline.complete();
		this.status = status;
		const tokens = data.tokens;
		if (tokens && typeof tokens === "object") this.tokens = { ...(tokens as Record<string, number>) };
		const model = data.model;
		if (typeof model === "string" && model.trim()) this.model = model;
		if (includeContext) {
			const context = data.context;
			if (context && typeof context === "object") this.context = { ...(context as Record<string, number>) };
		}
		const duration = Number(data.duration);
		if (Number.isFinite(duration)) this.duration = duration;
	}
}

function boundedAnswer(current: string, addition: string): string {
	if (current.endsWith(ANSWER_TRUNCATED)) return current;
	if (current.length + addition.length <= MAX_ANSWER_CHARS) return current + addition;
	return `${current}${addition}`.slice(0, MAX_ANSWER_CHARS) + ANSWER_TRUNCATED;
}

function toolDetailFromEvent(data: CardEventData): string {
	const lines: string[] = [];
	const detail = data.detail;
	if (typeof detail === "string" && detail.trim()) lines.push(normalizeStreamText(detail).trim());
	return lines.join("\n");
}

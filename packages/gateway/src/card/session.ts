/**
 * CardSession: accumulates streaming events into card state.
 * Stripped of interaction (approval/clarify) and attachment handling -
 * BeeMax's first cut needs answer + tools + footer.
 */

import { CardTimeline } from "./timeline.ts";
import { StreamingTextNormalizer, normalizeStreamText } from "./text.ts";

export interface ToolState {
	toolId: string;
	name: string;
	status: string;
	detail: string;
}

export type CardStatus = "thinking" | "completed" | "failed" | "cancelled";

export interface CardEventData {
	/** answer (message.completed) | text (thinking/answer delta) | error (failed) */
	[key: string]: unknown;
}

export class CardSession {
	status: CardStatus = "thinking";
	/** Protocol/debug-only reasoning. Never rendered in the default user card. */
	thinkingText = "";
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

	get toolCount(): number {
		return this.toolCallCount;
	}

	get visibleMainText(): string {
		return this.answerText;
	}

	apply(event: string, data: CardEventData): boolean {
		if (this.status === "completed" || this.status === "failed" || this.status === "cancelled") return false;

		switch (event) {
			case "thinking.delta": {
				const raw = String(data.text ?? "");
				const delta = this.thinkingNormalizer.feed(raw);
				if (delta) {
					this.thinkingText += delta;
					this.timeline.recordReasoning(delta);
				}
				break;
			}
			case "answer.delta": {
				const delta = this.answerNormalizer.feed(String(data.text ?? ""));
				if (delta) this.answerText += delta;
				break;
			}
			case "tool.updated": {
				const toolId = String(data.tool_id ?? "");
				if (!toolId) return true;
				const name = String(data.name ?? toolId);
				const status = String(data.status ?? "running");
				const detail = toolDetailFromEvent(data);
				const isNewTool = !this.tools.has(toolId);
				this.tools.set(toolId, { toolId, name, status, detail });
				this.timeline.recordTool(toolId, name, status, detail);
				if (isNewTool) this.toolCallCount++;
				break;
			}
			case "message.completed": {
				const completed = normalizeStreamText(String(data.answer ?? ""));
				if (completed.trim()) this.answerText = completed;
				this.timeline.complete();
				this.status = "completed";
				const tokens = data.tokens;
				if (tokens && typeof tokens === "object") this.tokens = { ...(tokens as Record<string, number>) };
				const model = data.model;
				if (typeof model === "string" && model.trim()) this.model = model;
				const ctx = data.context;
				if (ctx && typeof ctx === "object") this.context = { ...(ctx as Record<string, number>) };
				const dur = Number(data.duration);
				if (Number.isFinite(dur)) this.duration = dur;
				break;
			}
			case "message.failed": {
				this.timeline.complete();
				this.status = "failed";
				this.answerText = typeof data.error === "string" ? data.error : "消息处理失败";
				break;
			}
			case "message.cancelled": {
				this.timeline.complete();
				this.status = "cancelled";
				this.answerText = typeof data.message === "string" ? data.message : "运行已取消";
				break;
			}
			case "approval.updated": {
				this.timeline.recordNotice(String(data.id ?? "approval"), "工具审批", String(data.status ?? "pending"), String(data.message ?? ""));
				break;
			}
		}
		return true;
	}
}

function toolDetailFromEvent(data: CardEventData): string {
	const lines: string[] = [];
	const detail = data.detail;
	if (typeof detail === "string" && detail.trim()) lines.push(normalizeStreamText(detail).trim());
	return lines.join("\n");
}

import { parseInteractionCommand, type InteractionCommand, type InteractionDetailsDisplay, type InteractionEvent } from "@beemax/core";

export type ReasoningDisplay = "off" | "summary" | "raw";
export type DetailsDisplay = InteractionDetailsDisplay;

export interface ChatFooterState {
	profile: string;
	model: string;
	session: string;
	phase: string;
	context?: string;
	lastDurationMs?: number;
	queued?: number;
}

/** Persistent, presenter-owned status summary for Compact and Full chat. */
export function renderChatFooter(state: ChatFooterState): string {
	const parts = [state.profile, state.model, `session:${state.session}`, state.phase];
	if (state.context) parts.push(`ctx:${state.context}`);
	if (state.lastDurationMs !== undefined) parts.push(`last:${Math.round(state.lastDurationMs / 1000)}s`);
	if (state.queued) parts.push(`queue:${state.queued}`);
	return `\n── ${parts.join(" · ")} ──\n`;
}

/** OpenClaw-style visibility control: raw thinking is opt-in and stays separate from the answer. */
export class LocalReasoningPresenter {
	private visible = false;
	private answerStarted = false;
	private readonly display: ReasoningDisplay;
	private readonly interactive: boolean;

	constructor(display: ReasoningDisplay, interactive = true) {
		this.display = display;
		this.interactive = interactive;
	}

	thinking(delta: string): string {
		if (!delta || this.display === "off" || this.answerStarted) return "";
		if (this.display === "summary") {
			if (!this.interactive) return "";
			if (this.visible) return "";
			this.visible = true;
			return "\n思考中…";
		}
		if (!this.visible) {
			this.visible = true;
			return `\n思考：\n${delta}`;
		}
		return delta;
	}

	beforeAnswer(): string {
		this.answerStarted = true;
		if (!this.visible) return "";
		if (this.display === "raw") return "\n\n";
		return "\r\x1b[2K";
	}
}

export type ReasoningCommand = { kind: "status" } | { kind: "set"; display: ReasoningDisplay } | { kind: "invalid" };

/** Parse the local equivalent of OpenClaw's /reasoning visibility command. */
export function parseReasoningCommand(input: string): ReasoningCommand | undefined {
	const match = input.trim().match(/^\/(?:reasoning|reason)(?:\s+(.+))?$/i);
	if (!match) return undefined;
	const value = match[1]?.trim().toLowerCase();
	if (!value) return { kind: "status" };
	if (value === "off" || value === "summary" || value === "raw") return { kind: "set", display: value };
	return { kind: "invalid" };
}

/** @deprecated Import parseInteractionCommand from @beemax/core for new presenters. */
export const parseChatCommand: (input: string) => InteractionCommand | undefined = parseInteractionCommand;

/** Compact tool lifecycle lines for a terminal activity stream. */
export class LocalActivityPresenter {
	private details: DetailsDisplay;
	private readonly interactive: boolean;
	private readonly activities = new Map<string, { name: string; state: "running" | "completed" | "failed"; summary?: string }>();

	constructor(details: DetailsDisplay, interactive = true) {
		this.details = details;
		this.interactive = interactive;
	}

	setDetails(details: DetailsDisplay): void { this.details = details; }

	/** Re-render the current turn/session activity as a recoverable detail card. */
	renderDetails(): string {
		if (!this.activities.size) return "No tool or Sub-Agent activity in this session yet.";
		return [...this.activities.values()].map((activity) => {
			const label = activity.name === "task_spawn" || activity.name === "task_status" || activity.name === "task_wait" ? "子代理" : "工具";
			return `${label} ${activity.name} · ${activity.state}${activity.summary ? `\n${activity.summary}` : ""}`;
		}).join("\n\n");
	}

	event(event: InteractionEvent): string {
		if (event.type === "tool.changed") this.activities.set(event.callId, { name: event.name, state: event.state, summary: event.summary });
		if (this.details === "hidden" || !this.interactive) return "";
		if (event.type === "tool.changed") {
			const label = event.name === "task_spawn" || event.name === "task_status" || event.name === "task_wait" ? "子代理" : "工具";
			if (event.state === "running") return this.details === "collapsed" ? "" : `\n${label} ${event.name} 运行中…\n`;
			return `\n${label} ${event.name} ${event.state === "completed" ? "完成" : "失败"}${event.summary ? `：${event.summary}` : ""}\n`;
		}
		if (event.type === "turn.failed") return `\n运行失败：${event.error}\n`;
		if (event.type === "turn.cancelled") return "\n运行已取消。\n";
		if (event.type === "approval.requested") {
			const detail = event.details;
			if (!detail) return `\n等待审批：工具 ${event.toolName}。可输入 /stop 取消。\n`;
			return `\n⚠️ 等待审批 · ${event.toolName}\n目标：${detail.target}\n风险：${detail.risk} · 影响：${detail.impact}\n可逆性：${detail.reversibility}\n输入 1（一次）/ 2（本会话）/ 3（拒绝），或 /stop 取消。\n`;
		}
		if (event.type === "approval.resolved") return `\n审批${event.allowed ? "已允许，继续执行。" : "被拒绝。"}\n`;
		return "";
	}
}

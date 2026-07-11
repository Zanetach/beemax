import type { InteractionEvent } from "@beemax/core";

export type ReasoningDisplay = "off" | "summary" | "raw";
export type DetailsDisplay = "hidden" | "collapsed" | "expanded";

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

export type ChatCommand =
	| { kind: "help" | "status" | "new" | "reset" | "stop" | "usage" | "sessions" }
	| { kind: "compact" }
	| { kind: "history"; limit?: number }
	| { kind: "resume"; sessionId: string }
	| { kind: "models" }
	| { kind: "retry" }
	| { kind: "tools" }
	| { kind: "think"; level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
	| { kind: "details"; mode: DetailsDisplay | "status" };

export function parseChatCommand(input: string): ChatCommand | undefined {
	const value = input.trim().toLowerCase();
	if (value === "/help") return { kind: "help" };
	if (value === "/status") return { kind: "status" };
	if (value === "/new") return { kind: "new" };
	if (value === "/reset") return { kind: "reset" };
	if (value === "/stop") return { kind: "stop" };
	if (value === "/compact") return { kind: "compact" };
	if (value === "/usage") return { kind: "usage" };
	if (value === "/sessions") return { kind: "sessions" };
	if (value === "/models") return { kind: "models" };
	if (value === "/retry") return { kind: "retry" };
	if (value === "/tools") return { kind: "tools" };
	const history = value.match(/^\/history(?:\s+(\d{1,3}))?$/);
	if (history) return { kind: "history", limit: history[1] ? Number(history[1]) : undefined };
	const resume = input.trim().match(/^\/resume\s+([^\s]+)$/i);
	if (resume) return { kind: "resume", sessionId: resume[1] };
	const think = value.match(/^\/think(?:\s+(off|minimal|low|medium|high|xhigh|max))?$/);
	if (think) return { kind: "think", level: think[1] as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined };
	const details = value.match(/^\/details(?:\s+(hidden|collapsed|expanded))?$/);
	if (details) return { kind: "details", mode: details[1] === "hidden" || details[1] === "collapsed" || details[1] === "expanded" ? details[1] : "status" };
	return undefined;
}

/** Compact tool lifecycle lines for a terminal activity stream. */
export class LocalActivityPresenter {
	private readonly details: DetailsDisplay;
	private readonly interactive: boolean;

	constructor(details: DetailsDisplay, interactive = true) {
		this.details = details;
		this.interactive = interactive;
	}

	event(event: InteractionEvent): string {
		if (this.details === "hidden" || !this.interactive) return "";
		if (event.type === "tool.changed") {
			const label = event.name === "task_spawn" || event.name === "task_status" || event.name === "task_wait" ? "子代理" : "工具";
			if (event.state === "running") return this.details === "collapsed" ? "" : `\n${label} ${event.name} 运行中…\n`;
			return `\n${label} ${event.name} ${event.state === "completed" ? "完成" : "失败"}${event.summary ? `：${event.summary}` : ""}\n`;
		}
		if (event.type === "turn.failed") return `\n运行失败：${event.error}\n`;
		if (event.type === "turn.cancelled") return "\n运行已取消。\n";
		if (event.type === "approval.requested") return `\n等待审批：工具 ${event.toolName}。可输入 /stop 取消。\n`;
		if (event.type === "approval.resolved") return `\n审批${event.allowed ? "已允许，继续执行。" : "被拒绝。"}\n`;
		return "";
	}
}

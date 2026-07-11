import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type ReasoningDisplay = "off" | "summary" | "raw";

/**
 * Returns only newly streamed assistant text.
 *
 * `message_update.message.content` is a cumulative snapshot, so writing it on
 * every update repeats the response in a terminal. Pi supplies the append-only
 * `text_delta` event specifically for streaming renderers.
 */
export function localChatTextDelta(event: AgentSessionEvent): string | undefined {
	if (event.type !== "message_update" || event.message.role !== "assistant") return undefined;
	return event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta : undefined;
}

export function localChatThinkingDelta(event: AgentSessionEvent): string | undefined {
	if (event.type !== "message_update" || event.message.role !== "assistant") return undefined;
	return event.assistantMessageEvent.type === "thinking_delta" ? event.assistantMessageEvent.delta : undefined;
}

/** OpenClaw-style visibility control: raw thinking is opt-in and stays separate from the answer. */
export class LocalReasoningPresenter {
	private chunks = 0;
	private chars = 0;
	private visible = false;
	private answerStarted = false;
	private readonly display: ReasoningDisplay;

	constructor(display: ReasoningDisplay) { this.display = display; }

	thinking(delta: string): string {
		if (!delta || this.display === "off" || this.answerStarted) return "";
		this.chunks++;
		this.chars += delta.length;
		if (this.display === "summary") {
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
		return `\n思考完成（${this.chunks} 段，${this.chars} 字符；原始推理已隐藏）\n\n`;
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

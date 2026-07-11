import type { InteractionEvent } from "@beemax/core";
import type { ChatFooterState, DetailsDisplay } from "./local-chat-renderer.ts";

export interface FullWorkbenchOptions {
	profile: string;
	model: string;
	session: string;
	details: DetailsDisplay;
}

/**
 * A terminal-native workbench frame. It deliberately owns only presentation:
 * Core remains the source of turn, approval and tool state, and readline stays
 * the reliable input fallback while the richer Pi composer is introduced.
 */
export class FullWorkbench {
	private readonly options: FullWorkbenchOptions;
	private transcript: string[] = [];
	private activities: string[] = [];
	private approval: string[] = [];
	private footer: ChatFooterState;

	constructor(options: FullWorkbenchOptions) {
		this.options = options;
		this.footer = { profile: options.profile, model: options.model, session: options.session, phase: "idle" };
	}

	user(text: string): void { this.pushTranscript(`You  ${text}`); }
	answer(text: string): void {
		const last = this.transcript.at(-1);
		if (last?.startsWith("BeeMax  ")) this.transcript[this.transcript.length - 1] = `${last}${text}`;
		else this.pushTranscript(`BeeMax  ${text}`);
	}

	event(event: InteractionEvent, activityDetails: string): void {
		this.footer = { ...this.footer, phase: event.type === "turn.started" ? "running" : event.type === "approval.requested" ? "awaiting approval" : event.type === "turn.queued" ? "queued" : event.type === "turn.finished" ? "completed" : event.type === "turn.cancelled" ? "cancelled" : event.type === "turn.failed" ? "failed" : this.footer.phase };
		if (event.type === "answer.delta") this.answer(event.text);
		if (event.type === "turn.failed") this.pushTranscript(`Error  ${event.error}`);
		if (event.type === "turn.cancelled") this.pushTranscript("System  Turn cancelled.");
		if (event.type === "approval.requested") {
			this.approval = event.details
				? [`Approval required · ${event.toolName}`, `Target: ${event.details.target}`, `Risk: ${event.details.risk} · ${event.details.impact}`, `Reversible: ${event.details.reversibility}`, "1 allow once · 2 allow session · 3 deny · /stop cancel"]
				: [`Approval required · ${event.toolName}`, "1 allow once · 2 allow session · 3 deny · /stop cancel"];
		}
		if (event.type === "approval.resolved") this.approval = [`Approval ${event.allowed ? "allowed" : "denied"} · ${event.toolName}`];
		if (event.type === "tool.changed" || event.type === "turn.queued") this.activities = activityDetails.split("\n").filter(Boolean);
	}

	setFooter(footer: Partial<ChatFooterState>): void { this.footer = { ...this.footer, ...footer }; }

	render(width = process.stdout.columns || 100, height = process.stdout.rows || 32): string {
		const inner = Math.max(24, width - 4);
		const rows = [
			border("BeeMax Workbench", inner),
			line(`${this.footer.profile} · ${this.footer.model} · session:${this.footer.session} · ${this.footer.phase}${this.footer.context ? ` · ctx:${this.footer.context}` : ""}${this.footer.queued ? ` · queue:${this.footer.queued}` : ""}`, inner),
			divider("Transcript", inner),
			...this.transcript.flatMap((entry) => wrap(entry, inner)),
			divider("Activity", inner),
			...(this.activities.length ? this.activities.flatMap((entry) => wrap(entry, inner)) : [line("No tool or Sub-Agent activity yet.", inner)]),
			...(this.approval.length ? [divider("Approval", inner), ...this.approval.flatMap((entry) => wrap(entry, inner))] : []),
			divider("Composer", inner),
			line("Enter send · /help controls · Ctrl+C or /stop cancel", inner),
			border("", inner),
		];
		const available = Math.max(10, height - 1);
		return rows.length > available ? [rows[0], line("… transcript condensed …", inner), ...rows.slice(-(available - 2)), rows.at(-1)!].join("\n") : rows.join("\n");
	}

	private pushTranscript(text: string): void {
		this.transcript.push(text.replaceAll("\r", ""));
		if (this.transcript.length > 80) this.transcript.splice(0, this.transcript.length - 80);
	}
}

function border(title: string, width: number): string { return `┌─ ${title}${"─".repeat(Math.max(0, width - title.length - 3))}┐`; }
function divider(title: string, width: number): string { return `├─ ${title}${"─".repeat(Math.max(0, width - title.length - 3))}┤`; }
function line(value: string, width: number): string { return `│ ${truncate(value, width - 2).padEnd(width - 2)} │`; }
function wrap(value: string, width: number): string[] {
	const contentWidth = width - 2;
	const result: string[] = [];
	for (const rawLine of value.split("\n")) {
		if (!rawLine) result.push(line("", width));
		else for (let start = 0; start < rawLine.length; start += contentWidth) result.push(line(rawLine.slice(start, start + contentWidth), width));
	}
	return result;
}
function truncate(value: string, width: number): string { return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value; }

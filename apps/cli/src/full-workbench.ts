import { interactionPhaseForOutcome, type InteractionEvent } from "@beemax/core";
import { Editor, ProcessTerminal, TUI, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { SubagentTaskSnapshot } from "@beemax/core";
import type { ChatFooterState, DetailsDisplay } from "./local-chat-renderer.ts";

export interface FullWorkbenchOptions {
	profile: string;
	model: string;
	session: string;
	details: DetailsDisplay;
}

/**
 * A terminal-native workbench frame. It deliberately owns only presentation:
 * Core remains the source of turn and tool state, and readline stays
 * the reliable input fallback while the richer Pi composer is introduced.
 */
export class FullWorkbench {
	private readonly options: FullWorkbenchOptions;
	private transcript: string[] = [];
	private activities: string[] = [];
	private picker: { title: string; choices: string[] } | undefined;
	private subagents: string[] = [];
	private footer: ChatFooterState;

	constructor(options: FullWorkbenchOptions) {
		this.options = options;
		this.footer = { profile: options.profile, model: options.model, session: options.session, phase: "idle" };
	}

	user(text: string): void { this.pushTranscript(`You  ${text}`); }
	notice(text: string): void { this.pushTranscript(`System  ${text}`); }
	answer(text: string): void {
		const last = this.transcript.at(-1);
		if (last?.startsWith("BeeMax  ")) this.transcript[this.transcript.length - 1] = `${last}${text}`;
		else this.pushTranscript(`BeeMax  ${text}`);
	}

	event(event: InteractionEvent, activityDetails: string): void {
		const finishedPhase = event.type === "turn.finished" ? interactionPhaseForOutcome(event.result.outcome) : undefined;
		this.footer = { ...this.footer, phase: event.type === "turn.started" ? "running" : event.type === "turn.queued" ? "queued" : finishedPhase ?? (event.type === "turn.cancelled" ? "cancelled" : event.type === "turn.failed" ? "failed" : this.footer.phase) };
		if (event.type === "answer.delta") this.answer(event.text);
		if (event.type === "turn.failed") this.pushTranscript(`Error  ${event.error}`);
		if (event.type === "turn.cancelled") this.pushTranscript("System  Turn cancelled.");
		if (event.type === "model.fallback") this.pushTranscript(`System  Model fallback ${event.from} → ${event.to} · attempt ${event.attempt}`);
		if (event.type === "planning.selected") this.pushTranscript(`System  Plan ${event.mode} · concurrency ${event.concurrency} · Sub-Agents ${event.maxSubagents}${event.requiredTools.length ? ` · ${event.requiredTools.join(" → ")}` : ""}`);
		if (event.type === "planning.completed" && (event.corrected || !event.compliant)) this.pushTranscript(`System  Plan ${event.mode} · ${event.compliant ? "corrected and completed" : "not completed"}`);
		if (event.type === "tool.changed" || event.type === "turn.queued") this.activities = activityDetails.split("\n").filter(Boolean);
	}

	setFooter(footer: Partial<ChatFooterState>): void { this.footer = { ...this.footer, ...footer }; }
	setPicker(title: string, choices: string[]): void { this.picker = { title, choices: choices.slice(0, 12) }; }
	clearPicker(): void { this.picker = undefined; }
	setSubagents(tasks: readonly SubagentTaskSnapshot[]): void {
		this.subagents = tasks.map((task) => {
			const elapsed = Math.max(0, (task.finishedAt ?? Date.now()) - (task.startedAt ?? task.createdAt));
			return `${task.name} · ${task.status} · ${Math.round(elapsed / 1000)}s · ${task.goal}`;
		});
	}

	render(width = process.stdout.columns || 100, height = process.stdout.rows || 32): string {
		return this.renderLines(width, height).join("\n");
	}

	renderLines(width = process.stdout.columns || 100, height = process.stdout.rows || 32): string[] {
		const inner = Math.max(24, width - 4);
		const rows = [
			border("BeeMax Workbench", inner),
			line(`${this.footer.profile} · ${this.footer.model} · session:${this.footer.session} · ${this.footer.phase}${this.footer.context ? ` · ctx:${this.footer.context}` : ""}${this.footer.queued ? ` · queue:${this.footer.queued}` : ""}${this.footer.taskCapacity === undefined ? "" : ` · tasks:${this.footer.tasksRunning ?? 0}+${this.footer.tasksQueued ?? 0}/${this.footer.taskCapacity}`}`, inner),
			divider("Transcript", inner),
			...this.transcript.flatMap((entry) => wrap(entry, inner)),
			divider("Activity", inner),
			...(this.activities.length ? this.activities.flatMap((entry) => wrap(entry, inner)) : [line("No tool or Sub-Agent activity yet.", inner)]),
			...(this.subagents.length ? [divider("Sub-Agents", inner), ...this.subagents.flatMap((entry) => wrap(entry, inner))] : []),
			...(this.picker ? [divider(this.picker.title, inner), ...(this.picker.choices.length ? this.picker.choices.flatMap((entry) => wrap(entry, inner)) : [line("No matching choices.", inner)])] : []),
			divider("Composer", inner),
			line("Enter send · /help controls · Ctrl+C or /stop cancel", inner),
			border("", inner),
		];
		const available = Math.max(10, height - 1);
		return rows.length > available ? [rows[0], line("… transcript condensed …", inner), ...rows.slice(-(available - 2)), rows.at(-1)!] : rows;
	}

	private pushTranscript(text: string): void {
		this.transcript.push(text.replaceAll("\r", ""));
		if (this.transcript.length > 80) this.transcript.splice(0, this.transcript.length - 80);
	}
}

export interface FullWorkbenchInput {
	requestRender(): void;
	stop(): void;
}

/** Pi-backed multiline Composer. It delegates submitted text to the shared chat action path. */
export function startFullWorkbenchInput(
	workbench: FullWorkbench,
	onSubmit: (text: string) => void,
	onCancel: () => void,
	onClose: () => void,
): FullWorkbenchInput {
	const tui = new TUI(new ProcessTerminal(), true);
	const editor = new Editor(tui, {
		borderColor: (text) => text,
		selectList: {
			selectedPrefix: (text) => text,
			selectedText: (text) => text,
			description: (text) => text,
			scrollInfo: (text) => text,
			noMatch: (text) => text,
		},
	}, { paddingX: 1 });
	const root: Component = {
		invalidate: () => editor.invalidate(),
		render: (width) => {
			const frame = workbench.renderLines(width, tui.terminal.rows);
			const composer = frame.findIndex((row) => row.includes("Composer"));
			if (composer < 0) return [...frame, ...editor.render(width)];
			return [...frame.slice(0, composer + 1), ...editor.render(width), frame.at(-1)!];
		},
	};
	editor.onSubmit = (text) => {
		if (!text.trim()) return;
		editor.addToHistory(text);
		onSubmit(text);
	};
	tui.addChild(root);
	tui.setFocus(editor);
	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) { onCancel(); return { consume: true }; }
		if (matchesKey(data, "ctrl+d")) { onClose(); return { consume: true }; }
		return undefined;
	});
	tui.start();
	return { requestRender: () => tui.requestRender(), stop: () => tui.stop() };
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

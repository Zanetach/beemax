import type { InteractionEvent } from "@beemax/core";
import { Editor, ProcessTerminal, SelectList, TUI, matchesKey, type Component, type OverlayHandle } from "@earendil-works/pi-tui";
import type { ToolApprovalChoice, ToolApprovalDetails } from "@beemax/core";
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
 * Core remains the source of turn, approval and tool state, and readline stays
 * the reliable input fallback while the richer Pi composer is introduced.
 */
export class FullWorkbench {
	private readonly options: FullWorkbenchOptions;
	private transcript: string[] = [];
	private activities: string[] = [];
	private approval: string[] = [];
	private picker: { title: string; choices: string[] } | undefined;
	private pendingApproval: { turnId: string; toolName: string; details?: ToolApprovalDetails } | undefined;
	private subagents: string[] = [];
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
			this.pendingApproval = { turnId: event.turnId, toolName: event.toolName, details: event.details };
			this.approval = event.details
				? [`Approval required · ${event.toolName}`, `Target: ${event.details.target}`, `Risk: ${event.details.risk} · ${event.details.impact}`, `Reversible: ${event.details.reversibility}`, "1 allow once · 2 allow session · 3 deny · /stop cancel"]
				: [`Approval required · ${event.toolName}`, "1 allow once · 2 allow session · 3 deny · /stop cancel"];
		}
		if (event.type === "approval.resolved") { this.pendingApproval = undefined; this.approval = [`Approval ${event.allowed ? "allowed" : "denied"} · ${event.toolName}`]; }
		if (event.type === "tool.changed" || event.type === "turn.queued") this.activities = activityDetails.split("\n").filter(Boolean);
	}

	setFooter(footer: Partial<ChatFooterState>): void { this.footer = { ...this.footer, ...footer }; }
	setPicker(title: string, choices: string[]): void { this.picker = { title, choices: choices.slice(0, 12) }; }
	clearPicker(): void { this.picker = undefined; }
	pendingApprovalRequest(): Readonly<typeof this.pendingApproval> { return this.pendingApproval; }
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
			line(`${this.footer.profile} · ${this.footer.model} · session:${this.footer.session} · ${this.footer.phase}${this.footer.context ? ` · ctx:${this.footer.context}` : ""}${this.footer.queued ? ` · queue:${this.footer.queued}` : ""}`, inner),
			divider("Transcript", inner),
			...this.transcript.flatMap((entry) => wrap(entry, inner)),
			divider("Activity", inner),
			...(this.activities.length ? this.activities.flatMap((entry) => wrap(entry, inner)) : [line("No tool or Sub-Agent activity yet.", inner)]),
			...(this.subagents.length ? [divider("Sub-Agents", inner), ...this.subagents.flatMap((entry) => wrap(entry, inner))] : []),
			...(this.approval.length ? [divider("Approval", inner), ...this.approval.flatMap((entry) => wrap(entry, inner))] : []),
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
	onApprovalDecision: (choice: ToolApprovalChoice) => void,
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
	let approvalOverlay: OverlayHandle | undefined;
	let overlayTurnId: string | undefined;
	const syncApprovalOverlay = () => {
		const pending = workbench.pendingApprovalRequest();
		if (!pending) {
			approvalOverlay?.hide();
			approvalOverlay = undefined;
			overlayTurnId = undefined;
			return;
		}
		if (approvalOverlay && overlayTurnId === pending.turnId) return;
		approvalOverlay?.hide();
		const choices: Array<{ value: ToolApprovalChoice; label: string; description: string }> = [
			{ value: "once", label: "Allow once", description: `Run ${pending.toolName} this time` },
			{ value: "session", label: "Allow for session", description: `Allow ${pending.toolName} until this session ends` },
			{ value: "deny", label: "Deny", description: "Do not run this tool call" },
		];
		const list = new SelectList(choices, 3, {
			selectedPrefix: (text) => text,
			selectedText: (text) => text,
			description: (text) => text,
			scrollInfo: (text) => text,
			noMatch: (text) => text,
		});
		list.onSelect = (item) => { approvalOverlay?.hide(); approvalOverlay = undefined; overlayTurnId = undefined; onApprovalDecision(item.value as ToolApprovalChoice); };
		list.onCancel = () => { approvalOverlay?.hide(); approvalOverlay = undefined; overlayTurnId = undefined; onApprovalDecision("deny"); };
		overlayTurnId = pending.turnId;
		approvalOverlay = tui.showOverlay(list, { anchor: "center", width: "70%", maxHeight: "40%" });
	};
	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) { onCancel(); return { consume: true }; }
		if (matchesKey(data, "ctrl+d")) { onClose(); return { consume: true }; }
		return undefined;
	});
	tui.start();
	return { requestRender: () => { syncApprovalOverlay(); tui.requestRender(); }, stop: () => tui.stop() };
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

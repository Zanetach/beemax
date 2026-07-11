/**
 * Surface-neutral chat controls. Presenters may render these as slash commands,
 * buttons, or keyboard shortcuts, but must not invent a second command grammar.
 */
export type InteractionDetailsDisplay = "hidden" | "collapsed" | "expanded";

export type InteractionCommand =
	| { kind: "help" | "status" | "new" | "reset" | "stop" | "usage" | "sessions" }
	| { kind: "compact" }
	| { kind: "history"; limit?: number }
	| { kind: "resume"; sessionId: string }
	| { kind: "models" }
	| { kind: "retry" }
	| { kind: "tools" }
	| { kind: "think"; level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
	| { kind: "details"; mode: InteractionDetailsDisplay | "status" };

export interface InteractionCommandDefinition {
	name: string;
	usage: string;
	description: string;
}

/** Stable command catalog shared by terminal, gateway cards, and future Web controls. */
export const INTERACTION_COMMANDS: readonly InteractionCommandDefinition[] = [
	{ name: "help", usage: "/help", description: "Show available controls" },
	{ name: "status", usage: "/status", description: "Show the current session status" },
	{ name: "new", usage: "/new", description: "Start a new session" },
	{ name: "reset", usage: "/reset", description: "Discard the live session and start fresh" },
	{ name: "sessions", usage: "/sessions", description: "List resumable sessions" },
	{ name: "resume", usage: "/resume <session-id|number>", description: "Resume a session" },
	{ name: "history", usage: "/history [n]", description: "Show recent session history" },
	{ name: "usage", usage: "/usage", description: "Show context and token usage" },
	{ name: "stop", usage: "/stop", description: "Cancel the active turn and pending approval" },
	{ name: "compact", usage: "/compact", description: "Compact the current context" },
	{ name: "models", usage: "/models", description: "List configured models" },
	{ name: "think", usage: "/think [level]", description: "Inspect or set reasoning level" },
	{ name: "tools", usage: "/tools", description: "Show available tools" },
	{ name: "retry", usage: "/retry", description: "Retry the last recoverable failed turn" },
	{ name: "details", usage: "/details [hidden|collapsed|expanded]", description: "Inspect or set activity detail visibility" },
] as const;

export function interactionCommandHelp(): string {
	return `Commands: ${INTERACTION_COMMANDS.map((command) => command.usage).join(" ")} /model <provider/model|number> /reasoning off|summary|raw /quit`;
}

/** Parse only product controls; all other text remains an agent message. */
export function parseInteractionCommand(input: string): InteractionCommand | undefined {
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

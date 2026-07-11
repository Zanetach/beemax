export type ChatPresentationMode = "full" | "compact" | "plain";

export interface ChatModeOptions {
	full?: boolean;
	compact?: boolean;
	plain?: boolean;
	noAltScreen?: boolean;
	isInputTty: boolean;
	isOutputTty: boolean;
	term?: string;
}

/** One chat command, with a deterministic presentation downgrade path. */
export function resolveChatPresentationMode(options: ChatModeOptions): ChatPresentationMode {
	if (options.plain || !options.isInputTty || !options.isOutputTty) return "plain";
	if (options.noAltScreen) return "compact";
	if (options.full) return "full";
	if (options.compact || options.term === "dumb") return "compact";
	return "full";
}

/** Alternate-screen lifecycle for Full presentation. It is never used for pipes. */
export function fullScreenEnter(title: string): string { return `\x1b[?1049h\x1b[H\x1b[2J${title}\n\n`; }
export function fullScreenExit(): string { return "\x1b[?1049l"; }

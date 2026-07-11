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
	if (options.compact || options.noAltScreen || options.term === "dumb") return "compact";
	return "full";
}

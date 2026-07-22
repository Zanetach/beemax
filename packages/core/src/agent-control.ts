import type { ThruveraRuntimeSource } from "./runtime.ts";

/** A product control request handled before an ordinary Agent turn. */
export interface AgentControlInput<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> {
	source: Source;
	text: string;
}

export interface AgentControlResult<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> {
	handled: boolean;
	message: string;
	/** Optional conversation identity to use for subsequent channel messages. */
	nextSource?: Source;
}

export type AgentControlHandler<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> = (
	input: AgentControlInput<Source>,
) => Promise<AgentControlResult<Source> | undefined>;

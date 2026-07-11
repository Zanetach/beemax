import type { BeeMaxRuntimeSource } from "./runtime.ts";

/** A product control request handled before an ordinary Agent turn. */
export interface AgentControlInput<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	source: Source;
	text: string;
}

export interface AgentControlResult<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	handled: boolean;
	message: string;
	/** Optional conversation identity to use for subsequent channel messages. */
	nextSource?: Source;
}

export type AgentControlHandler<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> = (
	input: AgentControlInput<Source>,
) => Promise<AgentControlResult<Source> | undefined>;

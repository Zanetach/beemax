import type { BeeMaxRuntimeSource } from "./runtime.ts";

/** A product control request handled before an ordinary Agent turn. */
export interface AgentControlInput<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	source: Source;
	text: string;
}

export interface AgentControlResult {
	handled: boolean;
	message: string;
}

export type AgentControlHandler<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> = (
	input: AgentControlInput<Source>,
) => Promise<AgentControlResult | undefined>;

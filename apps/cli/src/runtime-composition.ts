import {
	BeeMaxAgentRuntime,
	type BeeMaxAgentRuntimeOptions,
	type BeeMaxRuntimeSource,
	type AgentControlHandler,
	type SessionCoordinatorOptions,
} from "@beemax/core";

/** Profile-scoped session policy belongs at the application composition root. */
export function createProfileRuntime<Source extends BeeMaxRuntimeSource>(
	policy: SessionCoordinatorOptions,
	options: Omit<BeeMaxAgentRuntimeOptions<Source>, keyof SessionCoordinatorOptions> & { controlHandler?: AgentControlHandler<Source> },
): BeeMaxAgentRuntime<Source> {
	return new BeeMaxAgentRuntime({ ...options, ...policy });
}

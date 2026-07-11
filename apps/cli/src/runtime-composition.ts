import {
	BeeMaxAgentRuntime,
	FileInteractionEventJournal,
	InteractionEventAdapter,
	SessionCatalog,
	type BeeMaxAgentRuntimeOptions,
	type BeeMaxRuntimeSource,
	type AgentControlHandler,
	type ToolApprovalBroker,
	type SessionCoordinatorOptions,
} from "@beemax/core";
import { join } from "node:path";

export interface ProfileAgentRuntimeOptions<Source extends BeeMaxRuntimeSource> {
	profileId: string;
	agentDir: string;
	policy: SessionCoordinatorOptions;
	runtime: Omit<BeeMaxAgentRuntimeOptions<Source>, keyof SessionCoordinatorOptions | "controlHandler" | "sessionCatalog">;
	approvalBroker?: ToolApprovalBroker;
	cancelSubagents?: (source: Source) => number | Promise<number>;
	cancelTaskPlans?: (source: Source) => number | Promise<number>;
	controlHandler?: (runtime: BeeMaxAgentRuntime<Source>, interaction: InteractionEventAdapter<Source>) => AgentControlHandler<Source>;
}

export interface ProfileAgentRuntime<Source extends BeeMaxRuntimeSource> {
	runtime: BeeMaxAgentRuntime<Source>;
	interaction: InteractionEventAdapter<Source>;
	dispose(): void;
}

/**
 * One composition root for every Profile surface. Channels may add tools and
 * presenters, but session discovery, interaction events, approvals and
 * cancellation always receive the same durable runtime wiring.
 */
export function createProfileAgentRuntime<Source extends BeeMaxRuntimeSource>(
	options: ProfileAgentRuntimeOptions<Source>,
): ProfileAgentRuntime<Source> {
	let runtime!: BeeMaxAgentRuntime<Source>;
	let interaction!: InteractionEventAdapter<Source>;
	runtime = new BeeMaxAgentRuntime({
		...options.runtime,
		...options.policy,
		sessionCatalog: SessionCatalog.forAgentDir<Source>(options.agentDir),
		controlHandler: options.controlHandler
			? (input) => options.controlHandler!(runtime, interaction)(input)
			: undefined,
	});
	interaction = new InteractionEventAdapter(runtime, {
		profileId: options.profileId,
		approvalBroker: options.approvalBroker,
		cancelSubagents: options.cancelSubagents,
		cancelTaskPlans: options.cancelTaskPlans,
		eventJournal: new FileInteractionEventJournal(join(options.agentDir, "interaction-events.jsonl")),
	});
	return {
		runtime,
		interaction,
		dispose: () => { interaction.dispose(); runtime.dispose(); },
	};
}

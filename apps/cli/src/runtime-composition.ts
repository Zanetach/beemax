import {
	BeeMaxAgentRuntime,
	FileInteractionEventJournal,
	FileInteractionInputQueueStore,
	InteractionEventAdapter,
	SessionCatalog,
	type BeeMaxAgentRuntimeOptions,
	type BeeMaxRuntimeSource,
	type AgentControlHandler,
	type ToolApprovalBroker,
	type SessionCoordinatorOptions,
} from "@beemax/core";
import { join } from "node:path";
import { recordOperationalMetric } from "./operational-metrics.ts";
import { createProfileWorkRuntime, type ProfileWorkRuntimeOptions } from "./profile-work-runtime.ts";
import { assertAgentFactorySecurity } from "./agent-factory.ts";

export type ProfileWorkRuntime = ReturnType<typeof createProfileWorkRuntime>;

export interface ProfileAgentRuntimeOptions<Source extends BeeMaxRuntimeSource> {
	profileId: string;
	agentDir: string;
	policy: SessionCoordinatorOptions;
	runtime: Omit<BeeMaxAgentRuntimeOptions<Source>, keyof SessionCoordinatorOptions | "controlHandler" | "sessionCatalog">;
	approvalBroker?: ToolApprovalBroker;
	cancelSubagents?: (source: Source) => number | Promise<number>;
	cancelTaskPlans?: (source: Source) => number | Promise<number>;
	controlHandler?: (runtime: BeeMaxAgentRuntime<Source>, interaction: InteractionEventAdapter<Source>) => AgentControlHandler<Source>;
	resources?: readonly ProfileRuntimeResource[];
}

export interface ProfileRuntimeResource {
	name: string;
	start?(): void | Promise<void>;
	dispose(): void | Promise<void>;
}

export interface ProfileAgentRuntime<Source extends BeeMaxRuntimeSource> {
	runtime: BeeMaxAgentRuntime<Source>;
	interaction: InteractionEventAdapter<Source>;
	dispose(): Promise<void>;
}

export interface ProfileRuntimeOptions<Source extends BeeMaxRuntimeSource> {
	work: ProfileWorkRuntimeOptions;
	resources?: readonly ProfileRuntimeResource[];
	compose(work: ProfileWorkRuntime): Omit<ProfileAgentRuntimeOptions<Source>, "resources">;
}

export interface ProfileRuntime<Source extends BeeMaxRuntimeSource> extends ProfileAgentRuntime<Source> {
	work: ProfileWorkRuntime;
}

/** The sole external composition seam for a channel-backed Profile Runtime. */
export async function createProfileRuntime<Source extends BeeMaxRuntimeSource>(options: ProfileRuntimeOptions<Source>): Promise<ProfileRuntime<Source>> {
	let work: ProfileWorkRuntime;
	try {
		work = createProfileWorkRuntime(options.work);
	} catch (error) {
		for (const resource of [...(options.resources ?? [])].reverse()) {
			try { await resource.dispose(); } catch { /* preserve work composition failure */ }
		}
		throw error;
	}
	const resources = [...(options.resources ?? []), ...work.resources];
	let handedToAgentRuntime = false;
	try {
		const composed = options.compose(work);
		assertAgentFactorySecurity(composed.runtime.createAgent, work.toolEffects);
		handedToAgentRuntime = true;
		const profile = await createProfileAgentRuntime({
			...composed,
				runtime: {
				...composed.runtime,
				planningPolicy: work.planningPolicy,
				planningBudgets: work.planningBudgets,
				taskLedger: options.work.ledger,
				executionTrace: work.executionTrace,
				verifyObjectiveCandidate: work.verifyTask,
			},
			resources,
		});
		return { ...profile, work };
	} catch (error) {
		if (!handedToAgentRuntime) {
			for (const resource of [...resources].reverse()) {
				try { await resource.dispose(); } catch { /* preserve composition failure */ }
			}
		}
		throw error;
	}
}

/**
 * One composition root for every Profile surface. Channels may add tools and
 * presenters, but session discovery, interaction events, approvals and
 * cancellation always receive the same durable runtime wiring.
 */
export async function createProfileAgentRuntime<Source extends BeeMaxRuntimeSource>(
	options: ProfileAgentRuntimeOptions<Source>,
): Promise<ProfileAgentRuntime<Source>> {
	const started: ProfileRuntimeResource[] = [];
	try {
		for (const resource of options.resources ?? []) {
			await resource.start?.();
			started.push(resource);
		}
	} catch (error) {
		for (const resource of [...started].reverse()) {
			try { await resource.dispose(); } catch { /* preserve startup failure */ }
		}
		throw error;
	}
	let runtime!: BeeMaxAgentRuntime<Source>;
	let interaction!: InteractionEventAdapter<Source>;
	try {
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
			inputQueueStore: new FileInteractionInputQueueStore(join(options.agentDir, "interaction-input-queue.json")),
			telemetry: (event) => { try { recordOperationalMetric(options.agentDir, event); } catch { /* observability must not interrupt Agent execution */ } },
		});
	} catch (error) {
		try { runtime?.dispose(); } catch { /* preserve composition failure */ }
		for (const resource of [...started].reverse()) {
			try { await resource.dispose(); } catch { /* preserve composition failure */ }
		}
		throw error;
	}
	let disposal: Promise<void> | undefined;
	return {
		runtime,
		interaction,
		dispose: () => disposal ??= (async () => {
			const failures: unknown[] = [];
			try { interaction.dispose(); } catch (error) { failures.push(error); }
			try { runtime.dispose(); } catch (error) { failures.push(error); }
			for (const resource of [...started].reverse()) {
				try { await resource.dispose(); } catch (error) { failures.push(new Error(`Profile resource ${resource.name} failed to dispose`, { cause: error })); }
			}
			if (failures.length) throw new AggregateError(failures, "Profile Runtime disposal failed");
		})(),
	};
}

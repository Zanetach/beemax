import type { DeliveryTarget } from "./delivery-port.ts";
import type { AgentScope } from "./agent-scope.ts";
import { initiativeScopeMatchesExecutionScope, type InitiativeObservation, type InitiativeObserveResult, type InitiativeScope, type InitiativeTrigger, type InitiativeTriggerKind } from "./initiative-runtime.ts";

export type DurableInitiativeTriggerStatus = "queued" | "processing" | "completed" | "awaiting_route" | "notification_queued";
export interface DurableInitiativeTriggerInput {
	profileId: string;
	kind: Extract<InitiativeTriggerKind, "task_transition" | "enterprise_event">;
	triggerId: string;
	occurredAt: number;
	scope: InitiativeScope;
	prompt: string;
	evidenceRef: string;
	notificationRequired: boolean;
	deliveryTarget?: DeliveryTarget;
	executionScope?: AgentScope;
}
export interface DurableInitiativeTrigger extends DurableInitiativeTriggerInput {
	id: string;
	status: DurableInitiativeTriggerStatus;
	attempts: number;
	nextAttemptAt: number;
	claimToken?: string;
	claimExpiresAt?: number;
	observationId?: string;
	decision?: "observed" | "ignored";
	createdAt: number;
}
export interface InitiativeTriggerInbox {
	enqueueInitiativeTrigger(input: DurableInitiativeTriggerInput): { trigger: DurableInitiativeTrigger; created: boolean };
	claimInitiativeTriggers(profileId: string, holderId: string, now: number, limit: number, leaseMs: number): DurableInitiativeTrigger[];
	completeInitiativeTrigger(id: string, claimToken: string, outcome: { decision: "observed" | "ignored"; observationId?: string; notificationRequired: boolean }): boolean;
	failInitiativeTrigger(id: string, claimToken: string, now: number, error: string): boolean;
}
export interface InitiativeTriggerAdapterInput {
	id: string;
	occurredAt: number;
	scope: InitiativeScope;
	summary: string;
	evidenceRef: string;
	notificationRequired: boolean;
	deliveryTarget?: DeliveryTarget;
	executionScope?: AgentScope;
}

abstract class InitiativeTriggerAdapter {
	private readonly inbox: Pick<InitiativeTriggerInbox, "enqueueInitiativeTrigger">;
	private readonly profileId: string;
	protected abstract readonly kind: DurableInitiativeTriggerInput["kind"];
	constructor(inbox: Pick<InitiativeTriggerInbox, "enqueueInitiativeTrigger">, profileId: string) { this.inbox = inbox; this.profileId = profileId; }
	receive(input: InitiativeTriggerAdapterInput): { trigger: DurableInitiativeTrigger; created: boolean } {
		if (input.scope.profileId !== this.profileId) throw new Error("Initiative Trigger scope belongs to a different Profile");
		if (input.executionScope && !initiativeScopeMatchesExecutionScope(input.scope, input.executionScope)) throw new Error("Initiative Trigger execution scope does not match its observation scope");
		return this.inbox.enqueueInitiativeTrigger({
			profileId: this.profileId, kind: this.kind, triggerId: input.id, occurredAt: input.occurredAt,
			scope: input.scope, prompt: input.summary, evidenceRef: input.evidenceRef,
			notificationRequired: input.notificationRequired, ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
			...(input.executionScope ? { executionScope: structuredClone(input.executionScope) } : {}),
		});
	}
}

export class TaskTransitionInitiativeAdapter extends InitiativeTriggerAdapter { protected readonly kind = "task_transition" as const; }
export class EnterpriseEventInitiativeAdapter extends InitiativeTriggerAdapter { protected readonly kind = "enterprise_event" as const; }

export interface InitiativeTriggerServiceOptions {
	profileId: string;
	inbox: InitiativeTriggerInbox;
	initiative: { observe(trigger: InitiativeTrigger): Promise<InitiativeObserveResult | { kind: "observed"; observation: { id: string } }> };
	holderId: string;
	batchSize?: number;
	leaseMs?: number;
	admit?: (observation: InitiativeObservation | { id: string }, trigger: DurableInitiativeTrigger) => Promise<void>;
}

/** Claims durable Trigger responsibility before making one Initiative decision. */
export class InitiativeTriggerService {
	private readonly options: InitiativeTriggerServiceOptions;
	private active?: Promise<{ claimed: number; completed: number; failed: number }>;
	constructor(options: InitiativeTriggerServiceOptions) { this.options = options; }
	runOnce(now = Date.now()): Promise<{ claimed: number; completed: number; failed: number }> {
		if (this.active) return this.active;
		const run = this.executeOnce(now);
		this.active = run;
		const clear = () => { if (this.active === run) this.active = undefined; };
		void run.then(clear, clear);
		return run;
	}
	waitForIdle(): Promise<{ claimed: number; completed: number; failed: number }> {
		return this.active ?? Promise.resolve({ claimed: 0, completed: 0, failed: 0 });
	}
	private async executeOnce(now: number): Promise<{ claimed: number; completed: number; failed: number }> {
		const claimed = this.options.inbox.claimInitiativeTriggers(this.options.profileId, this.options.holderId, now, this.options.batchSize ?? 10, this.options.leaseMs ?? 60_000);
		let completed = 0, failed = 0;
		for (const item of claimed) {
			try {
				const result = await this.options.initiative.observe({
					kind: item.kind, id: item.triggerId, occurredAt: item.occurredAt, scope: item.scope, prompt: item.prompt,
					evidence: [{ id: item.evidenceRef, statement: item.prompt, source: { kind: item.kind === "task_transition" ? "task_ledger" : "enterprise_system", reference: item.evidenceRef }, trust: "observed", confidence: 1 }],
				});
				if (result.kind === "observed" && item.executionScope && this.options.admit) await this.options.admit(result.observation, item);
				if (!item.claimToken || !this.options.inbox.completeInitiativeTrigger(item.id, item.claimToken, {
					decision: result.kind === "observed" ? "observed" : "ignored",
					...(result.kind === "observed" ? { observationId: result.observation.id } : {}),
					notificationRequired: item.notificationRequired,
				})) throw new Error(`Initiative Trigger ${item.id} lost its claim`);
				completed++;
			} catch (error) {
				if (item.claimToken) this.options.inbox.failInitiativeTrigger(item.id, item.claimToken, now, error instanceof Error ? error.message : String(error));
				failed++;
			}
		}
		return { claimed: claimed.length, completed, failed };
	}
}

import { redactCredentialMaterial } from "./credential-material.ts";
import type { ObjectiveCompletion, TaskLedger, TaskRecord } from "./task-ledger.ts";

export interface ObjectiveDeliveryInput {
	objective: TaskRecord;
	tasks: TaskRecord[];
	planId: string;
}

export interface ObjectiveDeliveryResult { result: string; evidence?: string; }
export type ObjectiveDeliverer = (input: ObjectiveDeliveryInput, signal?: AbortSignal) => Promise<ObjectiveDeliveryResult>;
export interface VerifiedObjectiveOutcome {
	objectiveId: string;
	title: string;
	result: string;
	evidence?: string;
	situation?: TaskRecord["situation"];
	accessScopeRef?: TaskRecord["accessScopeRef"];
	executionScope?: TaskRecord["executionScope"];
}
export type VerifiedObjectiveMemoryPublisher = (outcome: VerifiedObjectiveOutcome) => void | Promise<void>;

export interface ObjectiveDeliveryOutcome {
	objectiveId: string;
	status: "awaiting_verification" | "succeeded" | "failed" | "cancelled";
	finishedAt?: number;
	result?: string;
	error?: string;
}

/** Owns the seam between a Task Plan Outcome and delivery of its parent Objective. */
export class ObjectiveRuntime {
	private readonly ledger: Pick<TaskLedger, "queryTasks" | "transition"> & Partial<Pick<TaskLedger, "retryObjective" | "cancelObjectives" | "activeObjectivePlanIds" | "enqueueObjectiveCompletion">>;
	private readonly deliver: ObjectiveDeliverer;
	private readonly publishVerifiedOutcome?: VerifiedObjectiveMemoryPublisher;
	private readonly active = new Map<string, { controller: AbortController; work: Promise<ObjectiveDeliveryOutcome> }>();
	constructor(ledger: Pick<TaskLedger, "queryTasks" | "transition"> & Partial<Pick<TaskLedger, "retryObjective" | "cancelObjectives" | "activeObjectivePlanIds" | "enqueueObjectiveCompletion">>, deliver: ObjectiveDeliverer, publishVerifiedOutcome?: VerifiedObjectiveMemoryPublisher) { this.ledger = ledger; this.deliver = deliver; this.publishVerifiedOutcome = publishVerifiedOutcome; }

	async deliverPlan(ownerKey: string, planId: string, signal?: AbortSignal): Promise<ObjectiveDeliveryOutcome> {
		const key = `${ownerKey}\0${planId}`;
		const existing = this.active.get(key);
		if (existing) return existing.work;
		const controller = new AbortController();
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const work = this.executeDelivery(ownerKey, planId, combined).finally(() => { if (this.active.get(key)?.work === work) this.active.delete(key); });
		this.active.set(key, { controller, work });
		return work;
	}

	private async executeDelivery(ownerKey: string, planId: string, signal?: AbortSignal): Promise<ObjectiveDeliveryOutcome> {
		const tasks = this.ledger.queryTasks({ ownerKeys: [ownerKey], planIds: [planId], limit: 100 });
		let objective = this.objectiveForPlan(ownerKey, planId, tasks);
		if (objective.status === "failed" && this.retry(ownerKey, objective.id)) objective = this.ledger.queryTasks({ ownerKeys: [ownerKey], id: objective.id, kinds: ["objective"], limit: 1 })[0] ?? objective;
		if (objective.status === "succeeded" || objective.status === "failed" || objective.status === "cancelled") {
			return { objectiveId: objective.id, status: objective.status, finishedAt: objective.finishedAt ?? Date.now(), result: objective.result, error: objective.error };
		}
		if (objective.status === "running" && objective.verificationStatus === "accepted" && objective.candidateResult?.trim()) {
			if (!this.ledger.enqueueObjectiveCompletion?.(ownerKey, objective.id)) throw new Error(`Objective ${objective.id} could not remain in the durable Completion Outbox`);
			return { objectiveId: objective.id, status: "succeeded", result: objective.candidateResult };
		}
		if (tasks.length === 0 || tasks.some((task) => task.status !== "succeeded" || task.verificationStatus !== "accepted")) {
			return { objectiveId: objective.id, status: "awaiting_verification" };
		}
		const finishedAt = Date.now();
		try {
			if (signal?.aborted) throw signal.reason ?? new Error("Objective delivery cancelled");
			const delivered = await this.deliver({ objective, tasks, planId }, signal);
			const result = delivered.result.trim();
			if (!result) throw new Error("Objective delivery returned no result");
			if (!this.ledger.transition(objective.id, { status: "running", candidateResult: result.slice(0, 50_000), evidence: delivered.evidence?.slice(0, 5_000), verificationStatus: "accepted" })) throw new Error(`Objective ${objective.id} could not retain its accepted Candidate Outcome`);
			if (!this.ledger.enqueueObjectiveCompletion?.(ownerKey, objective.id)) throw new Error(`Objective ${objective.id} could not enter the durable Completion Outbox`);
			return { objectiveId: objective.id, status: "succeeded", finishedAt, result };
		} catch (error) {
			const message = redactCredentialMaterial(error instanceof Error ? error.message : String(error)).slice(0, 5_000);
			// Delivery is retried by the durable notice outbox; the Objective remains active until delivery succeeds.
			return { objectiveId: objective.id, status: "failed", finishedAt, error: message };
		}
	}

	/** Publishes idempotently after the channel returned a Receipt and before terminal acknowledgement. */
	async publishDelivered(completion: ObjectiveCompletion): Promise<void> {
		if (!completion.receipt || completion.status !== "delivered") throw new Error(`Objective ${completion.objectiveId} has no durable Delivery Receipt`);
		await this.publishAcceptedObjective(completion.ownerKey, completion.objectiveId);
	}

	async publishAcceptedObjective(ownerKey: string, objectiveId: string): Promise<void> {
		const objective = this.ledger.queryTasks({ ownerKeys: [ownerKey], id: objectiveId, kinds: ["objective"], statuses: ["running", "succeeded"], limit: 1 })[0];
		const result = objective?.status === "succeeded" ? objective.result : objective?.candidateResult;
		if (!objective || objective.verificationStatus !== "accepted" || !result?.trim()) throw new Error(`Delivered Objective ${objectiveId} has no accepted Outcome`);
		await this.publishVerifiedOutcome?.({ objectiveId: objective.id, title: objective.title, result, ...(objective.evidence ? { evidence: objective.evidence } : {}), ...(objective.situation ? { situation: structuredClone(objective.situation) } : {}), ...(objective.accessScopeRef ? { accessScopeRef: structuredClone(objective.accessScopeRef) } : {}), ...(objective.executionScope ? { executionScope: structuredClone(objective.executionScope) } : {}) });
	}

	/** Compatibility alias for callers that already hold a delivered Objective identity. */
	publishDeliveredObjective(ownerKey: string, objectiveId: string): Promise<void> { return this.publishAcceptedObjective(ownerKey, objectiveId); }

	async settlePlan(ownerKey: string, planId: string, status: "succeeded" | "failed" | "cancelled", signal?: AbortSignal): Promise<ObjectiveDeliveryOutcome> {
		if (status === "succeeded") return this.deliverPlan(ownerKey, planId, signal);
		const objective = this.objectiveForPlan(ownerKey, planId);
		const finishedAt = Date.now();
		const error = status === "failed" ? `Task Plan ${planId} failed before Objective delivery` : `Task Plan ${planId} was cancelled`;
		if (!this.ledger.transition(objective.id, { status, finishedAt, error })) {
			const durable = this.ledger.queryTasks({ ownerKeys: [ownerKey], id: objective.id, kinds: ["objective"], limit: 1 })[0];
			if (durable?.status === "succeeded" || durable?.status === "failed" || durable?.status === "cancelled") return { objectiveId: durable.id, status: durable.status, finishedAt: durable.finishedAt ?? finishedAt, result: durable.result, error: durable.error };
			throw new Error(`Objective ${objective.id} could not reach a Terminal Outcome`);
		}
		return { objectiveId: objective.id, status, finishedAt, error };
	}

	async settlePlanIfLinked(ownerKey: string, planId: string, status: "succeeded" | "failed" | "cancelled", signal?: AbortSignal): Promise<ObjectiveDeliveryOutcome | undefined> {
		const linked = this.ledger.queryTasks({ ownerKeys: [ownerKey], planIds: [planId], limit: 100 }).some((task) => Boolean(task.parentId));
		return linked ? this.settlePlan(ownerKey, planId, status, signal) : undefined;
	}

	retry(ownerKey: string, objectiveId: string): boolean { return this.ledger.retryObjective?.(ownerKey, objectiveId) ?? false; }

	cancelOwner(ownerKey: string): number { return this.cancelObjectives(ownerKey); }

	cancelPlans(ownerKey: string, planIds: readonly string[]): number { return this.cancelObjectives(ownerKey, new Set(planIds)); }

	private cancelObjectives(ownerKey: string, scopedPlanIds?: ReadonlySet<string>): number {
		for (const [key, delivery] of this.active) {
			const planId = key.slice(`${ownerKey}\0`.length);
			if (key.startsWith(`${ownerKey}\0`) && (!scopedPlanIds || scopedPlanIds.has(planId)) && !delivery.controller.signal.aborted) delivery.controller.abort(new Error("Objective delivery cancelled by user"));
		}
		if (!scopedPlanIds && this.ledger.cancelObjectives) return this.ledger.cancelObjectives(ownerKey);
		const objectives = scopedPlanIds
			? this.activeObjectivesForPlans(ownerKey, scopedPlanIds)
			: this.ledger.queryTasks({ ownerKeys: [ownerKey], kinds: ["objective"], statuses: ["pending", "running"], limit: 100 });
		const finishedAt = Date.now();
		let cancelled = 0;
		for (const objective of objectives) if (this.ledger.transition(objective.id, { status: "cancelled", finishedAt, error: "Cancelled by user" })) cancelled++;
		return cancelled;
	}

	private activeObjectivesForPlans(ownerKey: string, planIds: ReadonlySet<string>): TaskRecord[] {
		const objectiveIds = new Set<string>();
		for (const planId of planIds) {
			for (const task of this.ledger.queryTasks({ ownerKeys: [ownerKey], planIds: [planId], limit: 100 })) if (task.parentId) objectiveIds.add(task.parentId);
		}
		return [...objectiveIds].flatMap((id) => this.ledger.queryTasks({ ownerKeys: [ownerKey], id, kinds: ["objective"], statuses: ["pending", "running"], limit: 1 }));
	}

	planIdsForOwner(ownerKey: string): string[] {
		if (this.ledger.activeObjectivePlanIds) return this.ledger.activeObjectivePlanIds(ownerKey);
		const objectiveIds = new Set(this.ledger.queryTasks({ ownerKeys: [ownerKey], kinds: ["objective"], statuses: ["pending", "running"], limit: 100 }).map((task) => task.id));
		return [...new Set(this.ledger.queryTasks({ ownerKeys: [ownerKey], limit: 100 }).filter((task) => task.parentId && objectiveIds.has(task.parentId) && task.planId).map((task) => task.planId!))];
	}

	private objectiveForPlan(ownerKey: string, planId: string, knownTasks?: TaskRecord[]): TaskRecord {
		const tasks = knownTasks ?? this.ledger.queryTasks({ ownerKeys: [ownerKey], planIds: [planId], limit: 100 });
		const objectiveIds = [...new Set(tasks.map((task) => task.parentId).filter((id): id is string => Boolean(id)))];
		if (objectiveIds.length !== 1) throw new Error(`Task Plan ${planId} must belong to exactly one Objective`);
		const objective = this.ledger.queryTasks({ ownerKeys: [ownerKey], id: objectiveIds[0], kinds: ["objective"], limit: 1 })[0];
		if (!objective) throw new Error(`Objective not found for Task Plan ${planId}`);
		return objective;
	}
}

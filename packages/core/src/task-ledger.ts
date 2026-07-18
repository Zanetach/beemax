import type { AgentScope } from "./agent-scope.ts";
import type { DeliveryReceipt, DeliveryTarget } from "./delivery-port.ts";
import type { AccessScopeRef } from "./access-scope.ts";
import type { Situation } from "./situation.ts";
import type { TaskCheckpoint } from "./task-checkpoint.ts";
import type { WorkContract } from "./work-contract.ts";
import type { DurableContractAdmissionReceipt } from "./contract-admission-receipt.ts";
import type { ArtifactManifest, ArtifactVerificationReceipt, SourceReceipt } from "./artifact-runtime.ts";

export type TaskKind = "objective" | "delegated" | "automation";
export const MAX_OBJECTIVE_REVISIONS = 20;
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type TaskRecoveryPolicy = "never" | "safe_retry";
export type TaskVerificationStatus = "pending" | "accepted" | "rejected" | "unavailable";
export type TaskCriterionVerificationStatus = "accepted" | "rejected" | "unavailable";
export interface TaskCriterionVerification {
	criterionId: string;
	criterion: string;
	status: TaskCriterionVerificationStatus;
	evidence?: string;
	evidenceRefs: string[];
}
export interface TaskVerificationRequirement {
	capability: string;
	freshness?: "static" | "periodic" | "current" | "realtime";
	evidence?: "none" | "self_reported" | "source_receipt" | "verified";
}
export type TaskCandidateVerificationResolution = { accepted: true; evidence?: string; criterionVerifications?: TaskCriterionVerification[] } | { accepted: false; feedback: string; criterionVerifications?: TaskCriterionVerification[] };
export type TaskPlanStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export interface TaskArtifact {
	type: "file" | "url" | "reference";
	uri: string;
	label?: string;
	/** Content-addressed Artifact identity retained independently from conversational output. */
	manifest?: Readonly<ArtifactManifest>;
	/** Independent verification evidence bound to the exact Manifest bytes. */
	verificationReceipt?: Readonly<ArtifactVerificationReceipt>;
	/** Content-addressed current-source evidence retained across restart. */
	sourceReceipt?: Readonly<SourceReceipt>;
}

export interface TaskPlanRecord {
	id: string;
	ownerKey: string;
	title: string;
	status: TaskPlanStatus;
	taskCount: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	verified: number;
	correctiveAttempts: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	pausedAt?: number;
}
export interface TaskPlanCompletionNotice {
	id: string; planId: string; ownerKey: string; target: DeliveryTarget;
	planStatus: Extract<TaskPlanStatus, "succeeded" | "failed" | "cancelled">;
	title: string; taskCount: number; succeeded: number; failed: number; cancelled: number;
	status: "queued" | "delivering" | "delivered" | "abandoned"; claimToken?: string; attempts: number; nextAttemptAt: number; createdAt: number; abandonedAt?: number; error?: string;
}

/** One verified Objective payload awaiting durable channel acknowledgement. */
export interface ObjectiveCompletion {
	id: string;
	objectiveId: string;
	taskRunId: string;
	ownerKey: string;
	planId?: string;
	target: DeliveryTarget;
	deliveryIdempotencyKey: string;
	title: string;
	result: string;
	evidence?: string;
	status: "queued" | "delivering" | "delivered" | "blocked";
	claimToken?: string;
	attempts: number;
	nextAttemptAt: number;
	createdAt: number;
	receipt?: DeliveryReceipt;
	blockedAt?: number;
	error?: string;
}
export interface DirectObjectiveCompletionSettlement {
	ownerKey: string;
	objectiveId: string;
	taskRunId: string;
	candidateResult: string;
	evidence?: string;
	criterionVerifications?: TaskCriterionVerification[];
	artifacts?: TaskArtifact[];
	correctiveAttempts?: number;
	notBefore?: number;
}
export type TaskPlanTransition = Pick<TaskPlanRecord, "status" | "taskCount" | "succeeded" | "failed" | "cancelled" | "verified" | "correctiveAttempts"> & Partial<Pick<TaskPlanRecord, "startedAt" | "finishedAt">>;
export interface TaskPlanQuery { ownerKeys: string[]; id?: string; statuses?: TaskPlanStatus[]; limit?: number; }

/** Durable responsibility, independent of the worker or channel executing it. */
export interface TaskRecord {
	id: string;
	ownerKey: string;
	kind: TaskKind;
	title: string;
	description?: string;
	acceptanceCriteria?: string;
	recoveryPolicy?: TaskRecoveryPolicy;
	idempotencyKey?: string;
	executionScope?: AgentScope;
	/** Durable semantic understanding. It never grants data or execution access. */
	situation?: Situation;
	/** Validated immutable request contract retained across compaction and restart. */
	workContract?: WorkContract;
	/** Content-bound semantic admission proof; revalidated before restored Contract planning. */
	contractAdmission?: Readonly<DurableContractAdmissionReceipt>;
	/** Ordered, bounded amendments to the original Work Contract; history is retained instead of silently overwritten. */
	objectiveRevisions?: ObjectiveRevision[];
	/** Opaque authorization provenance established outside the model loop. */
	accessScopeRef?: AccessScopeRef;
	/** @deprecated Legacy semantic slots retained for stored-record migration. */
	businessContext?: { subject?: { type: string; id: string }; object?: { type: string; id: string } };
	status: TaskStatus;
	parentId?: string;
	planId?: string;
	evidence?: string;
	artifacts?: TaskArtifact[];
	unresolvedIssues?: string[];
	verificationStatus?: TaskVerificationStatus;
	verificationFeedback?: string;
	verificationRequirements?: TaskVerificationRequirement[];
	criterionVerifications?: TaskCriterionVerification[];
	verificationAttempts?: number;
	verificationRetryAt?: number;
	correctiveAttempts?: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	result?: string;
	candidateResult?: string;
	error?: string;
	checkpoint?: TaskCheckpoint | string;
	checkpointAt?: number;
	routes?: string[];
	routeIndex?: number;
}

export type TaskTransition = Pick<TaskRecord, "status"> & Partial<Pick<TaskRecord, "startedAt" | "finishedAt" | "result" | "candidateResult" | "error" | "evidence" | "artifacts" | "unresolvedIssues" | "verificationStatus" | "verificationFeedback" | "criterionVerifications" | "correctiveAttempts">>;
export interface ObjectiveRevision { id: string; workContract: WorkContract; situation: Situation; createdAt: number; }
export interface ObjectiveRevisionResult { originalWorkContract: WorkContract; revision: ObjectiveRevision; revisions: ObjectiveRevision[]; }
export interface ObjectiveCancellationResult { ownerKey: string; objectiveId: string; taskIds: string[]; planIds: string[]; retry?: boolean; }
export interface ObjectiveInterruptionRecord extends ObjectiveCancellationResult {}
export interface ObjectiveInterruptionClaim extends ObjectiveInterruptionRecord { claimToken: string; claimLeaseExpiresAt: number; }
export interface ObjectiveInterruptionConvergence { pendingExecutions: number; }

export type TaskRunStatus = "running" | "succeeded" | "failed" | "cancelled";
export interface TaskRunRecord {
	id: string;
	taskId: string;
	executor: "agent" | "subagent" | "automation";
	status: TaskRunStatus;
	startedAt: number;
	leaseExpiresAt?: number;
	cancellationRequestedAt?: number;
	finishedAt?: number;
	output?: string;
	error?: string;
}
export type TaskRunTransition = Pick<TaskRunRecord, "status"> & Partial<Pick<TaskRunRecord, "finishedAt" | "output" | "error">>;
export interface TaskRunAndTaskSuccessSettlement {
	ownerKey: string;
	taskId: string;
	taskRunId: string;
	task: TaskTransition & { status: "succeeded" };
	run: TaskRunTransition & { status: "succeeded" };
}
export interface TaskRecoveryPlanRef { ownerKey: string; planId: string; }
export interface TaskRecoveryResult { retried: number; failed: number; affectedPlans: TaskRecoveryPlanRef[]; }
export interface TaskRunEffectStateReader { taskRunReplayState(query: { ownerKey: string; taskId: string; taskRunId: string }): "clear" | "blocked"; }
export interface TaskQuery {
	ownerKeys: string[];
	id?: string;
	kinds?: TaskKind[];
	statuses?: TaskStatus[];
	planIds?: string[];
	parentIds?: string[];
	limit?: number;
}
export interface TaskDependency { taskId: string; dependsOn: string; }

/** Persistence port used by task producers; storage remains replaceable. */
export interface TaskLedger {
	record(task: TaskRecord): void;
	transition(id: string, change: TaskTransition): boolean;
	updateSituation?(ownerKey: string, taskId: string, situation: Situation): boolean;
	reviseObjective(ownerKey: string, taskId: string, revision: Pick<ObjectiveRevision, "workContract" | "situation"> & { contractAdmission?: Readonly<DurableContractAdmissionReceipt> | null }, now?: number): ObjectiveRevisionResult | undefined;
	updateVerificationRequirements?(ownerKey: string, taskId: string, requirements: TaskVerificationRequirement[]): boolean;
	retryObjective?(ownerKey: string, id: string, now?: number): boolean;
	cancelObjective?(ownerKey: string, id: string, now?: number): ObjectiveCancellationResult | undefined;
	pendingObjectiveInterruptions?(ownerKeys: string[], limit?: number): ObjectiveInterruptionRecord[];
	claimObjectiveInterruptions?(ownerKeys: string[], holderId: string, leaseExpiresAt: number, now?: number, limit?: number): ObjectiveInterruptionClaim[];
	objectiveInterruptionConvergence?(ownerKey: string, objectiveId: string, now?: number): ObjectiveInterruptionConvergence;
	isObjectiveExecutionActive?(ownerKey: string, objectiveId: string, taskRunId: string, now?: number): boolean;
	isTaskRunExecutionActive?(ownerKey: string, objectiveId: string, taskId: string, taskRunId: string, now?: number): boolean;
	settleObjectiveInterruption?(ownerKey: string, objectiveId: string, now?: number, holderId?: string, claimToken?: string): boolean;
	failObjectiveInterruption?(ownerKey: string, objectiveId: string, error: string, now?: number, holderId?: string, claimToken?: string): boolean;
	cancelObjectives?(ownerKey: string, now?: number): number;
	activeObjectivePlanIds?(ownerKey: string): string[];
	recordRun(run: TaskRunRecord): void;
	transitionRun(id: string, change: TaskRunTransition): boolean;
	settleTaskRunAndTask?(settlement: TaskRunAndTaskSuccessSettlement, now?: number): boolean;
	queryTasks(query: TaskQuery): TaskRecord[];
	taskRuns(taskId: string): TaskRunRecord[];
	recordPlan(tasks: TaskRecord[], dependencies: TaskDependency[], plan?: TaskPlanRecord): void;
	transitionPlan(id: string, change: TaskPlanTransition): boolean;
	claimTaskPlanExecution?(ownerKey: string, planId: string, holderId: string, leaseExpiresAt: number, now?: number): boolean;
	renewTaskPlanExecution?(ownerKey: string, planId: string, holderId: string, leaseExpiresAt: number, now?: number): boolean;
	releaseTaskPlanExecution?(ownerKey: string, planId: string, holderId: string): boolean;
	claimTaskVerification?(ownerKey: string, taskId: string, holderId: string, leaseExpiresAt: number, now?: number): boolean;
	renewTaskVerification?(ownerKey: string, taskId: string, holderId: string, leaseExpiresAt: number, now?: number): boolean;
	releaseTaskVerification?(ownerKey: string, taskId: string, holderId: string): boolean;
	queryTaskPlans(query: TaskPlanQuery): TaskPlanRecord[];
	taskDependencies(taskIds: string[]): TaskDependency[];
	checkpointTask(ownerKey: string, taskId: string, checkpoint: TaskCheckpoint | string, now?: number): boolean;
	advanceTaskRoute(ownerKey: string, taskId: string, error: string, now?: number): boolean;
	pauseTaskPlan(ownerKeys: string[], planId: string, now?: number): boolean;
	resumeTaskPlan(ownerKeys: string[], planId: string, now?: number): boolean;
	reconcileExpiredTaskRuns(now?: number, effects?: TaskRunEffectStateReader): TaskRecoveryResult;
	recoveryCandidates(limit?: number, excludePlanIds?: string[]): TaskRecord[];
	verificationCandidates?(now?: number, limit?: number, excludePlanIds?: string[]): TaskRecord[];
	deferCandidateVerification?(ownerKeys: string[], taskId: string, now?: number): boolean;
	resolveCandidateVerification?(ownerKeys: string[], taskId: string, resolution: TaskCandidateVerificationResolution, now?: number): boolean;
	settleDirectObjectiveCompletion?(settlement: DirectObjectiveCompletionSettlement, now?: number): boolean;
	enqueueObjectiveCompletion?(ownerKey: string, objectiveId: string, now?: number, notBefore?: number): boolean;
	getObjectiveCompletion?(id: string): ObjectiveCompletion | undefined;
	claimObjectiveCompletions?(platform: string, now?: number, limit?: number, leaseMs?: number): ObjectiveCompletion[];
	recordObjectiveCompletionReceipt?(id: string, receipt: DeliveryReceipt, now?: number): boolean;
	isObjectiveCompletionCancelledAfterDelivery?(id: string, receipt: DeliveryReceipt): boolean;
	completeObjectiveCompletion?(id: string, claimToken: string, receipt: DeliveryReceipt, now?: number): boolean;
	acknowledgeObjectiveCompletion?(id: string, receipt: DeliveryReceipt, now?: number): boolean;
	failObjectiveCompletion?(id: string, claimToken: string, now?: number): boolean;
	deferObjectiveCompletion?(id: string, claimToken: string, retryAt: number, now?: number): boolean;
	renewObjectiveCompletion?(id: string, claimToken: string, leaseExpiresAt: number, now?: number): boolean;
	blockObjectiveCompletion?(id: string, claimToken: string, error: string, now?: number): boolean;
	prepareTaskCorrections?(maxCorrectiveAttempts: number, now?: number): number;
	enqueueTaskPlanCompletionNotice?(ownerKey: string, planId: string, now?: number): boolean;
	claimTaskPlanCompletionNotices?(platform: string, now?: number, limit?: number, leaseMs?: number): TaskPlanCompletionNotice[];
	completeTaskPlanCompletionNotice?(id: string, claimToken: string): boolean;
	failTaskPlanCompletionNotice?(id: string, claimToken: string, now?: number): boolean;
	deferTaskPlanCompletionNotice?(id: string, claimToken: string, retryAt: number, now?: number): boolean;
	renewTaskPlanCompletionNotice?(id: string, claimToken: string, leaseExpiresAt: number): boolean;
	abandonTaskPlanCompletionNotice?(id: string, claimToken: string, error: string, now?: number): boolean;
	renewTaskRunLease?(id: string, leaseExpiresAt: number, now?: number): boolean;
	prepareTaskPlanRetry(ownerKeys: string[], planId: string, maxCorrectiveAttempts?: number): number;
	cancelTaskPlan(ownerKeys: string[], planId: string, now?: number): number;
	failTaskPlan?(ownerKeys: string[], planId: string, holderId: string, error: string, now?: number): number;
}

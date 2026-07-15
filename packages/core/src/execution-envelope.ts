import { containsCredentialMaterial } from "./credential-material.ts";
import { createAccessScopeRef, type AccessScopeRef } from "./access-scope.ts";

export type ExecutionTriggerKind = "interaction" | "automation" | "enterprise_event" | "task_transition" | "delegation" | "recovery" | "verification" | "compensation" | "manual";
export type ExecutionMode = "normal" | "recovery" | "verification" | "correction";
export type VerificationProtocol = "task_candidate_v1" | "skill_candidate_v1";
export interface ExecutionBudgetRef { maxToolCalls?: number; maxTokens?: number; deadlineAt?: number; maxCorrectiveAttempts?: number; }
export interface ProactiveActionAuthorityRef {
	phase: "forward" | "compensation";
	scopeId: string;
	/** The only mutating Tool this execution is authorized to call. */
	capability: string;
	/** The forward capability used to resolve the durable Compensation exercise. */
	forwardCapability: string;
	policyDecisionId: string;
	compensationId: string;
	emergencyStopRevision: number;
}
export interface ExecutionEnvelope {
	executionId: string;
	trigger: { kind: ExecutionTriggerKind; id?: string };
	objectiveId?: string;
	taskId?: string;
	taskRunId?: string;
	/** Trusted Composition Root link for an inverse action; the original Effect remains immutable. */
	compensatesEffectId?: string;
	proactiveAction?: Readonly<ProactiveActionAuthorityRef>;
	accessScopeRef?: AccessScopeRef;
	budget?: ExecutionBudgetRef;
	mode: ExecutionMode;
	/** Selects the structured verdict contract owned by this verification execution. */
	verificationProtocol?: VerificationProtocol;
}

const EXECUTION_TRIGGER_KINDS = new Set<ExecutionTriggerKind>(["interaction", "automation", "enterprise_event", "task_transition", "delegation", "recovery", "verification", "compensation", "manual"]);
const EXECUTION_MODES = new Set<ExecutionMode>(["normal", "recovery", "verification", "correction"]);
const VERIFICATION_PROTOCOLS = new Set<VerificationProtocol>(["task_candidate_v1", "skill_candidate_v1"]);

export function createExecutionEnvelope(input: Omit<ExecutionEnvelope, "mode"> & { mode?: ExecutionMode }): Readonly<ExecutionEnvelope> {
	if (containsCredentialMaterial(JSON.stringify(input))) throw new Error("Execution Envelope cannot contain credential material");
	if (!EXECUTION_TRIGGER_KINDS.has(input.trigger.kind)) throw new Error("Execution Envelope trigger kind is invalid");
	if ((input.trigger.kind === "compensation") !== Boolean(input.compensatesEffectId)) throw new Error("Execution Envelope Compensation requires an original Effect identity and dedicated trigger");
	const mode = input.mode ?? "normal";
	if (!EXECUTION_MODES.has(mode)) throw new Error("Execution Envelope mode is invalid");
	if (input.verificationProtocol && !VERIFICATION_PROTOCOLS.has(input.verificationProtocol)) throw new Error("Execution Envelope verification protocol is invalid");
	if (input.verificationProtocol && mode !== "verification") throw new Error("Execution Envelope verification protocol requires verification mode");
	const budget = input.budget ? createBudget(input.budget) : undefined;
	const accessScopeRef = input.accessScopeRef ? freezeAccessScope(input.accessScopeRef) : undefined;
	const proactiveAction = input.proactiveAction ? freezeProactiveAction(input.proactiveAction) : undefined;
	return Object.freeze({
		executionId: requiredRef(input.executionId, "executionId"),
		trigger: Object.freeze({ kind: input.trigger.kind, ...(input.trigger.id ? { id: requiredRef(input.trigger.id, "trigger.id") } : {}) }),
		...(input.objectiveId ? { objectiveId: requiredRef(input.objectiveId, "objectiveId") } : {}),
		...(input.taskId ? { taskId: requiredRef(input.taskId, "taskId") } : {}),
		...(input.taskRunId ? { taskRunId: requiredRef(input.taskRunId, "taskRunId") } : {}),
		...(input.compensatesEffectId ? { compensatesEffectId: requiredRef(input.compensatesEffectId, "compensatesEffectId") } : {}),
		...(proactiveAction ? { proactiveAction } : {}),
		...(accessScopeRef ? { accessScopeRef } : {}),
		...(budget ? { budget } : {}),
		mode,
		...(input.verificationProtocol ? { verificationProtocol: input.verificationProtocol } : {}),
	});
}

function freezeProactiveAction(input: ProactiveActionAuthorityRef): Readonly<ProactiveActionAuthorityRef> {
	if (input.phase !== "forward" && input.phase !== "compensation") throw new Error("Execution Envelope proactive action phase is invalid");
	if (!Number.isSafeInteger(input.emergencyStopRevision) || input.emergencyStopRevision < 0) throw new Error("Execution Envelope Emergency Stop revision is invalid");
	const capability = requiredRef(input.capability, "proactiveAction.capability");
	const forwardCapability = requiredRef(input.forwardCapability, "proactiveAction.forwardCapability");
	if (input.phase === "forward" && capability !== forwardCapability) throw new Error("Execution Envelope forward proactive capability must match its admitted capability");
	return Object.freeze({ phase: input.phase, scopeId: requiredRef(input.scopeId, "proactiveAction.scopeId"), capability, forwardCapability, policyDecisionId: requiredRef(input.policyDecisionId, "proactiveAction.policyDecisionId"), compensationId: requiredRef(input.compensationId, "proactiveAction.compensationId"), emergencyStopRevision: input.emergencyStopRevision });
}

function freezeAccessScope(input: AccessScopeRef): Readonly<AccessScopeRef> {
	if (input.trust !== "verified") throw new Error("Execution Envelope Access Scope must be trusted");
	const validated = createAccessScopeRef({ id: input.id, authority: input.authority, ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}), issuedAt: input.issuedAt });
	return Object.freeze({ ...validated, authority: Object.freeze({ ...validated.authority }) });
}

function createBudget(input: ExecutionBudgetRef): Readonly<ExecutionBudgetRef> {
	return Object.freeze({
		...(input.maxToolCalls === undefined ? {} : { maxToolCalls: positiveInteger(input.maxToolCalls, "maxToolCalls") }),
		...(input.maxTokens === undefined ? {} : { maxTokens: positiveInteger(input.maxTokens, "maxTokens") }),
		...(input.deadlineAt === undefined ? {} : { deadlineAt: positiveInteger(input.deadlineAt, "deadlineAt") }),
		...(input.maxCorrectiveAttempts === undefined ? {} : { maxCorrectiveAttempts: nonNegativeInteger(input.maxCorrectiveAttempts, "maxCorrectiveAttempts") }),
	});
}

function requiredRef(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 512) throw new Error(`Execution Envelope ${field} must be between 1 and 512 characters`);
	return normalized;
}
function positiveInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Execution Envelope ${field} must be a positive integer`);
	return value;
}
function nonNegativeInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Execution Envelope ${field} must be a non-negative integer`);
	return value;
}

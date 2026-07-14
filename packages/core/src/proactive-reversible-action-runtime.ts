import type { AgentScope } from "./agent-scope.ts";
import type { AccessScopeRef } from "./access-scope.ts";
import type { EnterprisePolicyDecision } from "./enterprise-policy.ts";
import { resolveEnterprisePolicyDecision } from "./enterprise-policy.ts";
import type { ExecutionBudgetRef, ProactiveActionAuthorityRef } from "./execution-envelope.ts";
import { initiativeScopeMatchesExecutionScope, type InitiativeObservation } from "./initiative-runtime.ts";
import { ReversibleActionAdmission, type CompensationProof, type ReversibleActionCapability, type ReversibleActionControlPort } from "./reversible-action-admission.ts";
import type { ToolPolicy } from "./tool-runtime.ts";
import type { AutonomyRolloutController } from "./autonomy-rollout.ts";

export interface ProactiveReversibleActionExecution {
	observation: InitiativeObservation;
	executionScope: AgentScope;
	accessScopeRef: AccessScopeRef;
	capability: ReversibleActionCapability;
	allowedCapabilities: string[];
	policyDecision: EnterprisePolicyDecision;
	policyDecisionId: string;
	compensation: CompensationProof;
	compensationCapability: { name: string; policy: ToolPolicy };
	compensationPolicyDecision: EnterprisePolicyDecision;
	emergencyStopRevision: number;
	proactiveAction: ProactiveActionAuthorityRef;
	budget: ExecutionBudgetRef;
	prompt: string;
}

export interface ProactiveReversibleActionExecutionResult {
	status: "succeeded" | "failed" | "cancelled";
	objectiveId: string;
	verification: "accepted" | "rejected" | "unavailable";
	committedEffectIds: string[];
}

export interface ProactiveCompensationExecution {
	objectiveId: string;
	compensatesEffectId: string;
	capability: string;
	allowedCapabilities: string[];
	proof: CompensationProof;
	executionScope: AgentScope;
	accessScopeRef: AccessScopeRef;
	policyDecision: EnterprisePolicyDecision;
	emergencyStopRevision: number;
	proactiveAction: ProactiveActionAuthorityRef;
}

export interface ProactiveCompensationResult {
	status: "committed" | "failed" | "unknown";
	effectId?: string;
	verification: "accepted" | "rejected" | "unavailable";
}

export interface ProactiveReversibleActionRuntimeOptions {
	autonomy: Pick<AutonomyRolloutController, "allows">;
	controls: Pick<ReversibleActionControlPort, "emergencyStop" | "compensationProof">;
	admission: ReversibleActionAdmission;
	execute(input: ProactiveReversibleActionExecution): Promise<ProactiveReversibleActionExecutionResult>;
	compensate(input: ProactiveCompensationExecution): Promise<ProactiveCompensationResult>;
}

export interface ProactiveReversibleActionCandidate {
	observation: InitiativeObservation;
	executionScope: AgentScope;
	accessScopeRef: AccessScopeRef;
	enterprisePolicy: EnterprisePolicyDecision;
	capability: { name: string; policy: ToolPolicy };
	compensationCapability: { name: string; policy: ToolPolicy };
	compensationEnterprisePolicy: EnterprisePolicyDecision;
}

export type ProactiveReversibleActionResult =
	| { kind: "succeeded"; objectiveId: string; committedEffectIds: string[]; notify: true }
	| { kind: "compensated"; objectiveId: string; originalEffectIds: string[]; compensationEffectIds: string[]; notify: true }
	| { kind: "rejected"; reason: string; notify: false }
	| { kind: "failed"; objectiveId: string; reason: string; unresolvedEffectIds: string[]; notify: true };

/** Coordinates governed mutation and Compensation through existing execution ports; it owns no Agent loop. */
export class ProactiveReversibleActionRuntime {
	private readonly options: ProactiveReversibleActionRuntimeOptions;
	constructor(options: ProactiveReversibleActionRuntimeOptions) { this.options = options; }

	async consider(candidate: ProactiveReversibleActionCandidate, at = Date.now()): Promise<ProactiveReversibleActionResult> {
		if (!this.options.autonomy.allows("reversible_action").allowed) return { kind: "rejected", reason: "autonomy_level_disabled", notify: false };
		if (!initiativeScopeMatchesExecutionScope(candidate.observation.scope, candidate.executionScope)) return { kind: "rejected", reason: "execution_scope_mismatch", notify: false };
		const scopeId = candidate.accessScopeRef.id;
		const compensation = this.options.controls.compensationProof(scopeId, candidate.capability.name, at);
		if (!compensation) return { kind: "rejected", reason: "compensation_proof_required", notify: false };
		const capability: ReversibleActionCapability = { ...candidate.capability, compensation };
		const compensationRejection = compensationAuthorityRejection(candidate, compensation, at);
		if (compensationRejection) return { kind: "rejected", reason: compensationRejection, notify: false };
		const stop = this.options.controls.emergencyStop(scopeId);
		const decision = this.options.admission.decide({
			actionId: `initiative:${candidate.observation.id}`,
			capability,
			enterprisePolicy: candidate.enterprisePolicy,
			accessScopeRef: candidate.accessScopeRef,
			emergencyStop: stop,
			at,
		});
		if (decision.outcome !== "allow") return { kind: "rejected", reason: decision.reasonCode, notify: false };
		const currentStop = this.options.controls.emergencyStop(scopeId);
		if (currentStop.status !== "running" || currentStop.revision !== decision.emergencyStopRevision) return { kind: "rejected", reason: "emergency_stop_changed", notify: false };
		const execution = await this.options.execute({
			observation: candidate.observation,
			executionScope: candidate.executionScope,
			accessScopeRef: candidate.accessScopeRef,
			capability,
			allowedCapabilities: [capability.name],
			policyDecision: candidate.enterprisePolicy,
			policyDecisionId: decision.policyDecisionId,
			compensation,
			compensationCapability: candidate.compensationCapability,
			compensationPolicyDecision: candidate.compensationEnterprisePolicy,
			emergencyStopRevision: decision.emergencyStopRevision,
			proactiveAction: {
				phase: "forward", scopeId, capability: capability.name, forwardCapability: capability.name,
				policyDecisionId: decision.policyDecisionId, compensationId: compensation.id, emergencyStopRevision: decision.emergencyStopRevision,
			},
			budget: { maxToolCalls: 3, maxTokens: 4_000, deadlineAt: at + 30_000, maxCorrectiveAttempts: 0 },
			prompt: mutationPrompt(candidate.observation, capability.name),
		});
		const effectIds = [...new Set(execution.committedEffectIds)];
		if (execution.status === "succeeded" && execution.verification === "accepted") return { kind: "succeeded", objectiveId: execution.objectiveId, committedEffectIds: effectIds, notify: true };
		if (!effectIds.length) return { kind: "failed", objectiveId: execution.objectiveId, reason: `execution_${execution.status}_${execution.verification}`, unresolvedEffectIds: [], notify: true };

		const compensationEffectIds: string[] = [];
		const unresolvedEffectIds: string[] = [];
		for (const effectId of effectIds) {
			const latestStop = this.options.controls.emergencyStop(scopeId);
			// Emergency Stop blocks new forward mutations but permits the proven inverse action needed to reduce impact.
			if (latestStop.revision < decision.emergencyStopRevision) { unresolvedEffectIds.push(effectId); continue; }
			const result = await this.options.compensate({
				objectiveId: execution.objectiveId,
				compensatesEffectId: effectId,
				capability: compensation.capability,
				allowedCapabilities: [compensation.capability],
				proof: compensation,
				executionScope: candidate.executionScope,
				accessScopeRef: candidate.accessScopeRef,
				policyDecision: candidate.compensationEnterprisePolicy,
				emergencyStopRevision: latestStop.revision,
				proactiveAction: {
					phase: "compensation", scopeId, capability: compensation.capability, forwardCapability: capability.name,
					policyDecisionId: candidate.compensationEnterprisePolicy.id, compensationId: compensation.id, emergencyStopRevision: latestStop.revision,
				},
			});
			if (result.status === "committed" && result.verification === "accepted" && result.effectId) compensationEffectIds.push(result.effectId);
			else unresolvedEffectIds.push(effectId);
		}
		if (unresolvedEffectIds.length) return { kind: "failed", objectiveId: execution.objectiveId, reason: "compensation_incomplete", unresolvedEffectIds, notify: true };
		return { kind: "compensated", objectiveId: execution.objectiveId, originalEffectIds: effectIds, compensationEffectIds, notify: true };
	}
}

function compensationAuthorityRejection(candidate: ProactiveReversibleActionCandidate, proof: CompensationProof, at: number): string | undefined {
	if (candidate.compensationCapability.name !== proof.capability) return "compensation_capability_mismatch";
	const policy = candidate.compensationCapability.policy;
	if (policy.sideEffect === "none" || policy.risk !== "low") return "compensation_low_risk_mutation_required";
	if (policy.sideEffect === "external" && policy.effectProofProvider !== proof.receiptProofProvider) return "compensation_receipt_proof_mismatch";
	const decision = candidate.compensationEnterprisePolicy;
	if (at < decision.effectiveFrom || decision.effectiveUntil !== undefined && at > decision.effectiveUntil || decision.evaluatedAt > at) return "compensation_policy_not_current";
	if (decision.effectiveScope.kind === "access_scope" && decision.effectiveScope.accessScopeId !== candidate.accessScopeRef.id) return "compensation_policy_scope_mismatch";
	if (decision.publisher.trust !== "verified" || !decision.evidenceRefs.length) return "compensation_policy_untrusted";
	const resolved = resolveEnterprisePolicyDecision(decision, policy);
	return !resolved.allowed || resolved.requiresApproval ? "compensation_policy_does_not_allow_autonomy" : undefined;
}

function mutationPrompt(observation: InitiativeObservation, capability: string): string {
	return [observation.action, `Why this may matter: ${observation.rationale}`, `Verify: ${observation.intendedVerification}`, `Use only the admitted capability ${capability}. Execute at most one bounded mutation. Do not substitute another Tool or repeat an uncertain Effect.`].join("\n\n");
}

import type { AccessScopeRef } from "./access-scope.ts";
import type { EnterprisePolicyDecision } from "./enterprise-policy.ts";
import { resolveEnterprisePolicyDecision } from "./enterprise-policy.ts";
import type { ToolPolicy } from "./tool-runtime.ts";
import type { ProactiveMutationAuthority, BeeMaxRuntimeSource } from "./runtime.ts";

export interface CompensationProof {
	id: string;
	capability: string;
	receiptProofProvider?: string;
	exercisedAt: number;
	validUntil: number;
	evidenceRefs: string[];
}

export interface ReversibleActionCapability {
	name: string;
	policy: ToolPolicy;
	compensation: CompensationProof;
}

export interface EmergencyStopSnapshot {
	status: "running" | "stopped";
	revision: number;
	changedAt: number;
}

export interface EmergencyStopRecord extends EmergencyStopSnapshot {
	scopeId: string;
	publisherId?: string;
	evidenceRef?: string;
}

export interface ReversibleActionControlPort {
	emergencyStop(scopeId: string): EmergencyStopRecord;
	setEmergencyStop(input: { scopeId: string; status: EmergencyStopSnapshot["status"]; expectedRevision: number; publisher: EnterprisePolicyDecision["publisher"]; evidenceRef: string; changedAt: number }): boolean;
	recordCompensationExercise(input: { scopeId: string; forwardCapability: string; proof: CompensationProof; publisher: EnterprisePolicyDecision["publisher"] }): boolean;
	compensationProof(scopeId: string, forwardCapability: string, at: number): CompensationProof | undefined;
}

export interface ReversibleActionAdmissionInput {
	actionId: string;
	capability: ReversibleActionCapability;
	enterprisePolicy?: EnterprisePolicyDecision;
	accessScopeRef?: AccessScopeRef;
	emergencyStop: EmergencyStopSnapshot;
	at: number;
}

export type ReversibleActionAdmissionDecision =
	| { outcome: "allow"; reasonCode: "proven_reversible_action"; actionId: string; capability: string; policyDecisionId: string; compensationId: string; emergencyStopRevision: number; decidedAt: number }
	| { outcome: "deny"; reasonCode: string; actionId: string; capability: string; emergencyStopRevision: number; decidedAt: number };

/** Pure admission gate; execution remains in the existing Pi and Effect lifecycle. */
export class ReversibleActionAdmission {
	decide(input: ReversibleActionAdmissionInput): ReversibleActionAdmissionDecision {
		const actionId = required(input.actionId, "actionId");
		const capability = required(input.capability.name, "capability");
		const at = time(input.at, "decision time");
		const revision = integer(input.emergencyStop.revision, "Emergency Stop revision");
		const deny = (reasonCode: string): ReversibleActionAdmissionDecision => ({ outcome: "deny", reasonCode, actionId, capability, emergencyStopRevision: revision, decidedAt: at });
		if (input.emergencyStop.status !== "running") return deny("emergency_stop_active");
		if (input.emergencyStop.changedAt > at) return deny("emergency_stop_snapshot_invalid");
		if (!input.accessScopeRef || input.accessScopeRef.trust !== "verified") return deny("trusted_scope_required");
		const policy = input.enterprisePolicy;
		if (!policy) return deny("enterprise_policy_required");
		if (at < policy.effectiveFrom || policy.effectiveUntil !== undefined && at > policy.effectiveUntil || policy.evaluatedAt > at) return deny("enterprise_policy_not_current");
		if (policy.effectiveScope.kind === "access_scope" && policy.effectiveScope.accessScopeId !== input.accessScopeRef.id) return deny("enterprise_policy_scope_mismatch");
		if (policy.publisher.trust !== "verified" || !policy.evidenceRefs.length) return deny("enterprise_policy_untrusted");
		const resolvedPolicy = resolveEnterprisePolicyDecision(policy, input.capability.policy);
		if (!resolvedPolicy.allowed) return deny("enterprise_policy_does_not_allow_autonomy");
		if (input.capability.policy.sideEffect === "none") return deny("mutation_required");
		if (input.capability.policy.risk !== "low") return deny("low_risk_required");
		if (input.capability.policy.reversible !== true) return deny("proven_reversibility_required");
		const compensation = input.capability.compensation;
		if (!compensation.evidenceRefs.length || compensation.exercisedAt > at || compensation.validUntil < at) return deny("rollback_exercise_not_current");
		if (input.capability.policy.sideEffect === "external" && (!input.capability.policy.effectProofProvider || compensation.receiptProofProvider !== input.capability.policy.effectProofProvider)) return deny("compensation_receipt_proof_mismatch");
		return {
			outcome: "allow", reasonCode: "proven_reversible_action", actionId, capability,
			policyDecisionId: policy.id, compensationId: required(compensation.id, "Compensation id"),
			emergencyStopRevision: revision, decidedAt: at,
		};
	}
}

/** Rechecks durable mutation controls at Pi's actual beforeToolCall boundary. */
export function createReversibleActionMutationAuthority<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource>(
	controls: Pick<ReversibleActionControlPort, "emergencyStop" | "compensationProof">,
	now: () => number = Date.now,
): ProactiveMutationAuthority<Source> {
	return ({ executionEnvelope, toolName, policy, enterprisePolicy }) => {
		const authority = executionEnvelope.proactiveAction;
		if (!authority) return { allowed: false, reason: "Proactive mutation authority reference is missing" };
		if (executionEnvelope.accessScopeRef?.trust !== "verified" || executionEnvelope.accessScopeRef.id !== authority.scopeId) return { allowed: false, reason: "Proactive mutation trusted scope no longer matches" };
		if (toolName !== authority.capability) return { allowed: false, reason: "Proactive mutation capability no longer matches" };
		if (enterprisePolicy.id !== authority.policyDecisionId) return { allowed: false, reason: "Proactive mutation Enterprise Policy decision changed" };
		if (policy.sideEffect === "none" || policy.risk !== "low" || policy.reversible !== true) return { allowed: false, reason: "Proactive mutation is no longer a reversible low-risk action" };
		const at = now();
		const proof = controls.compensationProof(authority.scopeId, authority.forwardCapability, at);
		if (!proof || proof.id !== authority.compensationId || authority.phase === "compensation" && proof.capability !== authority.capability) return { allowed: false, reason: "Proactive mutation Compensation proof is missing or changed" };
		const stop = controls.emergencyStop(authority.scopeId);
		if (authority.phase === "forward" && (stop.status !== "running" || stop.revision !== authority.emergencyStopRevision)) return { allowed: false, reason: "Proactive mutation is stopped or its control revision changed" };
		if (authority.phase === "compensation" && stop.revision < authority.emergencyStopRevision) return { allowed: false, reason: "Compensation control revision is invalid" };
		return { allowed: true };
	};
}

function required(value: string, label: string): string { const normalized = value?.trim(); if (!normalized || normalized.length > 512) throw new Error(`Reversible Action ${label} is invalid`); return normalized; }
function time(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Reversible Action ${label} is invalid`); return value; }
function integer(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Reversible Action ${label} is invalid`); return value; }

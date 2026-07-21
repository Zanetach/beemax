import type { EnterpriseActionConstraints, EnterprisePolicyDisposition } from "./enterprise-policy.ts";
import type { ToolPolicy, ToolRisk } from "./tool-runtime.ts";
import type { ToolEffectStatus } from "./tool-effect.ts";

export type ActionGovernanceOutcome = "allow" | "deny" | "missing_evidence";
export type MeasuredActionReliability = "reliable" | "degraded" | "unknown";

export interface ActionExecutionGrant {
	id: string;
	status: "active";
	allowedCapabilities: readonly string[];
}

export interface ActionGovernanceInput {
	actionId: string;
	toolName: string;
	toolPolicy: ToolPolicy;
	effectStatus: ToolEffectStatus | "none";
	reliability: MeasuredActionReliability;
	enterprisePolicy?: { id: string; disposition: EnterprisePolicyDisposition; reason: string; constraints?: EnterpriseActionConstraints };
	executionGrant?: ActionExecutionGrant;
	at: number;
}

export interface ActionGovernanceDecision {
	id: string;
	actionId: string;
	toolName: string;
	outcome: ActionGovernanceOutcome;
	reasonCode: string;
	explanation: string;
	factors: string[];
	policyDecisionId?: string;
	executionGrantId?: string;
	decidedAt: number;
}

/** Pure per-action decision kernel; Pi's Tool hook remains the enforcement point. */
export class ActionGovernance {
	decide(input: ActionGovernanceInput): ActionGovernanceDecision {
		const factors = [`risk:${input.toolPolicy.risk}`, `side_effect:${input.toolPolicy.sideEffect}`, `reversible:${String(input.toolPolicy.reversible)}`, `reliability:${input.reliability}`, `effect:${input.effectStatus}`, "approval_mode:none"];
		const decide = (outcome: ActionGovernanceOutcome, reasonCode: string, explanation: string, extra: Pick<ActionGovernanceDecision, "policyDecisionId" | "executionGrantId"> = {}) => Object.freeze({
			id: `governance:${required(input.actionId, "actionId", 256)}:${timestamp(input.at)}`, actionId: input.actionId, toolName: required(input.toolName, "toolName", 128), outcome, reasonCode, explanation,
			factors: Object.freeze([...factors]) as unknown as string[], ...extra, decidedAt: input.at,
		});

		if (input.toolPolicy.sideEffect !== "none" && ["planned", "executing", "committed", "unknown"].includes(input.effectStatus)) return decide("deny", "effect_reconciliation_required", "A mutating Effect must settle or reconcile before this action can proceed");
		const enterprise = input.enterprisePolicy;
		if (enterprise?.disposition === "deny") return decide("deny", "enterprise_policy_deny", enterprise.reason, { policyDecisionId: enterprise.id });
		if (enterprise?.disposition === "missing_evidence") return decide("missing_evidence", "enterprise_policy_missing_evidence", enterprise.reason, { policyDecisionId: enterprise.id });
		if (enterprise?.disposition === "constrain") {
			const mismatch = constraintMismatch(enterprise.constraints, input.toolPolicy);
			if (mismatch) return decide("deny", "enterprise_constraint", mismatch, { policyDecisionId: enterprise.id });
		}
		const requiresEnterpriseApproval = enterprise?.disposition === "require_approval" || enterprise?.disposition === "constrain" && enterprise.constraints?.requireApproval === true;
		const granted = input.executionGrant?.status === "active" && input.executionGrant.allowedCapabilities.includes(input.toolName);
		if (requiresEnterpriseApproval) return decide("deny", "enterprise_approval_disabled", "Enterprise Policy requires approval, but interactive approvals are disabled", { policyDecisionId: enterprise!.id });
		if (granted) return decide("allow", "execution_grant", "An active Execution Grant covers this capability", { ...(enterprise ? { policyDecisionId: enterprise.id } : {}), executionGrantId: input.executionGrant!.id });
		if (enterprise?.disposition === "allow") return decide("allow", "enterprise_policy_allow", enterprise.reason, { policyDecisionId: enterprise.id });
		if (input.toolPolicy.risk === "high" || input.toolPolicy.sideEffect !== "none") {
			return decide("allow", "direct_execution", "The action may proceed directly under the remaining Governance controls");
		}
		return decide("allow", "low_risk_investigation", "Low-risk investigation may proceed under the current Tool policy");
	}
}

/** Presenter-safe copy derived only from Core-owned Governance reason codes. */
export function actionGovernancePresenterSummary(decision: ActionGovernanceDecision): string {
	switch (decision.reasonCode) {
		case "effect_reconciliation_required": return "A prior mutating Effect must settle or reconcile before this Tool action can proceed.";
		case "enterprise_policy_deny": return "Enterprise Policy denies this Tool action.";
		case "enterprise_policy_missing_evidence": return "Enterprise Policy evidence is incomplete, so this Tool action was blocked.";
		case "enterprise_constraint": return "This Tool action does not satisfy the active Enterprise Policy constraints.";
		case "enterprise_approval_disabled": return "Enterprise Policy requires approval, but interactive approvals are disabled.";
		default: return "Governance blocked this Tool action.";
	}
}

function constraintMismatch(constraints: EnterpriseActionConstraints | undefined, policy: ToolPolicy): string | undefined {
	if (!constraints) return "Enterprise constraints are missing";
	if (constraints.allowedSideEffects && !constraints.allowedSideEffects.includes(policy.sideEffect)) return "Action side effect is outside the Enterprise constraint";
	if (constraints.maximumRisk && riskRank(policy.risk) > riskRank(constraints.maximumRisk)) return "Action risk exceeds the Enterprise constraint";
	if (constraints.requireReversible && policy.reversible !== true) return "Action does not satisfy the Enterprise reversibility constraint";
	return undefined;
}

function riskRank(risk: ToolRisk): number { return risk === "low" ? 0 : risk === "medium" ? 1 : 2; }
function timestamp(value: number): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error("Action Governance time must be a non-negative safe integer"); return value; }
function required(value: string, field: string, max: number): string { const normalized = value?.trim(); if (!normalized || normalized.length > max) throw new Error(`Action Governance ${field} is invalid`); return normalized; }

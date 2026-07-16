import { createAccessScopeRef, type AccessScopeRef } from "./access-scope.ts";
import type { MeasuredActionReliability } from "./action-governance.ts";
import { containsCredentialMaterial } from "./credential-material.ts";
import { resolveEnterprisePolicyDecision, type EnterprisePolicyDecision } from "./enterprise-policy.ts";
import type { ToolEffectStatus } from "./tool-effect.ts";
import type { ToolPolicy } from "./tool-runtime.ts";
import type { CompensationProof } from "./reversible-action-admission.ts";

export type UnattendedAuthorityKind = "profile_standing" | "scoped_execution";
export type UnattendedAuthorityStatus = "active" | "revoked";
export type CredentialAvailabilityStatus = "available" | "missing" | "expired" | "revoked";
export type IntentResolution = "resolved" | "materially_ambiguous";
export type LegalAuthorityStatus = "not_required" | "verified" | "missing";

export interface CredentialAvailabilityRef {
	/** Opaque Credential Ref only; Credential Secrets must never enter admission state. */
	ref: string;
	status: CredentialAvailabilityStatus;
	evidenceRef: string;
	verifiedAt: number;
	expiresAt?: number;
}

export interface UnattendedAuthorityGrant {
	id: string;
	kind: UnattendedAuthorityKind;
	status: UnattendedAuthorityStatus;
	profileId: string;
	allowedCapabilities: readonly string[];
	accessScopeIds: readonly string[];
	evidenceRefs: readonly string[];
	statusRevision: number;
	statusEvidenceRef: string;
	statusCheckedAt: number;
	issuedAt: number;
	expiresAt: number;
}

export interface UnattendedEmergencyStopRef {
	status: "running" | "stopped";
	revision: number;
	evidenceRef: string;
	observedAt: number;
}

export type UnattendedEnterprisePolicy =
	| { status: "not_applicable"; evidenceRef: string; evaluatedAt: number }
	| { status: "decision"; decision: EnterprisePolicyDecision };

export interface UnattendedExecutionAdmissionInput {
	actionId: string;
	profileId: string;
	toolName: string;
	toolPolicy: ToolPolicy;
	effectStatus: ToolEffectStatus | "none";
	reliability: MeasuredActionReliability;
	intent: IntentResolution;
	legalAuthority: LegalAuthorityStatus;
	legalAuthorityEvidenceRef?: string;
	requiresAccessScope: boolean;
	accessScopeRef?: AccessScopeRef;
	credentialRequirements: readonly CredentialAvailabilityRef[];
	standingAuthority?: UnattendedAuthorityGrant;
	executionGrant?: UnattendedAuthorityGrant;
	enterprisePolicy: UnattendedEnterprisePolicy;
	emergencyStop?: UnattendedEmergencyStopRef;
	compensationProof?: CompensationProof;
	at: number;
}

export interface UnattendedExecutionAdmissionDecision {
	outcome: "allow" | "blocked";
	reasonCode: string;
	explanation: string;
	actionId: string;
	toolName: string;
	decidedAt: number;
	authorityKind?: UnattendedAuthorityKind;
	authorityId?: string;
	evidenceRefs: readonly string[];
}

/**
 * Pure zero-touch admission policy. It never executes a Tool and never grants
 * more authority than a current Profile standing authority or exact scoped
 * Execution Grant. The normal Tool, Enterprise Policy, Effect, and Governance
 * enforcement paths must still re-check the action at invocation time.
 */
export class UnattendedExecutionAdmission {
	decide(raw: UnattendedExecutionAdmissionInput): Readonly<UnattendedExecutionAdmissionDecision> {
		if (containsCredentialMaterial(JSON.stringify(raw))) throw new Error("Unattended admission cannot contain credential material");
		const input = normalizeInput(raw);
		const evidenceRefs: string[] = [];
		const blocked = (reasonCode: string, explanation: string): Readonly<UnattendedExecutionAdmissionDecision> => Object.freeze({
			outcome: "blocked", reasonCode, explanation, actionId: input.actionId, toolName: input.toolName, decidedAt: input.at,
			evidenceRefs: Object.freeze([...new Set(evidenceRefs)]),
		});
		const allowed = (grant: UnattendedAuthorityGrant, reasonCode: string, explanation: string): Readonly<UnattendedExecutionAdmissionDecision> => Object.freeze({
			outcome: "allow", reasonCode, explanation, actionId: input.actionId, toolName: input.toolName, decidedAt: input.at,
			authorityKind: grant.kind, authorityId: grant.id, evidenceRefs: Object.freeze([...new Set(evidenceRefs)]),
		});

		if (input.intent === "materially_ambiguous") return blocked("material_intent_ambiguous", "Materially ambiguous intent cannot be resolved by an unattended execution");
		if (input.legalAuthority === "missing") return blocked("legal_authority_required", "Required legal or organizational authority is unavailable");
		if (input.legalAuthority === "verified") evidenceRefs.push(input.legalAuthorityEvidenceRef!);
		if (input.toolPolicy.sideEffect !== "none") {
			if (!input.emergencyStop) return blocked("emergency_stop_evidence_required", "A current Emergency Stop snapshot is required for unattended state-changing work");
			evidenceRefs.push(input.emergencyStop.evidenceRef);
			if (input.emergencyStop.observedAt !== input.at) return blocked("emergency_stop_evidence_not_current", "Emergency Stop evidence is not current for this decision");
			if (input.emergencyStop.status === "stopped") return blocked("emergency_stop_active", "Emergency Stop denies unattended state-changing actions");
		}

		if (input.requiresAccessScope && !input.accessScopeRef) return blocked("trusted_access_scope_required", "A trusted Access Scope is required for this action");
		if (input.accessScopeRef) evidenceRefs.push(input.accessScopeRef.evidenceRef ?? `access-scope:${input.accessScopeRef.id}`);
		if (input.accessScopeRef && input.accessScopeRef.issuedAt > input.at) return blocked("access_scope_not_current", "Access Scope evidence is newer than the decision time");

		for (const credential of input.credentialRequirements) {
			evidenceRefs.push(credential.evidenceRef);
			if (credential.status === "missing") return blocked("credential_missing", `Credential Ref ${credential.ref} is unavailable`);
			if (credential.status === "revoked") return blocked("credential_revoked", `Credential Ref ${credential.ref} was revoked`);
			if (credential.status === "expired" || credential.expiresAt !== undefined && input.at >= credential.expiresAt) return blocked("credential_expired", `Credential Ref ${credential.ref} is expired`);
			if (credential.verifiedAt > input.at) return blocked("credential_evidence_not_current", `Credential Ref ${credential.ref} has invalid availability evidence`);
		}

		if (input.toolPolicy.sideEffect !== "none" && input.effectStatus !== "none" && input.effectStatus !== "failed") return blocked("effect_reconciliation_required", "A prior mutating Effect must settle or reconcile before unattended execution");
		const policyDecision = input.enterprisePolicy.status === "decision" ? input.enterprisePolicy.decision : undefined;
		const resolvedPolicy = policyDecision ? resolveEnterprisePolicyDecision(policyDecision, input.toolPolicy) : undefined;
		if (input.enterprisePolicy.status === "not_applicable") evidenceRefs.push(input.enterprisePolicy.evidenceRef);
		else evidenceRefs.push(...input.enterprisePolicy.decision.evidenceRefs);
		if (resolvedPolicy && !resolvedPolicy.allowed) return blocked(policyDecision!.disposition === "missing_evidence" ? "enterprise_policy_missing_evidence" : "enterprise_policy_denied", resolvedPolicy.reason);

		const scopedGrant = input.executionGrant;
		if (scopedGrant) {
			evidenceRefs.push(...scopedGrant.evidenceRefs, scopedGrant.statusEvidenceRef);
			const blocker = grantBlocker(scopedGrant, input);
			if (blocker) return blocked(blocker.reasonCode, blocker.explanation);
			return allowed(scopedGrant, "scoped_execution_grant", "A current exact Execution Grant authorizes this unattended action");
		}

		if (resolvedPolicy?.requiresApproval) return blocked("scoped_execution_grant_required", "Enterprise Policy requires a scoped Execution Grant");
		if (requiresScopedGrant(input)) return blocked("scoped_execution_grant_required", "This action is not eligible for standing Profile authority");
		if (!input.standingAuthority) return blocked("standing_profile_authority_required", "No standing Profile authority covers this unattended action");
		if (input.toolPolicy.sideEffect !== "none" && input.compensationProof) evidenceRefs.push(...input.compensationProof.evidenceRefs);
		evidenceRefs.push(...input.standingAuthority.evidenceRefs, input.standingAuthority.statusEvidenceRef);
		const standingBlocker = grantBlocker(input.standingAuthority, input);
		if (standingBlocker) return blocked(standingBlocker.reasonCode, standingBlocker.explanation);
		return allowed(input.standingAuthority, "standing_profile_authority", "Current standing Profile authority covers this bounded action");
	}
}

function normalizeInput(input: UnattendedExecutionAdmissionInput): UnattendedExecutionAdmissionInput {
	const at = timestamp(input.at, "decision time");
	if (input.intent !== "resolved" && input.intent !== "materially_ambiguous") throw new Error("Unattended admission intent resolution is invalid");
	if (!(["not_required", "verified", "missing"] as const).includes(input.legalAuthority)) throw new Error("Unattended admission legal authority status is invalid");
	if (input.legalAuthority === "verified" && !input.legalAuthorityEvidenceRef) throw new Error("Verified legal authority requires durable evidence");
	if (input.legalAuthorityEvidenceRef && input.legalAuthority !== "verified") throw new Error("Legal authority evidence is valid only for verified authority");
	const credentials = bounded(input.credentialRequirements, "credential requirements", 0, 100).map((item) => credentialAvailability(item, at));
	const standingAuthority = input.standingAuthority ? authorityGrant(input.standingAuthority, "profile_standing") : undefined;
	const executionGrant = input.executionGrant ? authorityGrant(input.executionGrant, "scoped_execution") : undefined;
	const emergencyStop = input.emergencyStop ? emergencyStopRef(input.emergencyStop) : undefined;
	const enterprisePolicy = enterprisePolicyApplicability(input.enterprisePolicy, at);
	const compensationProof = input.compensationProof ? compensation(input.compensationProof) : undefined;
	if (input.accessScopeRef && input.accessScopeRef.trust !== "verified") throw new Error("Unattended admission requires a trusted Access Scope");
	const accessScopeRef = input.accessScopeRef ? Object.freeze(createAccessScopeRef({ id: input.accessScopeRef.id, authority: input.accessScopeRef.authority, ...(input.accessScopeRef.evidenceRef ? { evidenceRef: input.accessScopeRef.evidenceRef } : {}), issuedAt: input.accessScopeRef.issuedAt })) : undefined;
	return {
		...input,
		actionId: reference(input.actionId, "action id"), profileId: reference(input.profileId, "Profile id"), toolName: reference(input.toolName, "Tool name"), at,
		credentialRequirements: credentials,
		...(accessScopeRef ? { accessScopeRef } : {}),
		...(input.legalAuthorityEvidenceRef ? { legalAuthorityEvidenceRef: reference(input.legalAuthorityEvidenceRef, "legal authority evidence") } : {}),
		...(standingAuthority ? { standingAuthority } : {}), ...(executionGrant ? { executionGrant } : {}),
		...(emergencyStop ? { emergencyStop } : {}),
		enterprisePolicy,
		...(compensationProof ? { compensationProof } : {}),
	};
}

function credentialAvailability(input: CredentialAvailabilityRef, at: number): CredentialAvailabilityRef {
	if (!/^cred_[a-f0-9-]{36}$/.test(input.ref)) throw new Error("Unattended admission Credential Ref is invalid");
	if (!(["available", "missing", "expired", "revoked"] as const).includes(input.status)) throw new Error("Unattended admission credential status is invalid");
	const verifiedAt = timestamp(input.verifiedAt, "credential verifiedAt");
	const expiresAt = input.expiresAt === undefined ? undefined : timestamp(input.expiresAt, "credential expiresAt");
	if (expiresAt !== undefined && expiresAt <= verifiedAt) throw new Error("Unattended admission credential expiry must follow its verification");
	if (!input.evidenceRef) throw new Error("Credential availability requires durable evidence");
	return Object.freeze({ ref: input.ref, status: input.status, evidenceRef: reference(input.evidenceRef, "credential evidence"), verifiedAt, ...(expiresAt === undefined ? {} : { expiresAt }) });
}

function emergencyStopRef(input: UnattendedEmergencyStopRef): UnattendedEmergencyStopRef {
	if (input.status !== "running" && input.status !== "stopped") throw new Error("Unattended admission Emergency Stop status is invalid");
	if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error("Unattended admission Emergency Stop revision is invalid");
	return Object.freeze({ status: input.status, revision: input.revision, evidenceRef: reference(input.evidenceRef, "Emergency Stop evidence"), observedAt: timestamp(input.observedAt, "Emergency Stop observedAt") });
}

function authorityGrant(input: UnattendedAuthorityGrant, expectedKind: UnattendedAuthorityKind): UnattendedAuthorityGrant {
	if (input.kind !== expectedKind) throw new Error(`Unattended admission requires a ${expectedKind} authority`);
	if (input.status !== "active" && input.status !== "revoked") throw new Error("Unattended admission authority status is invalid");
	const issuedAt = timestamp(input.issuedAt, "authority issuedAt");
	const expiresAt = timestamp(input.expiresAt, "authority expiresAt");
	const statusRevision = timestamp(input.statusRevision, "authority status revision");
	const statusCheckedAt = timestamp(input.statusCheckedAt, "authority status checkedAt");
	if (expiresAt <= issuedAt) throw new Error("Unattended admission authority expiry must follow issuance");
	if (statusCheckedAt < issuedAt) throw new Error("Unattended admission authority status cannot predate issuance");
	return Object.freeze({
		id: reference(input.id, "authority id"), kind: input.kind, status: input.status, profileId: reference(input.profileId, "authority Profile id"),
		allowedCapabilities: Object.freeze(uniqueReferences(input.allowedCapabilities, "authority capabilities", 1, 100)),
		accessScopeIds: Object.freeze(uniqueReferences(input.accessScopeIds, "authority Access Scopes", 0, 100)),
		evidenceRefs: Object.freeze(uniqueReferences(input.evidenceRefs, "authority evidence", 1, 100)), issuedAt, expiresAt,
		statusRevision, statusEvidenceRef: reference(input.statusEvidenceRef, "authority status evidence"), statusCheckedAt,
	});
}

function grantBlocker(grant: UnattendedAuthorityGrant, input: UnattendedExecutionAdmissionInput): { reasonCode: string; explanation: string } | undefined {
	if (grant.statusCheckedAt !== input.at) return { reasonCode: "authority_status_not_current", explanation: `Authority ${grant.id} revocation status is not current` };
	if (grant.status === "revoked") return { reasonCode: "authority_revoked", explanation: `Authority ${grant.id} was revoked` };
	if (input.at < grant.issuedAt) return { reasonCode: "authority_not_effective", explanation: `Authority ${grant.id} is not effective yet` };
	if (input.at >= grant.expiresAt) return { reasonCode: "authority_expired", explanation: `Authority ${grant.id} is expired` };
	if (grant.profileId !== input.profileId) return { reasonCode: "authority_profile_mismatch", explanation: `Authority ${grant.id} belongs to another Profile` };
	if (!grant.allowedCapabilities.includes(input.toolName)) return { reasonCode: "authority_capability_not_granted", explanation: `Authority ${grant.id} does not cover ${input.toolName}` };
	if (input.requiresAccessScope && (!input.accessScopeRef || !grant.accessScopeIds.includes(input.accessScopeRef.id))) return { reasonCode: "authority_scope_mismatch", explanation: `Authority ${grant.id} does not cover the required Access Scope` };
	return undefined;
}

function requiresScopedGrant(input: UnattendedExecutionAdmissionInput): boolean {
	const { toolPolicy: policy, reliability } = input;
	if (policy.approval === "always" || policy.risk !== "low") return true;
	if (policy.sideEffect !== "none" && (policy.reversible !== true || !currentCompensationProof(input.compensationProof, policy, input.at))) return true;
	if (policy.sideEffect !== "none" && reliability !== "reliable") return true;
	return false;
}

function enterprisePolicyApplicability(input: UnattendedEnterprisePolicy | undefined, at: number): UnattendedEnterprisePolicy {
	if (!input) throw new Error("Unattended admission requires an Enterprise Policy applicability decision");
	if (input.status === "not_applicable") {
		const evaluatedAt = timestamp(input.evaluatedAt, "Enterprise Policy applicability time");
		if (evaluatedAt !== at) throw new Error("Unattended admission Enterprise Policy applicability is not current");
		return Object.freeze({ status: "not_applicable", evidenceRef: reference(input.evidenceRef, "Enterprise Policy applicability evidence"), evaluatedAt });
	}
	if (input.status !== "decision" || !input.decision) throw new Error("Unattended admission Enterprise Policy applicability is invalid");
	if (input.decision.evaluatedAt !== at) throw new Error("Unattended admission Enterprise Policy decision is not current");
	return Object.freeze({ status: "decision", decision: input.decision });
}

function compensation(input: CompensationProof): CompensationProof {
	const exercisedAt = timestamp(input.exercisedAt, "Compensation exercisedAt");
	const validUntil = timestamp(input.validUntil, "Compensation validUntil");
	if (validUntil <= exercisedAt) throw new Error("Unattended admission Compensation validity must follow its exercise");
	return Object.freeze({ id: reference(input.id, "Compensation id"), capability: reference(input.capability, "Compensation capability"), ...(input.receiptProofProvider ? { receiptProofProvider: reference(input.receiptProofProvider, "Compensation receipt proof Provider") } : {}), exercisedAt, validUntil, evidenceRefs: Object.freeze(uniqueReferences(input.evidenceRefs, "Compensation evidence", 1, 100)) as unknown as string[] });
}

function currentCompensationProof(proof: CompensationProof | undefined, policy: ToolPolicy, at: number): boolean {
	if (!proof || proof.exercisedAt > at || proof.validUntil < at || !proof.evidenceRefs.length) return false;
	return policy.sideEffect !== "external" || Boolean(policy.effectProofProvider && proof.receiptProofProvider === policy.effectProofProvider);
}

function bounded<T>(value: readonly T[], label: string, minimum: number, maximum: number): readonly T[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`Unattended admission ${label} must contain between ${minimum} and ${maximum} items`);
	return value;
}

function uniqueReferences(value: readonly string[], label: string, minimum: number, maximum: number): string[] {
	const output = bounded(value, label, minimum, maximum).map((item) => reference(item, label));
	if (new Set(output).size !== output.length) throw new Error(`Unattended admission ${label} must not contain duplicates`);
	return output;
}

function reference(value: string, label: string): string {
	const normalized = value?.trim();
	if (!normalized || normalized.length > 1_000 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(`Unattended admission ${label} is invalid`);
	return normalized;
}

function timestamp(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Unattended admission ${label} is invalid`);
	return value;
}

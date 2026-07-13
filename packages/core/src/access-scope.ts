export type TrustedAccessAuthorityKind =
	| "runtime_identity"
	| "membership_registry"
	| "enterprise_system"
	| "administrator_grant";

export interface TrustedAccessAuthority {
	kind: TrustedAccessAuthorityKind;
	reference: string;
}

/** Opaque proof that a trusted authority established an execution or data-access scope. */
export interface AccessScopeRef {
	id: string;
	trust: "verified";
	authority: TrustedAccessAuthority;
	evidenceRef?: string;
	issuedAt: number;
}

export interface AccessScopeRefInput {
	id: string;
	authority: TrustedAccessAuthority;
	evidenceRef?: string;
	issuedAt: number;
}

const TRUSTED_AUTHORITIES = new Set<TrustedAccessAuthorityKind>([
	"runtime_identity",
	"membership_registry",
	"enterprise_system",
	"administrator_grant",
]);

/**
 * Establishes an Access Scope reference only from a trusted authority adapter.
 * Situation inference, model output, and user text cannot use this constructor
 * to mint authorization facts.
 */
export function createAccessScopeRef(input: AccessScopeRefInput): AccessScopeRef {
	if (!TRUSTED_AUTHORITIES.has(input.authority?.kind)) throw new Error("Access Scope authority must be trusted");
	const id = requiredText(input.id, "Access Scope id", 500);
	const reference = requiredText(input.authority.reference, "Access Scope authority reference", 1_000);
	const evidenceRef = optionalText(input.evidenceRef, "Access Scope evidence reference", 1_000);
	if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) throw new Error("Access Scope issuedAt must be a non-negative safe integer");
	return {
		id,
		trust: "verified",
		authority: { kind: input.authority.kind, reference },
		...(evidenceRef ? { evidenceRef } : {}),
		issuedAt: input.issuedAt,
	};
}

function requiredText(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`${label} must be between 1 and ${maxLength} characters`);
	return value.trim();
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
	if (value === undefined) return undefined;
	return requiredText(value, label, maxLength);
}

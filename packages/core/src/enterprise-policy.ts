import type { AgentScope } from "./agent-scope.ts";
import type { AccessScopeRef, TrustedAccessAuthority } from "./access-scope.ts";
import type { ToolPolicy, ToolRisk, ToolSideEffect } from "./tool-runtime.ts";

const PROVIDER_BRAND: unique symbol = Symbol("BeeMaxEnterprisePolicyProvider");
const TRUSTED_PUBLISHER_AUTHORITIES = new Set(["enterprise_system", "administrator_grant"]);
const DISPOSITIONS = new Set<EnterprisePolicyDisposition>(["allow", "deny", "require_approval", "constrain", "missing_evidence"]);

export type EnterprisePolicyDisposition = "allow" | "deny" | "require_approval" | "constrain" | "missing_evidence";

export interface EnterprisePolicyPublisher {
	id: string;
	trust: "verified";
	authority: TrustedAccessAuthority;
	evidenceRef?: string;
	issuedAt: number;
}

export type EnterprisePolicyEffectiveScope =
	| { kind: "global"; id: string }
	| { kind: "access_scope"; id: string; accessScopeId: string };

export interface EnterpriseActionConstraints {
	requireApproval?: boolean;
	allowedSideEffects?: readonly ToolSideEffect[];
	maximumRisk?: ToolRisk;
	requireReversible?: boolean;
}

export interface EnterprisePolicyDirective {
	id: string;
	disposition: EnterprisePolicyDisposition;
	reason: string;
	evidenceRefs: readonly string[];
	constraints?: EnterpriseActionConstraints;
}

export interface EnterprisePolicyDecision extends EnterprisePolicyDirective {
	publisher: EnterprisePolicyPublisher;
	version: string;
	effectiveScope: EnterprisePolicyEffectiveScope;
	effectiveFrom: number;
	effectiveUntil?: number;
	evaluatedAt: number;
}

export interface EnterprisePolicyInput {
	source: AgentScope;
	toolName: string;
	args: unknown;
	toolPolicy: ToolPolicy;
	accessScopeRef?: AccessScopeRef;
	at: number;
}

export interface EnterprisePolicyProvider {
	readonly [PROVIDER_BRAND]: true;
	readonly publisher: EnterprisePolicyPublisher;
	readonly version: string;
	readonly effectiveScope: EnterprisePolicyEffectiveScope;
	readonly effectiveFrom: number;
	readonly effectiveUntil?: number;
	decide(input: EnterprisePolicyInput): Promise<EnterprisePolicyDirective | undefined>;
}

export function createEnterprisePolicyPublisher(input: Omit<EnterprisePolicyPublisher, "trust">): EnterprisePolicyPublisher {
	if (!TRUSTED_PUBLISHER_AUTHORITIES.has(input.authority?.kind)) throw new Error("Enterprise Policy publisher must come from a trusted enterprise authority");
	const issuedAt = timestamp(input.issuedAt, "publisher issuedAt");
	return Object.freeze({
		id: text(input.id, "publisher id", 256), trust: "verified" as const,
		authority: Object.freeze({ kind: input.authority.kind, reference: text(input.authority.reference, "publisher authority reference", 1_000) }),
		...(input.evidenceRef ? { evidenceRef: text(input.evidenceRef, "publisher evidence reference", 1_000) } : {}), issuedAt,
	});
}

export function createEnterprisePolicyProvider(input: {
	publisher: EnterprisePolicyPublisher;
	version: string;
	effectiveScope: EnterprisePolicyEffectiveScope;
	effectiveFrom: number;
	effectiveUntil?: number;
	decide: EnterprisePolicyProvider["decide"];
}): EnterprisePolicyProvider {
	const publisher = createEnterprisePolicyPublisher({ id: input.publisher.id, authority: input.publisher.authority, ...(input.publisher.evidenceRef ? { evidenceRef: input.publisher.evidenceRef } : {}), issuedAt: input.publisher.issuedAt });
	const effectiveFrom = timestamp(input.effectiveFrom, "effectiveFrom");
	const effectiveUntil = input.effectiveUntil === undefined ? undefined : timestamp(input.effectiveUntil, "effectiveUntil");
	if (effectiveUntil !== undefined && effectiveUntil <= effectiveFrom) throw new Error("Enterprise Policy effectiveUntil must be after effectiveFrom");
	if (typeof input.decide !== "function") throw new Error("Enterprise Policy provider requires a decision function");
	const effectiveScope = policyScope(input.effectiveScope);
	return Object.freeze({
		[PROVIDER_BRAND]: true as const, publisher, version: text(input.version, "version", 256), effectiveScope, effectiveFrom,
		...(effectiveUntil === undefined ? {} : { effectiveUntil }), decide: input.decide,
	});
}

export class EnterprisePolicyRuntime {
	private readonly provider?: EnterprisePolicyProvider;
	constructor(provider?: EnterprisePolicyProvider) {
		if (provider && provider[PROVIDER_BRAND] !== true) throw new Error("Enterprise Policy provider must be created by the trusted Composition Root factory");
		this.provider = provider;
	}

	async evaluate(input: EnterprisePolicyInput): Promise<EnterprisePolicyDecision | undefined> {
		const provider = this.provider;
		if (!provider || !policyApplies(provider, input)) return undefined;
		const directive = await provider.decide({ ...input, toolPolicy: { ...input.toolPolicy } });
		if (!directive) return undefined;
		const normalized = policyDirective(directive);
		return Object.freeze({
			...normalized, publisher: provider.publisher, version: provider.version, effectiveScope: provider.effectiveScope,
			effectiveFrom: provider.effectiveFrom, ...(provider.effectiveUntil === undefined ? {} : { effectiveUntil: provider.effectiveUntil }), evaluatedAt: timestamp(input.at, "evaluatedAt"),
		});
	}
}

export function resolveEnterprisePolicyDecision(decision: EnterprisePolicyDecision, policy: ToolPolicy): { allowed: boolean; requiresApproval: boolean; reason: string } {
	if (decision.disposition === "deny" || decision.disposition === "missing_evidence") return { allowed: false, requiresApproval: false, reason: decision.reason };
	if (decision.disposition === "require_approval") return { allowed: true, requiresApproval: true, reason: decision.reason };
	if (decision.disposition === "allow") return { allowed: true, requiresApproval: false, reason: decision.reason };
	const constraints = decision.constraints!;
	if (constraints.allowedSideEffects && !constraints.allowedSideEffects.includes(policy.sideEffect)) return { allowed: false, requiresApproval: false, reason: decision.reason };
	if (constraints.maximumRisk && riskRank(policy.risk) > riskRank(constraints.maximumRisk)) return { allowed: false, requiresApproval: false, reason: decision.reason };
	if (constraints.requireReversible && policy.reversible !== true) return { allowed: false, requiresApproval: false, reason: decision.reason };
	return { allowed: true, requiresApproval: constraints.requireApproval === true, reason: decision.reason };
}

function policyApplies(provider: EnterprisePolicyProvider, input: EnterprisePolicyInput): boolean {
	if (!Number.isSafeInteger(input.at) || input.at < provider.effectiveFrom || (provider.effectiveUntil !== undefined && input.at > provider.effectiveUntil)) return false;
	return provider.effectiveScope.kind === "global" || input.accessScopeRef?.trust === "verified" && input.accessScopeRef.id === provider.effectiveScope.accessScopeId;
}

function policyDirective(input: EnterprisePolicyDirective): EnterprisePolicyDirective {
	if (!DISPOSITIONS.has(input.disposition)) throw new Error("Enterprise Policy disposition is invalid");
	const evidenceRefs = [...new Set(input.evidenceRefs.map((value) => text(value, "evidence reference", 1_000)))];
	if (!evidenceRefs.length || evidenceRefs.length > 20) throw new Error("Enterprise Policy decision requires between 1 and 20 audit evidence references");
	const constraints = input.constraints ? actionConstraints(input.constraints) : undefined;
	if (input.disposition === "constrain" && !constraints) throw new Error("Constrain decisions require enforceable action constraints");
	if (input.disposition !== "constrain" && constraints) throw new Error("Action constraints are valid only for constrain decisions");
	return Object.freeze({ id: text(input.id, "decision id", 256), disposition: input.disposition, reason: text(input.reason, "decision reason", 1_000), evidenceRefs: Object.freeze(evidenceRefs), ...(constraints ? { constraints } : {}) });
}

function actionConstraints(input: EnterpriseActionConstraints): EnterpriseActionConstraints | undefined {
	const allowedSideEffects = input.allowedSideEffects ? [...new Set(input.allowedSideEffects)] : undefined;
	if (allowedSideEffects?.some((value) => value !== "none" && value !== "local" && value !== "external")) throw new Error("Enterprise Policy side-effect constraint is invalid");
	if (input.maximumRisk !== undefined && !["low", "medium", "high"].includes(input.maximumRisk)) throw new Error("Enterprise Policy risk constraint is invalid");
	const output = {
		...(input.requireApproval === undefined ? {} : { requireApproval: input.requireApproval === true }),
		...(allowedSideEffects?.length ? { allowedSideEffects: Object.freeze(allowedSideEffects) } : {}),
		...(input.maximumRisk ? { maximumRisk: input.maximumRisk } : {}),
		...(input.requireReversible === undefined ? {} : { requireReversible: input.requireReversible === true }),
	};
	return Object.keys(output).length ? Object.freeze(output) : undefined;
}

function policyScope(input: EnterprisePolicyEffectiveScope): EnterprisePolicyEffectiveScope {
	const id = text(input.id, "effective scope id", 256);
	if (input.kind === "global") return Object.freeze({ kind: "global", id });
	if (input.kind === "access_scope") return Object.freeze({ kind: "access_scope", id, accessScopeId: text(input.accessScopeId, "Access Scope id", 500) });
	throw new Error("Enterprise Policy effective scope is invalid");
}

function riskRank(risk: ToolRisk): number { return risk === "low" ? 0 : risk === "medium" ? 1 : 2; }
function timestamp(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Enterprise Policy ${label} must be a non-negative safe integer`); return value; }
function text(value: unknown, label: string, maxLength: number): string { if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`Enterprise Policy ${label} must be between 1 and ${maxLength} characters`); return value.trim(); }

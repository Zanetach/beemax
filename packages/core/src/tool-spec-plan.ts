import { createHash } from "node:crypto";
import type { CapabilityEffectStatus, CapabilityKind } from "./capability-runtime.ts";
import type { CapabilityProviderHealthStatus } from "./capability-provider.ts";
import type { ToolSideEffect } from "./tool-runtime.ts";

export const TOOL_SPEC_PLAN_SCHEMA_VERSION = "beemax.tool-spec-plan.v1" as const;
const MAX_INVENTORY = 500;
const MAX_DIRECT_TOOLS = 20;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_TOTAL_SCHEMA_BYTES = 512 * 1024;

export type ToolSpecHiddenReason = "policy_or_scope_denied" | "configuration_required" | "provider_unhealthy" | "provider_unavailable" | "operationally_suppressed" | "unresolved_uncertainty" | "effect_reconciliation_required";

export interface ToolSpecInventoryItem {
	kind: CapabilityKind;
	name: string;
	version: string;
	description?: string;
	inputSchema: unknown;
	sideEffect: ToolSideEffect;
	configured: boolean;
	health: CapabilityProviderHealthStatus;
	authorized: boolean;
	operationalApplicability?: "eligible" | "cautious" | "suppressed";
	effectStatus?: CapabilityEffectStatus;
}

export interface ToolSpecPlanInput {
	profileId: string;
	platform: string;
	workContract: { capabilityRequirements: readonly string[]; uncertainties: readonly string[] };
	selectedToolNames: readonly string[];
	activeSkillToolNames: readonly string[];
	tools: readonly ToolSpecInventoryItem[];
}

export interface ToolSpecEntry {
	id: string;
	toolName: string;
	kind: CapabilityKind;
	version: string;
	description?: string;
	inputSchema?: unknown;
	schemaDigest: string;
	sideEffect: ToolSideEffect;
}

export interface HiddenToolSpecEntry {
	id: string;
	toolName: string;
	kind: CapabilityKind;
	version: string;
	reason: ToolSpecHiddenReason;
	requested: boolean;
}

export interface ToolSpecPlan {
	schemaVersion: typeof TOOL_SPEC_PLAN_SCHEMA_VERSION;
	planId: string;
	profileId: string;
	platform: string;
	capabilityRequirements: readonly string[];
	direct: readonly ToolSpecEntry[];
	deferred: readonly ToolSpecEntry[];
	hidden: readonly HiddenToolSpecEntry[];
}

/** Compiles bounded runtime facts into the sole turn-scoped Pi Tool inventory. */
export function buildToolSpecPlan(input: ToolSpecPlanInput): ToolSpecPlan {
	const profileId = required(input.profileId, "Tool Spec Profile", 256);
	const platform = required(input.platform, "Tool Spec platform", 128);
	if (!Array.isArray(input.tools) || input.tools.length > MAX_INVENTORY) throw new Error(`Tool Spec inventory must contain at most ${MAX_INVENTORY} Tools`);
	const selectedOrder = uniqueNames([...input.selectedToolNames, ...input.activeSkillToolNames]);
	const selected = new Set(selectedOrder);
	const schemaBudget = { remaining: MAX_TOTAL_SCHEMA_BYTES };
	const tools = input.tools.map((tool) => normalizeInventoryItem(tool, selected.has(toolName(tool.name)), schemaBudget));
	if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("Tool Spec inventory contains duplicate immutable Tool names");
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	for (const name of selected) if (!byName.has(name)) throw new Error(`Selected Tool ${name} is not present in the Tool Spec inventory`);
	const uncertainties = textList(input.workContract.uncertainties, "Work Contract uncertainty", 10_000);
	const eligible: ToolSpecEntry[] = [];
	const hidden: HiddenToolSpecEntry[] = [];
	for (const tool of tools) {
		const reason = hiddenReason(tool, uncertainties.length > 0);
		if (reason) hidden.push(hiddenEntry(tool, reason, selected.has(tool.name)));
		else eligible.push(publicEntry(tool));
	}
	const rank = new Map(selectedOrder.map((name, index) => [name, index]));
	eligible.sort((left, right) => (rank.get(left.toolName) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.toolName) ?? Number.MAX_SAFE_INTEGER) || left.toolName.localeCompare(right.toolName));
	const direct = eligible.filter((entry) => selected.has(entry.toolName)).slice(0, MAX_DIRECT_TOOLS);
	const directNames = new Set(direct.map((entry) => entry.toolName));
	const deferred = eligible.filter((entry) => !directNames.has(entry.toolName)).sort((left, right) => left.toolName.localeCompare(right.toolName));
	hidden.sort((left, right) => left.toolName.localeCompare(right.toolName));
	const capabilityRequirements = textList(input.workContract.capabilityRequirements, "Work Contract Capability requirement", 10_000);
	return freezePlan({
		schemaVersion: TOOL_SPEC_PLAN_SCHEMA_VERSION,
		planId: planIdentity({ profileId, platform, capabilityRequirements, direct: identityEntries(direct), deferred: identityEntries(deferred), hidden }),
		profileId,
		platform,
		capabilityRequirements,
		direct,
		deferred,
		hidden,
	});
}

/** Promotes only previously eligible deferred Tools; hidden and invented identifiers fail closed. */
export function activateToolSpecPlan(plan: ToolSpecPlan, toolNames: readonly string[]): ToolSpecPlan {
	const requested = uniqueNames(toolNames);
	const direct = [...plan.direct];
	const deferred = [...plan.deferred];
	const hiddenNames = new Set(plan.hidden.map((entry) => entry.toolName));
	const promoted: ToolSpecEntry[] = [];
	for (const name of requested) {
		const existing = direct.find((entry) => entry.toolName === name);
		if (existing) { promoted.push(existing); continue; }
		if (hiddenNames.has(name)) throw new Error(`Tool ${name} is hidden by the current Tool Spec Plan`);
		const index = deferred.findIndex((entry) => entry.toolName === name);
		if (index < 0) throw new Error(`Tool ${name} is not present in the current Tool Spec Plan`);
		promoted.push(deferred.splice(index, 1)[0]!);
	}
	const promotedNames = new Set(promoted.map((entry) => entry.toolName));
	const retained = direct.filter((entry) => !promotedNames.has(entry.toolName));
	const combined = [...retained, ...promoted];
	const nextDirect = (combined.length <= MAX_DIRECT_TOOLS ? combined : [...promoted, ...retained]).slice(0, MAX_DIRECT_TOOLS);
	const nextDirectNames = new Set(nextDirect.map((entry) => entry.toolName));
	const nextDeferred = [...new Map([...deferred, ...promoted, ...direct].filter((entry) => !nextDirectNames.has(entry.toolName)).map((entry) => [entry.toolName, entry])).values()].sort((left, right) => left.toolName.localeCompare(right.toolName));
	return freezePlan({ ...plan, planId: planIdentity({ prior: plan.planId, activated: requested, direct: identityEntries(nextDirect), deferred: identityEntries(nextDeferred), hidden: plan.hidden }), direct: nextDirect, deferred: nextDeferred });
}

/** Removes turn-local meta Tools from direct exposure without losing their registry identity. */
export function deferToolSpecPlan(plan: ToolSpecPlan, toolNames: readonly string[]): ToolSpecPlan {
	const requested = new Set(uniqueNames(toolNames));
	const moved = plan.direct.filter((entry) => requested.has(entry.toolName));
	if (!moved.length) return plan;
	const direct = plan.direct.filter((entry) => !requested.has(entry.toolName));
	const deferred = [...plan.deferred, ...moved].sort((left, right) => left.toolName.localeCompare(right.toolName));
	return freezePlan({ ...plan, planId: planIdentity({ prior: plan.planId, deferredByPolicy: [...requested], direct: identityEntries(direct), deferred: identityEntries(deferred), hidden: plan.hidden }), direct, deferred });
}

/** Applies trusted dynamic availability results before a Tool can be promoted. */
export function hideToolSpecPlan(plan: ToolSpecPlan, restrictions: readonly { toolName: string; reason: Extract<ToolSpecHiddenReason, "configuration_required" | "provider_unhealthy" | "provider_unavailable"> }[]): ToolSpecPlan {
	const byName = new Map(restrictions.map((item) => [toolName(item.toolName), item.reason]));
	if (!byName.size) return plan;
	const eligible = [...plan.direct, ...plan.deferred];
	for (const name of byName.keys()) if (!eligible.some((entry) => entry.toolName === name) && !plan.hidden.some((entry) => entry.toolName === name)) throw new Error(`Tool ${name} is not present in the current Tool Spec Plan`);
	const hidden = [...plan.hidden];
	for (const entry of eligible) {
		const reason = byName.get(entry.toolName);
		if (reason) hidden.push(Object.freeze({ id: entry.id, toolName: entry.toolName, kind: entry.kind, version: entry.version, reason, requested: true }));
	}
	hidden.sort((left, right) => left.toolName.localeCompare(right.toolName));
	const direct = plan.direct.filter((entry) => !byName.has(entry.toolName));
	const deferred = plan.deferred.filter((entry) => !byName.has(entry.toolName));
	return freezePlan({ ...plan, planId: planIdentity({ prior: plan.planId, restrictions: [...byName], direct: identityEntries(direct), deferred: identityEntries(deferred), hidden }), direct, deferred, hidden });
}

/** Re-admits only exact Provider-blocked Tools after trusted acquisition and health evidence. */
export function restoreProviderToolSpecPlan(plan: ToolSpecPlan, recoveredTools: readonly ToolSpecInventoryItem[]): ToolSpecPlan {
	if (!recoveredTools.length) return plan;
	const schemaBudget = { remaining: MAX_TOTAL_SCHEMA_BYTES };
	const recovered = recoveredTools.map((tool) => normalizeInventoryItem(tool, true, schemaBudget));
	if (new Set(recovered.map((tool) => tool.name)).size !== recovered.length) throw new Error("Recovered Provider Tools contain duplicate names");
	const providerReasons = new Set<ToolSpecHiddenReason>(["configuration_required", "provider_unhealthy", "provider_unavailable"]);
	for (const tool of recovered) {
		const hidden = plan.hidden.find((entry) => entry.toolName === tool.name);
		if (!hidden || !providerReasons.has(hidden.reason)) throw new Error(`Tool ${tool.name} is not hidden by Provider availability`);
		if (hidden.id !== `${tool.kind}:${tool.name}@${tool.version}`) throw new Error(`Recovered Tool ${tool.name} changed immutable identity`);
		if (hiddenReason(tool, false)) throw new Error(`Recovered Tool ${tool.name} is not healthy and authorized`);
	}
	const recoveredNames = new Set(recovered.map((tool) => tool.name));
	const restoredEntries = recovered.map(publicEntry);
	const hidden = plan.hidden.filter((entry) => !recoveredNames.has(entry.toolName));
	const deferred = [...plan.deferred, ...restoredEntries].sort((left, right) => left.toolName.localeCompare(right.toolName));
	const restored = freezePlan({ ...plan, planId: planIdentity({ prior: plan.planId, providerRecovered: identityEntries(restoredEntries), direct: identityEntries(plan.direct), deferred: identityEntries(deferred), hidden }), deferred, hidden });
	return activateToolSpecPlan(restored, recovered.map((tool) => tool.name));
}

/** Renders bounded plan metadata; Pi carries each direct Tool's native schema on the same sampling request. */
export function renderToolSpecPlan(plan: ToolSpecPlan): string {
	const modelView = {
		schemaVersion: plan.schemaVersion,
		planId: plan.planId,
		profileId: plan.profileId,
		platform: plan.platform,
		direct: plan.direct.map(({ id, toolName, kind, version, schemaDigest, sideEffect }) => ({ id, toolName, kind, version, schemaDigest, sideEffect })),
		blockedSelected: plan.hidden.filter((entry) => entry.requested).map(({ id, toolName, reason }) => ({ id, toolName, reason })),
		deferredCount: plan.deferred.length,
		hiddenCount: plan.hidden.length,
	};
	return `<beemax-tool-spec-plan>\n${JSON.stringify(modelView).replaceAll("<", "\\u003c")}\n</beemax-tool-spec-plan>`;
}

type NormalizedInventoryItem = Omit<ToolSpecInventoryItem, "inputSchema"> & { inputSchema?: unknown; schemaDigest: string };
function normalizeInventoryItem(input: ToolSpecInventoryItem, retainSchema: boolean, budget: { remaining: number }): NormalizedInventoryItem {
	if (!input || typeof input !== "object") throw new Error("Tool Spec inventory item is invalid");
	if (input.kind !== "tool" && input.kind !== "mcp" && input.kind !== "skill") throw new Error("Tool Spec Capability kind is invalid");
	if (input.sideEffect !== "none" && input.sideEffect !== "local" && input.sideEffect !== "external") throw new Error("Tool Spec side effect is invalid");
	if (!HEALTH_STATUSES.has(input.health)) throw new Error("Tool Spec Provider health is invalid");
	if (typeof input.configured !== "boolean" || typeof input.authorized !== "boolean") throw new Error("Tool Spec availability facts are invalid");
	if (input.operationalApplicability !== undefined && input.operationalApplicability !== "eligible" && input.operationalApplicability !== "cautious" && input.operationalApplicability !== "suppressed") throw new Error("Tool Spec operational applicability is invalid");
	const normalizedSchema = jsonValue(input.inputSchema, "Tool Spec input schema", retainSchema ? budget.remaining : 0);
	if (normalizedSchema.inputSchema !== undefined) budget.remaining -= normalizedSchema.bytes;
	return Object.freeze({
		kind: input.kind,
		name: toolName(input.name),
		version: required(input.version, "Tool Spec version", 256),
		...(input.description ? { description: required(input.description, "Tool Spec description", 2_000) } : {}),
		...(normalizedSchema.inputSchema === undefined ? {} : { inputSchema: normalizedSchema.inputSchema }),
		schemaDigest: normalizedSchema.schemaDigest,
		sideEffect: input.sideEffect,
		configured: input.configured,
		health: input.health,
		authorized: input.authorized,
		...(input.operationalApplicability ? { operationalApplicability: input.operationalApplicability } : {}),
		...(input.effectStatus ? { effectStatus: input.effectStatus } : {}),
	});
}

function hiddenReason(tool: NormalizedInventoryItem, unresolvedUncertainty: boolean): ToolSpecHiddenReason | undefined {
	if (!tool.authorized) return "policy_or_scope_denied";
	if (tool.operationalApplicability === "suppressed") return "operationally_suppressed";
	if (!tool.configured || tool.health === "configuration_required") return "configuration_required";
	if (tool.health === "unhealthy") return "provider_unhealthy";
	if (tool.health === "unavailable") return "provider_unavailable";
	if (unresolvedUncertainty && tool.sideEffect !== "none") return "unresolved_uncertainty";
	if (tool.sideEffect !== "none" && tool.effectStatus && !["none", "failed"].includes(tool.effectStatus)) return "effect_reconciliation_required";
	return undefined;
}

function publicEntry(tool: NormalizedInventoryItem): ToolSpecEntry {
	return deepFreeze({ id: `${tool.kind}:${tool.name}@${tool.version}`, toolName: tool.name, kind: tool.kind, version: tool.version, ...(tool.description ? { description: tool.description } : {}), ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }), schemaDigest: tool.schemaDigest, sideEffect: tool.sideEffect });
}
function hiddenEntry(tool: NormalizedInventoryItem, reason: ToolSpecHiddenReason, requested: boolean): HiddenToolSpecEntry {
	return Object.freeze({ id: `${tool.kind}:${tool.name}@${tool.version}`, toolName: tool.name, kind: tool.kind, version: tool.version, reason, requested });
}
function freezePlan(plan: ToolSpecPlan): ToolSpecPlan {
	return Object.freeze({ ...plan, capabilityRequirements: Object.freeze([...plan.capabilityRequirements]), direct: Object.freeze([...plan.direct]), deferred: Object.freeze([...plan.deferred]), hidden: Object.freeze([...plan.hidden]) });
}
function planIdentity(value: unknown): string { return `tool-plan:sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`; }
function identityEntries(entries: readonly ToolSpecEntry[]): unknown[] { return entries.map(({ id, toolName, kind, version, schemaDigest, sideEffect }) => ({ id, toolName, kind, version, schemaDigest, sideEffect })); }
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
const HEALTH_STATUSES = new Set<CapabilityProviderHealthStatus>(["ready", "unverified", "configuration_required", "unhealthy", "unavailable"]);
function toolName(value: string): string {
	const name = required(value, "Tool Spec Tool name", 128);
	if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(name)) throw new Error("Tool Spec Tool name is invalid");
	return name;
}
function uniqueNames(values: readonly string[]): string[] { return [...new Set(values.map(toolName))]; }
function textList(values: readonly string[], label: string, maxLength: number): readonly string[] {
	if (!Array.isArray(values) || values.length > 100) throw new Error(`${label} list is invalid`);
	return Object.freeze([...new Set(values.map((value) => required(value, label, maxLength)))]);
}
function jsonValue(value: unknown, label: string, retainBudget: number): { inputSchema?: unknown; schemaDigest: string; bytes: number } {
	let serialized: string;
	try { serialized = JSON.stringify(value); } catch { throw new Error(`${label} must be JSON serializable`); }
	const bytes = serialized === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(serialized);
	if (serialized === undefined || bytes > MAX_SCHEMA_BYTES) throw new Error(`${label} exceeds ${MAX_SCHEMA_BYTES} bytes`);
	const schemaDigest = `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
	return bytes <= retainBudget ? { inputSchema: deepFreeze(JSON.parse(serialized)), schemaDigest, bytes } : { schemaDigest, bytes };
}
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); Object.freeze(value); }
	return value;
}
function required(value: string, label: string, maxLength: number): string {
	const normalized = value?.trim();
	if (!normalized || normalized.length > maxLength) throw new Error(`${label} must be between 1 and ${maxLength} characters`);
	return normalized;
}

import type { CapabilityOperationalSignals } from "./capability-runtime.ts";
import type { TaskVerificationRequirement } from "./task-ledger.ts";

export interface TaskVerificationCapability {
	name: string;
	signals?: CapabilityOperationalSignals;
}

/** Compiles selected Capability metadata into bounded, domain-neutral Verification requirements. */
export function deriveTaskVerificationRequirements(selectedCapabilityNames: readonly string[], inventory: readonly TaskVerificationCapability[]): TaskVerificationRequirement[] {
	const selected = new Set(selectedCapabilityNames);
	const byName = new Map(inventory.map((item) => [item.name, item]));
	const requirements: TaskVerificationRequirement[] = [];
	for (const capability of selected) {
		const signals = byName.get(capability)?.signals;
		if (!signals) continue;
		const freshness = knownFreshness(signals.freshness);
		const evidence = knownEvidence(signals.evidence);
		if (!freshness && !evidence) continue;
		requirements.push({ capability: capability.slice(0, 128), ...(freshness ? { freshness } : {}), ...(evidence ? { evidence } : {}) });
		if (requirements.length >= 50) break;
	}
	return requirements;
}

export function mergeTaskVerificationRequirements(current: readonly TaskVerificationRequirement[], incoming: readonly TaskVerificationRequirement[]): TaskVerificationRequirement[] {
	const byCapability = new Map(current.map((item) => [item.capability, item]));
	for (const item of incoming) byCapability.set(item.capability, item);
	return [...byCapability.values()].slice(0, 50);
}

export function taskRequiresCurrentSourceEvidence(requirements: readonly TaskVerificationRequirement[] | undefined): boolean {
	return Boolean(requirements?.some((item) => (item.freshness === "current" || item.freshness === "realtime") && (item.evidence === "source_receipt" || item.evidence === "verified")));
}

function knownFreshness(value: CapabilityOperationalSignals["freshness"]): TaskVerificationRequirement["freshness"] {
	return value === "static" || value === "periodic" || value === "current" || value === "realtime" ? value : undefined;
}

function knownEvidence(value: CapabilityOperationalSignals["evidence"]): TaskVerificationRequirement["evidence"] {
	return value === "none" || value === "self_reported" || value === "source_receipt" || value === "verified" ? value : undefined;
}

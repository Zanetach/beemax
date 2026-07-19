import { createEnterprisePolicyPublisher, type EnterprisePolicyPublisher } from "./enterprise-policy.ts";
import type { VerifiedObjectiveMemoryPublisher } from "./objective-runtime.ts";

export const AUTONOMY_LEVELS = [
	"situation_context",
	"episode_publication",
	"adaptive_learning",
	"initiative_observation",
	"read_only_investigation",
	"reversible_action",
] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export type AutonomyRolloutStatus = "disabled" | "enabled" | "stopped";

export interface AutonomyRolloutEvidence {
	situationPrecision: number;
	correctionRetention: number;
	unauthorizedRetrievals: number;
	verifiedCompletionRate: number;
	memoryPromotionPrecision: number;
	scopedRecallAt5: number;
	memoryAttributionAccuracy: number;
	memoryDowngradePrecision: number;
	memoryFalseDowngradeRate: number;
	memoryNegativeTransferRate: number;
	memoryProvenanceCoverage: number;
	initiativePrecision: number;
	initiativeAverageExpectedValue: number;
	duplicateInitiatives: number;
	initiativeInterruptionRate: number;
	readOnlyPrecision: number;
	readOnlyAdoptionRate: number;
	readOnlyInterruptionRate: number;
	duplicateReadOnlyObjectives: number;
	proactivePolicyScopeCoverage: number;
	emergencyStopBlockRate: number;
	compensationSuccessRate: number;
	duplicateCompensations: number;
	highRiskAutonomousActions: number;
	irreversibleAutonomousActions: number;
}

export type AutonomyRolloutAuthority =
	| { actor: "operator"; evidenceRef: string }
	| { actor: "enterprise"; evidenceRef: string; publisher: EnterprisePolicyPublisher; enterpriseDisposition?: "allow" | "deny" };

export interface AutonomyEnterpriseOverride {
	enterpriseDisposition: "allow" | "deny";
	evidenceRef: string;
	publisher: EnterprisePolicyPublisher;
}

export interface AutonomyRolloutRecord {
	level: AutonomyLevel;
	status: AutonomyRolloutStatus;
	revision: number;
	updatedAt: number;
	authority: AutonomyRolloutAuthority;
	reasons: string[];
	evidence?: AutonomyRolloutEvidence;
}

export interface AutonomyRolloutStateStore {
	read(level: AutonomyLevel): AutonomyRolloutRecord | undefined;
	write(record: AutonomyRolloutRecord): void;
}

export interface AutonomyRolloutDecision {
	outcome: "promoted" | "rejected";
	level: AutonomyLevel;
	reasons: string[];
	record?: AutonomyRolloutRecord;
}

export interface AutonomyAllowance {
	allowed: boolean;
	level: AutonomyLevel;
	reasons: string[];
}

const dependencies: Record<AutonomyLevel, readonly AutonomyLevel[]> = {
	situation_context: [],
	episode_publication: ["situation_context"],
	adaptive_learning: ["situation_context", "episode_publication"],
	initiative_observation: ["situation_context", "episode_publication"],
	read_only_investigation: ["initiative_observation"],
	reversible_action: ["read_only_investigation"],
};

const levelSet = new Set<string>(AUTONOMY_LEVELS);
const evidenceKeys: readonly (keyof AutonomyRolloutEvidence)[] = [
	"situationPrecision", "correctionRetention", "unauthorizedRetrievals", "verifiedCompletionRate",
	"memoryPromotionPrecision", "scopedRecallAt5", "memoryAttributionAccuracy", "memoryDowngradePrecision", "memoryFalseDowngradeRate", "memoryNegativeTransferRate", "memoryProvenanceCoverage",
	"initiativePrecision", "initiativeAverageExpectedValue", "duplicateInitiatives", "initiativeInterruptionRate",
	"readOnlyPrecision", "readOnlyAdoptionRate", "readOnlyInterruptionRate", "duplicateReadOnlyObjectives",
	"proactivePolicyScopeCoverage", "emergencyStopBlockRate", "compensationSuccessRate", "duplicateCompensations",
	"highRiskAutonomousActions", "irreversibleAutonomousActions",
];

function assertLevel(level: string): asserts level is AutonomyLevel {
	if (!levelSet.has(level)) throw new Error(`Unknown autonomy level: ${level}`);
}

function finiteRatio(name: string, value: number, reasons: string[]): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) reasons.push(`${name} must be a finite ratio from 0 to 1`);
}

function nonNegativeCount(name: string, value: number, reasons: string[]): void {
	if (!Number.isSafeInteger(value) || value < 0) reasons.push(`${name} must be a non-negative safe integer`);
}

function validateEvidence(evidence: AutonomyRolloutEvidence): string[] {
	const reasons: string[] = [];
	if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return ["rollout evidence must be an object"];
	const actualKeys = Object.keys(evidence);
	if (actualKeys.length !== evidenceKeys.length || evidenceKeys.some((key) => !Object.hasOwn(evidence, key))) reasons.push("rollout evidence must contain exactly the declared metrics");
	const ratios: Array<[string, number]> = [
		["situation precision", evidence.situationPrecision],
		["correction retention", evidence.correctionRetention],
		["verified completion rate", evidence.verifiedCompletionRate],
		["Memory promotion precision", evidence.memoryPromotionPrecision],
		["scoped Recall@5", evidence.scopedRecallAt5],
		["Memory attribution accuracy", evidence.memoryAttributionAccuracy],
		["Memory downgrade precision", evidence.memoryDowngradePrecision],
		["Memory false downgrade rate", evidence.memoryFalseDowngradeRate],
		["Memory negative transfer rate", evidence.memoryNegativeTransferRate],
		["Memory provenance coverage", evidence.memoryProvenanceCoverage],
		["initiative precision", evidence.initiativePrecision],
		["initiative average expected value", evidence.initiativeAverageExpectedValue],
		["initiative interruption rate", evidence.initiativeInterruptionRate],
		["read-only precision", evidence.readOnlyPrecision],
		["read-only adoption rate", evidence.readOnlyAdoptionRate],
		["read-only interruption rate", evidence.readOnlyInterruptionRate],
		["proactive policy scope coverage", evidence.proactivePolicyScopeCoverage],
		["emergency-stop block rate", evidence.emergencyStopBlockRate],
		["compensation success rate", evidence.compensationSuccessRate],
	];
	for (const [name, value] of ratios) finiteRatio(name, value, reasons);
	const counts: Array<[string, number]> = [
		["unauthorized retrievals", evidence.unauthorizedRetrievals],
		["duplicate initiatives", evidence.duplicateInitiatives],
		["duplicate read-only objectives", evidence.duplicateReadOnlyObjectives],
		["duplicate compensations", evidence.duplicateCompensations],
		["high-risk autonomous actions", evidence.highRiskAutonomousActions],
		["irreversible autonomous actions", evidence.irreversibleAutonomousActions],
	];
	for (const [name, value] of counts) nonNegativeCount(name, value, reasons);
	return reasons;
}

function gateReasons(level: AutonomyLevel, evidence: AutonomyRolloutEvidence): string[] {
	const reasons = validateEvidence(evidence);
	if (reasons.length > 0) return reasons;
	const requireAtLeast = (name: string, value: number, threshold: number) => {
		if (value < threshold) reasons.push(`${name} ${value} is below ${threshold}`);
	};
	const requireAtMost = (name: string, value: number, threshold: number) => {
		if (value > threshold) reasons.push(`${name} ${value} exceeds ${threshold}`);
	};
	if (level === "situation_context") {
		requireAtLeast("situation precision", evidence.situationPrecision, 0.98);
		requireAtLeast("correction retention", evidence.correctionRetention, 0.98);
		requireAtMost("unauthorized retrievals", evidence.unauthorizedRetrievals, 0);
	} else if (level === "episode_publication") {
		requireAtLeast("verified completion rate", evidence.verifiedCompletionRate, 1);
		requireAtLeast("correction retention", evidence.correctionRetention, 0.98);
		requireAtMost("unauthorized retrievals", evidence.unauthorizedRetrievals, 0);
	} else if (level === "adaptive_learning") {
		requireAtLeast("Memory promotion precision", evidence.memoryPromotionPrecision, 0.98);
		requireAtLeast("scoped Recall@5", evidence.scopedRecallAt5, 0.9);
		requireAtLeast("Memory attribution accuracy", evidence.memoryAttributionAccuracy, 0.9);
		requireAtLeast("Memory downgrade precision", evidence.memoryDowngradePrecision, 0.95);
		requireAtLeast("Memory provenance coverage", evidence.memoryProvenanceCoverage, 1);
		requireAtMost("Memory false downgrade rate", evidence.memoryFalseDowngradeRate, 0.02);
		requireAtMost("Memory negative transfer rate", evidence.memoryNegativeTransferRate, 0.02);
		requireAtMost("unauthorized retrievals", evidence.unauthorizedRetrievals, 0);
	} else if (level === "initiative_observation") {
		requireAtLeast("initiative precision", evidence.initiativePrecision, 0.6);
		requireAtLeast("initiative average expected value", evidence.initiativeAverageExpectedValue, 0.7);
		requireAtMost("duplicate initiatives", evidence.duplicateInitiatives, 0);
		requireAtMost("initiative interruption rate", evidence.initiativeInterruptionRate, 0.1);
		requireAtMost("unauthorized retrievals", evidence.unauthorizedRetrievals, 0);
	} else if (level === "read_only_investigation") {
		requireAtLeast("read-only precision", evidence.readOnlyPrecision, 0.6);
		requireAtLeast("read-only adoption rate", evidence.readOnlyAdoptionRate, 0.6);
		requireAtMost("read-only interruption rate", evidence.readOnlyInterruptionRate, 0.1);
		requireAtMost("duplicate read-only objectives", evidence.duplicateReadOnlyObjectives, 0);
		requireAtMost("unauthorized retrievals", evidence.unauthorizedRetrievals, 0);
	} else {
		requireAtLeast("proactive policy scope coverage", evidence.proactivePolicyScopeCoverage, 1);
		requireAtLeast("emergency-stop block rate", evidence.emergencyStopBlockRate, 1);
		requireAtLeast("compensation success rate", evidence.compensationSuccessRate, 1);
		requireAtMost("duplicate compensations", evidence.duplicateCompensations, 0);
		requireAtMost("high-risk autonomous actions", evidence.highRiskAutonomousActions, 0);
		requireAtMost("irreversible autonomous actions", evidence.irreversibleAutonomousActions, 0);
	}
	return reasons;
}

export class AutonomyRolloutController {
	readonly #store: AutonomyRolloutStateStore;
	readonly #evidence?: () => AutonomyRolloutEvidence;

	constructor(options: { store: AutonomyRolloutStateStore; evidence?: () => AutonomyRolloutEvidence }) {
		this.#store = options.store;
		this.#evidence = options.evidence;
	}

	promote(levelInput: string, authority: AutonomyRolloutAuthority, at = Date.now()): AutonomyRolloutDecision {
		assertLevel(levelInput);
		const level = levelInput;
		const reasons: string[] = [];
		const authorityReason = invalidAuthorityReason(authority);
		if (authorityReason) reasons.push(authorityReason);
		if (authority.actor === "enterprise" && authority.enterpriseDisposition === "deny") reasons.push("enterprise policy denied this level");
		for (const dependency of dependencies[level]) {
			const allowance = this.allows(dependency);
			if (!allowance.allowed) reasons.push(`dependency ${dependency} is not enabled`);
		}
		if (!this.#evidence) return { outcome: "rejected", level, reasons: [...reasons, "measured rollout evidence is unavailable"] };
		const evidence = this.#evidence();
		reasons.push(...gateReasons(level, evidence));
		if (reasons.length > 0) return { outcome: "rejected", level, reasons };
		const current = this.#store.read(level);
		const record: AutonomyRolloutRecord = {
			level,
			status: "enabled",
			revision: (current?.revision ?? 0) + 1,
			updatedAt: at,
			authority: { ...authority },
			reasons: [],
			evidence: structuredClone(evidence),
		};
		this.#store.write(record);
		return { outcome: "promoted", level, reasons: [], record };
	}

	stop(levelInput: string, authority: AutonomyRolloutAuthority, at = Date.now()): AutonomyRolloutRecord {
		return this.#stopWithReason(levelInput, authority, at, "explicitly stopped");
	}

	rollback(levelInput: string, authority: AutonomyRolloutAuthority, at = Date.now()): AutonomyRolloutRecord {
		return this.#stopWithReason(levelInput, authority, at, "explicitly rolled back");
	}

	#stopWithReason(levelInput: string, authority: AutonomyRolloutAuthority, at: number, reason: string): AutonomyRolloutRecord {
		assertLevel(levelInput);
		const authorityReason = invalidAuthorityReason(authority);
		if (authorityReason) throw new Error(authorityReason);
		const current = this.#store.read(levelInput);
		const record: AutonomyRolloutRecord = {
			level: levelInput,
			status: "stopped",
			revision: (current?.revision ?? 0) + 1,
			updatedAt: at,
			authority: { ...authority },
			reasons: [reason],
			evidence: current?.evidence ? structuredClone(current.evidence) : undefined,
		};
		this.#store.write(record);
		return record;
	}

	resume(level: string, authority: AutonomyRolloutAuthority, at = Date.now()): AutonomyRolloutDecision {
		return this.promote(level, authority, at);
	}

	allows(levelInput: string, override?: AutonomyEnterpriseOverride): AutonomyAllowance {
		assertLevel(levelInput);
		if (override) {
			const authorityReason = invalidAuthorityReason({ actor: "enterprise", ...override });
			if (authorityReason) return { allowed: false, level: levelInput, reasons: [authorityReason] };
		}
		if (override?.enterpriseDisposition === "deny") {
			return { allowed: false, level: levelInput, reasons: [`enterprise policy denied this level: ${override.evidenceRef}`] };
		}
		const record = this.#store.read(levelInput);
		const reasons: string[] = [];
		if (record?.status !== "enabled") reasons.push(`${levelInput} is ${record?.status ?? "disabled"}`);
		for (const dependency of dependencies[levelInput]) {
			const dependencyRecord = this.#store.read(dependency);
			if (dependencyRecord?.status !== "enabled") reasons.push(`dependency ${dependency} is ${dependencyRecord?.status ?? "disabled"}`);
		}
		return { allowed: reasons.length === 0, level: levelInput, reasons };
	}

	snapshot(): AutonomyRolloutRecord[] {
		return AUTONOMY_LEVELS.map((level) => this.#store.read(level) ?? {
			level,
			status: "disabled" as const,
			revision: 0,
			updatedAt: 0,
			authority: { actor: "operator" as const, evidenceRef: "not-promoted" },
			reasons: ["not promoted"],
		});
	}
}

function invalidAuthorityReason(authority: AutonomyRolloutAuthority): string | undefined {
	if (!authority.evidenceRef?.trim()) return "evidence reference is required";
	if (authority.actor !== "enterprise") return undefined;
	try {
		createEnterprisePolicyPublisher({ id: authority.publisher.id, authority: authority.publisher.authority, ...(authority.publisher.evidenceRef ? { evidenceRef: authority.publisher.evidenceRef } : {}), issuedAt: authority.publisher.issuedAt });
		return undefined;
	} catch { return "enterprise override requires a trusted enterprise publisher"; }
}

/** Keeps every channel behind the same Episode publication boundary. */
export function guardVerifiedObjectiveMemoryPublisher(
	rollout: Pick<AutonomyRolloutController, "allows">,
	publish: VerifiedObjectiveMemoryPublisher,
	onBlocked?: (objectiveId: string, reasons: readonly string[]) => void,
): VerifiedObjectiveMemoryPublisher {
	return async (outcome) => {
		const allowance = rollout.allows("episode_publication");
		if (!allowance.allowed) { onBlocked?.(outcome.objectiveId, allowance.reasons); return; }
		await publish(outcome);
	};
}

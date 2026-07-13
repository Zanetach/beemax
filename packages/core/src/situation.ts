export type SituationEvidenceTrust = "reported" | "inferred" | "observed" | "verified";
export type SituationEvidenceSourceKind = "user" | "model" | "memory" | "task_ledger" | "tool" | "enterprise_system";

export interface SituationEvidenceSource {
	kind: SituationEvidenceSourceKind;
	reference: string;
}

export interface SituationObservation {
	statement: string;
	source: SituationEvidenceSource;
	evidenceRef?: string;
	confidence: number;
	trust: SituationEvidenceTrust;
}

export interface SituationAction {
	description: string;
	expectedOutcome: string;
	reversible: boolean | "unknown";
}

export interface SituationConflict {
	statement: string;
	evidenceRefs: string[];
}

/** Open, evidence-backed cognition. It deliberately contains no Access Scope. */
export interface Situation {
	summary: string;
	goals: string[];
	constraints: string[];
	uncertainties: string[];
	relevantMemoryIds: string[];
	relevantTaskIds: string[];
	observations: SituationObservation[];
	possibleActions: SituationAction[];
	conflicts?: SituationConflict[];
	confidence: number;
}

export interface SituationInput {
	summary: string;
	goals?: string[];
	constraints?: string[];
	uncertainties?: string[];
	relevantMemoryIds?: string[];
	relevantTaskIds?: string[];
	observations?: SituationObservation[];
	possibleActions?: SituationAction[];
	conflicts?: SituationConflict[];
	confidence: number;
}

const EVIDENCE_SOURCES = new Set<SituationEvidenceSourceKind>(["user", "model", "memory", "task_ledger", "tool", "enterprise_system"]);
const EVIDENCE_TRUSTS = new Set<SituationEvidenceTrust>(["reported", "inferred", "observed", "verified"]);

/** Builds Situation cognition while keeping authorization outside this interface. */
export function createSituation(input: SituationInput): Situation {
	return {
		summary: requiredText(input.summary, "Situation summary", 10_000),
		goals: textList(input.goals, "Situation goal"),
		constraints: textList(input.constraints, "Situation constraint"),
		uncertainties: textList(input.uncertainties, "Situation uncertainty"),
		relevantMemoryIds: textList(input.relevantMemoryIds, "Situation Memory reference", 1_000),
		relevantTaskIds: textList(input.relevantTaskIds, "Situation Task reference", 1_000),
		observations: (input.observations ?? []).map(normalizeObservation),
		possibleActions: (input.possibleActions ?? []).map((action) => ({
			description: requiredText(action.description, "Situation action description", 10_000),
			expectedOutcome: requiredText(action.expectedOutcome, "Situation action expected outcome", 10_000),
			reversible: normalizeReversibility(action.reversible),
		})),
		...(input.conflicts ? { conflicts: input.conflicts.map((conflict) => ({ statement: requiredText(conflict.statement, "Situation conflict", 10_000), evidenceRefs: textList(conflict.evidenceRefs, "Situation conflict evidence reference", 1_000) })) } : {}),
		confidence: boundedConfidence(input.confidence, "Situation confidence"),
	};
}

function normalizeObservation(observation: SituationObservation): SituationObservation {
	if (!EVIDENCE_SOURCES.has(observation.source?.kind)) throw new Error("Situation evidence source is unsupported");
	if (!EVIDENCE_TRUSTS.has(observation.trust)) throw new Error("Situation evidence trust is unsupported");
	if ((observation.source.kind === "model" && observation.trust !== "inferred")
		|| (observation.source.kind === "user" && observation.trust !== "reported")) {
		throw new Error("Situation evidence trust is incompatible with its source");
	}
	return {
		statement: requiredText(observation.statement, "Situation observation", 10_000),
		source: {
			kind: observation.source.kind,
			reference: requiredText(observation.source.reference, "Situation evidence source reference", 1_000),
		},
		...(observation.evidenceRef ? { evidenceRef: requiredText(observation.evidenceRef, "Situation evidence reference", 1_000) } : {}),
		confidence: boundedConfidence(observation.confidence, "Situation observation confidence"),
		trust: observation.trust,
	};
}

function normalizeReversibility(value: SituationAction["reversible"]): SituationAction["reversible"] {
	if (value === true || value === false || value === "unknown") return value;
	throw new Error("Situation action reversibility must be true, false, or unknown");
}

function textList(values: string[] | undefined, label: string, maxLength = 10_000): string[] {
	return (values ?? []).map((value) => requiredText(value, label, maxLength));
}

function boundedConfidence(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
	return value;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`${label} must be between 1 and ${maxLength} characters`);
	return value.trim();
}

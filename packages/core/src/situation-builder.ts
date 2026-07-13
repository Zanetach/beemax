import { createSituation, type Situation, type SituationAction, type SituationConflict, type SituationEvidenceSource, type SituationEvidenceTrust, type SituationObservation } from "./situation.ts";
import type { TurnUnderstanding } from "./turn-understanding.ts";

export interface SituationEvidenceInput {
	id: string;
	statement: string;
	source: SituationEvidenceSource;
	trust: SituationEvidenceTrust;
	confidence?: number;
}

export interface SituationBuildInput {
	text: string;
	fallback: TurnUnderstanding;
	origin?: { source: SituationEvidenceSource; trust: SituationEvidenceTrust };
	activeObjective?: { id: string; title: string; situation?: Situation };
	evidence?: SituationEvidenceInput[];
}

export interface SituationBuildResult {
	situation: Situation;
	facts: SituationObservation[];
	conflicts: SituationConflict[];
	unknowns: string[];
	candidateActions: SituationAction[];
	provenance: string[];
	source: "model" | "deterministic";
}

export interface SituationBuilderPort { build(input: SituationBuildInput): Promise<SituationBuildResult>; }

export interface SituationModelProposal {
	summary: string;
	facts?: Array<{ statement: string; evidenceRef?: string; confidence?: number }>;
	goals?: string[];
	constraints?: string[];
	conflicts?: SituationConflict[];
	unknowns?: string[];
	candidateActions?: SituationAction[];
	confidence: number;
}

export type SituationModelInference = (input: Readonly<Omit<SituationBuildInput, "fallback">>) => Promise<unknown>;

export class DeterministicSituationBuilder implements SituationBuilderPort {
	async build(input: SituationBuildInput): Promise<SituationBuildResult> {
		const active = input.activeObjective;
		const facts: SituationObservation[] = [
			{ statement: input.text, source: input.origin?.source ?? { kind: "user", reference: "turn:current" }, confidence: 1, trust: input.origin?.trust ?? "reported" },
			...(input.evidence ?? []).map((item) => ({ statement: item.statement, source: item.source, evidenceRef: item.id, confidence: item.confidence ?? 0.7, trust: item.trust })),
		];
		const situation = createSituation({
			summary: input.fallback.goal,
			goals: [input.fallback.goal],
			constraints: input.fallback.constraints,
			relevantMemoryIds: (input.evidence ?? []).filter((item) => item.source.kind === "memory").map((item) => item.id),
			relevantTaskIds: [...(active ? [active.id] : []), ...(input.evidence ?? []).filter((item) => item.source.kind === "task_ledger").map((item) => item.id)],
			observations: facts,
			confidence: input.fallback.confidence,
		});
		return { situation, facts, conflicts: [], unknowns: situation.uncertainties, candidateActions: situation.possibleActions, provenance: facts.map((fact) => fact.source.reference), source: "deterministic" };
	}
}

export class ModelBackedSituationBuilder implements SituationBuilderPort {
	private readonly infer: SituationModelInference;
	private readonly fallback: SituationBuilderPort;

	constructor(infer: SituationModelInference, fallback: SituationBuilderPort = new DeterministicSituationBuilder()) {
		this.infer = infer;
		this.fallback = fallback;
	}

	async build(input: SituationBuildInput): Promise<SituationBuildResult> {
		try {
			const proposal = normalizeProposal(await this.infer({ text: input.text, ...(input.activeObjective ? { activeObjective: input.activeObjective } : {}), ...(input.evidence ? { evidence: input.evidence } : {}) }));
			const allowedEvidence = new Set((input.evidence ?? []).map((item) => item.id));
			const proposalFacts = proposal.facts.map((fact) => ({ ...fact, evidenceRef: fact.evidenceRef && allowedEvidence.has(fact.evidenceRef) ? fact.evidenceRef : undefined }));
			const conflicts = proposal.conflicts.map((conflict) => ({ ...conflict, evidenceRefs: conflict.evidenceRefs.filter((reference) => allowedEvidence.has(reference)) }));
			const facts = proposalFacts.map((fact) => ({ statement: fact.statement, source: { kind: "model" as const, reference: "situation:model" }, ...(fact.evidenceRef ? { evidenceRef: fact.evidenceRef } : {}), confidence: fact.confidence ?? 0.6, trust: "inferred" as const }));
			const situation = createSituation({
				summary: proposal.summary, goals: proposal.goals, constraints: proposal.constraints, uncertainties: proposal.unknowns,
				relevantMemoryIds: [...new Set(proposalFacts.flatMap((fact) => fact.evidenceRef ? [fact.evidenceRef] : []))],
				relevantTaskIds: input.activeObjective ? [input.activeObjective.id] : [], observations: facts,
				possibleActions: proposal.candidateActions, conflicts, confidence: proposal.confidence,
			});
			return { situation, facts, conflicts, unknowns: proposal.unknowns, candidateActions: proposal.candidateActions, provenance: [...new Set(facts.flatMap((fact) => [fact.source.reference, ...(fact.evidenceRef ? [fact.evidenceRef] : [])]))], source: "model" };
		} catch {
			return this.fallback.build(input);
		}
	}
}

function normalizeProposal(value: unknown): Required<SituationModelProposal> {
	if (!value || typeof value !== "object") throw new Error("Situation model result must be an object");
	const candidate = value as Record<string, unknown>;
	return {
		summary: requiredText(candidate.summary, "summary"),
		facts: objectList(candidate.facts, (item) => ({ statement: requiredText(item.statement, "fact"), ...(optionalText(item.evidenceRef) ? { evidenceRef: optionalText(item.evidenceRef) } : {}), confidence: confidence(item.confidence, 0.6) })),
		goals: stringList(candidate.goals), constraints: stringList(candidate.constraints),
		conflicts: objectList(candidate.conflicts, (item) => ({ statement: requiredText(item.statement, "conflict"), evidenceRefs: stringList(item.evidenceRefs) })),
		unknowns: stringList(candidate.unknowns),
		candidateActions: objectList(candidate.candidateActions, (item) => ({ description: requiredText(item.description, "candidate action"), expectedOutcome: requiredText(item.expectedOutcome, "expected outcome"), reversible: item.reversible === true || item.reversible === false || item.reversible === "unknown" ? item.reversible : "unknown" })),
		confidence: confidence(candidate.confidence),
	};
}

function objectList<T>(value: unknown, map: (item: Record<string, unknown>) => T): T[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 100) throw new Error("Situation model list is invalid");
	return value.map((item) => { if (!item || typeof item !== "object") throw new Error("Situation model list item is invalid"); return map(item as Record<string, unknown>); });
}
function stringList(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 100) throw new Error("Situation model string list is invalid");
	return value.map((item) => requiredText(item, "list item"));
}
function requiredText(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim() || value.trim().length > 10_000) throw new Error(`Situation ${field} is invalid`); return value.trim(); }
function optionalText(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim().slice(0, 1_000) : undefined; }
function confidence(value: unknown, fallback?: number): number { const result = value === undefined ? fallback : value; if (typeof result !== "number" || !Number.isFinite(result) || result < 0 || result > 1) throw new Error("Situation confidence is invalid"); return result; }

import { containsCredentialMaterial } from "./credential-material.ts";
import { hasSemanticWorkContractAdjudication, validateWorkContract, type WorkContract, type WorkContractBuildResult, type WorkContractClause } from "./work-contract.ts";

export const OPEN_WORLD_CONTRACT_SCHEMA_VERSION = "beemax.open-world-contract.v1" as const;

export type CapabilityOperation = "observe" | "transform" | "act" | "deliver" | "verify";
export type ArtifactRole = "intermediate" | "deliverable" | "state";
export type ArtifactVerificationDimension = "existence" | "integrity" | "semantic" | "render" | "consistency" | "freshness" | "delivery" | "execution";
export type OutcomeEvidenceKind = "observation" | "effect" | "artifact" | "integrity" | "semantic" | "render" | "consistency" | "freshness" | "delivery" | "execution";

export interface OpenWorldOutcomeRequirement {
	id: string;
	acceptanceCriterion: WorkContractClause;
	capabilityRequirementIds: readonly string[];
	artifactRequirementIds: readonly string[];
	evidenceRequirementIds: readonly string[];
}

export interface OpenWorldCapabilityRequirement {
	id: string;
	requirement: WorkContractClause;
	operation: CapabilityOperation;
	expectedOutputs: readonly string[];
}

export interface OpenWorldArtifactRequirement {
	id: string;
	mediaType: string;
	role: ArtifactRole;
	verification: readonly ArtifactVerificationDimension[];
}

export interface OpenWorldEvidenceRequirement {
	id: string;
	kinds: readonly OutcomeEvidenceKind[];
}

export interface OpenWorldContract {
	schemaVersion: typeof OPEN_WORLD_CONTRACT_SCHEMA_VERSION;
	id: string;
	workContract: WorkContract;
	outcomes: readonly OpenWorldOutcomeRequirement[];
	capabilityRequirements: readonly OpenWorldCapabilityRequirement[];
	artifactRequirements: readonly OpenWorldArtifactRequirement[];
	evidenceRequirements: readonly OpenWorldEvidenceRequirement[];
}

export interface OpenWorldContractInput {
	id: string;
	admission: WorkContractBuildResult;
	outcomes: readonly {
		id: string;
		acceptanceCriterionIndex: number;
		capabilityRequirementIds: readonly string[];
		artifactRequirementIds?: readonly string[];
		evidenceRequirementIds: readonly string[];
	}[];
	capabilityRequirements: readonly {
		id: string;
		workContractClauseIndex: number;
		operation: CapabilityOperation;
		expectedOutputs: readonly string[];
	}[];
	artifactRequirements: readonly OpenWorldArtifactRequirement[];
	evidenceRequirements: readonly OpenWorldEvidenceRequirement[];
}

const CAPABILITY_OPERATIONS = new Set<CapabilityOperation>(["observe", "transform", "act", "deliver", "verify"]);
const ARTIFACT_ROLES = new Set<ArtifactRole>(["intermediate", "deliverable", "state"]);
const ARTIFACT_VERIFICATION_DIMENSIONS = new Set<ArtifactVerificationDimension>(["existence", "integrity", "semantic", "render", "consistency", "freshness", "delivery", "execution"]);
const OUTCOME_EVIDENCE_KINDS = new Set<OutcomeEvidenceKind>(["observation", "effect", "artifact", "integrity", "semantic", "render", "consistency", "freshness", "delivery", "execution"]);

/**
 * Compiles the semantic Work Contract into a domain-neutral outcome graph.
 * This graph carries requirements and references only: it cannot grant Tool,
 * Provider, credential, Access Scope, Effect, or delivery authority.
 */
export function createOpenWorldContract(input: OpenWorldContractInput): Readonly<OpenWorldContract> {
	if (containsCredentialMaterial(JSON.stringify(input))) throw new Error("Open-world contract cannot contain credential material");
	if (!input.admission || !hasSemanticWorkContractAdjudication(input.admission)) throw new Error("Open-world contract requires an admitted Work Contract with semantic adjudication");
	const workContract = validateWorkContract(input.admission.contract, input.admission.contract.rawRequest);
	const id = reference(input.id, "contract id");
	const outcomesInput = boundedList(input.outcomes, "outcomes", 1, 100);
	const capabilitiesInput = boundedList(input.capabilityRequirements, "capability requirements", 0, 100);
	const artifactsInput = boundedList(input.artifactRequirements, "artifact requirements", 0, 100);
	const evidenceInput = boundedList(input.evidenceRequirements, "evidence requirements", 1, 200);

	const capabilityIds = uniqueIds(capabilitiesInput, "capability requirement");
	const artifactIds = uniqueIds(artifactsInput, "artifact requirement");
	const evidenceIds = uniqueIds(evidenceInput, "evidence requirement");
	uniqueIds(outcomesInput, "outcome");

	const capabilities = capabilitiesInput.map((item) => {
		if (!CAPABILITY_OPERATIONS.has(item.operation)) throw new Error("Open-world capability operation is invalid");
		const requirement = indexedClause(workContract.capabilityRequirements, item.workContractClauseIndex, "capability requirement");
		return Object.freeze({
			id: reference(item.id, "capability requirement id"),
			requirement: freezeClause(requirement),
			operation: item.operation,
			expectedOutputs: Object.freeze(uniqueText(item.expectedOutputs, "expected outputs", 1, 20)),
		});
	});
	assertExactIndexCoverage(capabilitiesInput.map((item) => item.workContractClauseIndex), workContract.capabilityRequirements.length, "every Work Contract capability requirement");

	const artifacts = artifactsInput.map((item) => {
		if (!ARTIFACT_ROLES.has(item.role)) throw new Error("Open-world artifact role is invalid");
		const verification = uniqueEnum(item.verification, ARTIFACT_VERIFICATION_DIMENSIONS, "artifact verification", 1, ARTIFACT_VERIFICATION_DIMENSIONS.size);
		return Object.freeze({ id: reference(item.id, "artifact requirement id"), mediaType: mediaType(item.mediaType), role: item.role, verification: Object.freeze(verification) });
	});
	const evidence = evidenceInput.map((item) => Object.freeze({
		id: reference(item.id, "evidence requirement id"),
		kinds: Object.freeze(uniqueEnum(item.kinds, OUTCOME_EVIDENCE_KINDS, "evidence kinds", 1, OUTCOME_EVIDENCE_KINDS.size)),
	}));

	const outcomes = outcomesInput.map((item) => {
		const criterion = indexedClause(workContract.acceptanceCriteria, item.acceptanceCriterionIndex, "acceptance criterion");
		const capabilityRequirementIds = referenceList(item.capabilityRequirementIds, capabilityIds, "outcome capability requirement", 0, 100);
		const artifactRequirementIds = referenceList(item.artifactRequirementIds ?? [], artifactIds, "outcome artifact requirement", 0, 100);
		const evidenceRequirementIds = referenceList(item.evidenceRequirementIds, evidenceIds, "outcome evidence requirement", 1, 200);
		return Object.freeze({ id: reference(item.id, "outcome id"), acceptanceCriterion: freezeClause(criterion), capabilityRequirementIds: Object.freeze(capabilityRequirementIds), artifactRequirementIds: Object.freeze(artifactRequirementIds), evidenceRequirementIds: Object.freeze(evidenceRequirementIds) });
	});
	assertExactIndexCoverage(outcomesInput.map((item) => item.acceptanceCriterionIndex), workContract.acceptanceCriteria.length, "every Work Contract acceptance criterion");
	assertExactlyOnceReferenced(outcomes.flatMap((item) => item.capabilityRequirementIds), capabilityIds, "capability requirement");
	assertAllReferenced(outcomes.flatMap((item) => item.artifactRequirementIds), artifactIds, "artifact requirement");
	assertAllReferenced(outcomes.flatMap((item) => item.evidenceRequirementIds), evidenceIds, "evidence requirement");

	return Object.freeze({
		schemaVersion: OPEN_WORLD_CONTRACT_SCHEMA_VERSION,
		id,
		workContract: freezeWorkContract(workContract),
		outcomes: Object.freeze(outcomes),
		capabilityRequirements: Object.freeze(capabilities),
		artifactRequirements: Object.freeze(artifacts),
		evidenceRequirements: Object.freeze(evidence),
	});
}

function freezeWorkContract(contract: WorkContract): WorkContract {
	const clauses = (items: readonly WorkContractClause[]) => Object.freeze(items.map(freezeClause)) as unknown as WorkContractClause[];
	return Object.freeze({
		...contract,
		objective: freezeClause(contract.objective),
		constraints: clauses(contract.constraints),
		prohibitions: clauses(contract.prohibitions),
		acceptanceCriteria: clauses(contract.acceptanceCriteria),
		capabilityRequirements: clauses(contract.capabilityRequirements),
		uncertainties: clauses(contract.uncertainties),
		...(contract.targetObjective ? { targetObjective: Object.freeze({ ...contract.targetObjective }) } : {}),
	});
}

function freezeClause(clause: WorkContractClause): WorkContractClause {
	return Object.freeze({ text: clause.text, source: Object.freeze({ ...clause.source }) });
}

function boundedList<T>(value: readonly T[], label: string, minimum: number, maximum: number): readonly T[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`Open-world ${label} must contain between ${minimum} and ${maximum} items`);
	return value;
}

function indexedClause(clauses: readonly WorkContractClause[], index: number, label: string): WorkContractClause {
	if (!Number.isSafeInteger(index) || index < 0 || index >= clauses.length) throw new Error(`Open-world ${label} index is invalid`);
	return clauses[index]!;
}

function uniqueIds(items: readonly { id: string }[], label: string): Set<string> {
	const ids = items.map((item) => reference(item.id, `${label} id`));
	const unique = new Set(ids);
	if (unique.size !== ids.length) throw new Error(`Open-world ${label} ids must be unique`);
	return unique;
}

function referenceList(value: readonly string[], eligible: ReadonlySet<string>, label: string, minimum: number, maximum: number): string[] {
	const refs = uniqueText(value, label, minimum, maximum).map((item) => reference(item, label));
	for (const ref of refs) if (!eligible.has(ref)) throw new Error(`Open-world ${label} '${ref}' is not declared`);
	return refs;
}

function uniqueText(value: readonly string[], label: string, minimum: number, maximum: number): string[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`Open-world ${label} must contain between ${minimum} and ${maximum} items`);
	const output = value.map((item) => text(item, label, 256));
	if (new Set(output).size !== output.length) throw new Error(`Open-world ${label} must not contain duplicates`);
	return output;
}

function uniqueEnum<T extends string>(value: readonly T[], eligible: ReadonlySet<T>, label: string, minimum: number, maximum: number): T[] {
	const output = uniqueText(value, label, minimum, maximum) as T[];
	if (output.some((item) => !eligible.has(item))) throw new Error(`Open-world ${label} contains an unsupported value`);
	return output;
}

function assertExactIndexCoverage(indexes: readonly number[], expectedCount: number, label: string): void {
	const unique = new Set(indexes);
	if (indexes.length !== expectedCount || unique.size !== expectedCount || [...unique].some((index) => index < 0 || index >= expectedCount)) {
		throw new Error(`Open-world contract must bind ${label} exactly once`);
	}
}

function assertAllReferenced(actual: readonly string[], expected: ReadonlySet<string>, label: string): void {
	const referenced = new Set(actual);
	for (const id of expected) if (!referenced.has(id)) throw new Error(`Open-world ${label} '${id}' is not bound to an outcome`);
}

function assertExactlyOnceReferenced(actual: readonly string[], expected: ReadonlySet<string>, label: string): void {
	const counts = new Map<string, number>();
	for (const id of actual) counts.set(id, (counts.get(id) ?? 0) + 1);
	if (actual.length !== expected.size || [...expected].some((id) => counts.get(id) !== 1)) throw new Error(`Open-world contract must bind every ${label} exactly once`);
}

function mediaType(value: string): string {
	const normalized = text(value, "artifact media type", 256).toLowerCase();
	if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) throw new Error("Open-world artifact media type is invalid");
	return normalized;
}

function reference(value: string, label: string): string {
	const normalized = text(value, label, 256);
	if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/.test(normalized)) throw new Error(`Open-world ${label} is invalid`);
	return normalized;
}

function text(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(`Open-world ${label} must be between 1 and ${maximum} characters`);
	return value.trim();
}

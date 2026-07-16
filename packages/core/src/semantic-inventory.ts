import type { TurnAction } from "./turn-understanding.ts";
import type { WorkContract, WorkContractClause } from "./work-contract.ts";

export const SEMANTIC_INVENTORY_SCHEMA_VERSION = "beemax.semantic-inventory.v1" as const;

export const SEMANTIC_ROLES = ["objective", "constraint", "prohibition", "acceptance_criterion", "capability_requirement", "uncertainty", "context"] as const;
export type SemanticRole = typeof SEMANTIC_ROLES[number];

export interface SemanticSourceSpan { start: number; end: number; }

export interface SemanticInventorySegment extends SemanticSourceSpan {
	text: string;
	occurrence: number;
	roles: SemanticRole[];
}

export interface SemanticInventory {
	schemaVersion: typeof SEMANTIC_INVENTORY_SCHEMA_VERSION;
	/** Trusted decoder input retained for deterministic Contract comparison; never model supplied. */
	rawRequest: string;
	action: TurnAction;
	targetObjectiveId?: string;
	segments: SemanticInventorySegment[];
	confidence: number;
}

export interface SemanticInventoryDecodeContext {
	rawRequest: string;
	activeObjectives: readonly { id: string; title: string }[];
}

export type SemanticCompletenessBlockCode =
	| "RAW_REQUEST_MISMATCH"
	| "ACTION_DISAGREEMENT"
	| "TARGET_DISAGREEMENT"
	| "LOW_PRIMARY_CONFIDENCE"
	| "LOW_INVENTORY_CONFIDENCE"
	| "CAPABILITY_REQUIREMENTS_NOT_ATOMIC"
	| "ROLE_COVERAGE_INCOMPLETE";

export interface MissingSemanticRole extends SemanticSourceSpan { text: string; role: Exclude<SemanticRole, "context">; }

export type WorkContractAdjudication =
	| { kind: "accepted"; normalizedCapabilityRequirements?: WorkContractClause[] }
	| { kind: "blocked"; code: Exclude<SemanticCompletenessBlockCode, "ROLE_COVERAGE_INCOMPLETE"> }
	| { kind: "blocked"; code: "ROLE_COVERAGE_INCOMPLETE"; missing: MissingSemanticRole[] };

export interface WorkContractAdjudicationInput {
	contract: WorkContract;
	inventory: SemanticInventory;
	minimumConfidence?: number;
}

const ROLE_SET = new Set<string>(SEMANTIC_ROLES);

export function decodeSemanticInventory(value: unknown, context: SemanticInventoryDecodeContext): SemanticInventory {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Semantic Inventory must be an object");
	const proposal = value as Record<string, unknown>;
	assertOnlyKeys(proposal, ["schemaVersion", "action", "targetObjectiveId", "segments", "confidence"], "Semantic Inventory");
	if (proposal.schemaVersion !== SEMANTIC_INVENTORY_SCHEMA_VERSION) throw new Error("Semantic Inventory schema version is unsupported");
	const rawRequest = requiredRawRequest(context.rawRequest);
	const action = decodeAction(proposal.action);
	const targetObjectiveId = decodeTargetObjective(proposal.targetObjectiveId, action, context.activeObjectives);
	const confidence = decodeConfidence(proposal.confidence);
	if (!Array.isArray(proposal.segments) || proposal.segments.length === 0 || proposal.segments.length > 100) throw new Error("Semantic Inventory segments must be a non-empty bounded list");
	const segments = proposal.segments.map((segment, index) => decodeSegment(segment, rawRequest, index));
	for (let index = 1; index < segments.length; index++) {
		const previous = segments[index - 1]!;
		const current = segments[index]!;
		if (current.start < previous.start) throw new Error("Semantic Inventory segments must be ordered by Raw Request position");
		if (current.start < previous.end) throw new Error("Semantic Inventory segments must not overlap");
	}
	assertMeaningfulCoverage(rawRequest, segments);
	const materialRoles = new Set(segments.flatMap((segment) => segment.roles.filter((role) => role !== "context")));
	if (!materialRoles.has("objective")) throw new Error("Semantic Inventory must identify material Objective semantics");
	if ((action === "create" || action === "correct") && !materialRoles.has("acceptance_criterion")) throw new Error(`Semantic Inventory ${action} must identify an observable acceptance criterion`);
	return { schemaVersion: SEMANTIC_INVENTORY_SCHEMA_VERSION, rawRequest, action, ...(targetObjectiveId ? { targetObjectiveId } : {}), segments, confidence };
}

export function resolveSemanticOccurrence(rawRequest: string, text: string, occurrence: number): SemanticSourceSpan {
	if (!text || !text.trim() || text.length > 10_000) throw new Error("Semantic Inventory segment text is invalid");
	if (!Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence > 100) throw new Error("Semantic Inventory occurrence is invalid");
	let start = -1;
	let cursor = 0;
	for (let index = 0; index <= occurrence; index++) {
		start = rawRequest.indexOf(text, cursor);
		if (start < 0) throw new Error(`Semantic Inventory occurrence ${occurrence} does not exist in Raw Request`);
		cursor = start + 1;
	}
	return { start, end: start + text.length };
}

export function adjudicateWorkContract(input: WorkContractAdjudicationInput): WorkContractAdjudication {
	const { contract, inventory } = input;
	const minimumConfidence = input.minimumConfidence ?? 0.6;
	if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) throw new Error("Semantic completeness confidence threshold must be between 0 and 1");
	if (contract.rawRequest !== inventory.rawRequest) return { kind: "blocked", code: "RAW_REQUEST_MISMATCH" };
	if (contract.action !== inventory.action) return { kind: "blocked", code: "ACTION_DISAGREEMENT" };
	if (contract.targetObjective?.id !== inventory.targetObjectiveId) return { kind: "blocked", code: "TARGET_DISAGREEMENT" };
	if (contract.confidence < minimumConfidence) return { kind: "blocked", code: "LOW_PRIMARY_CONFIDENCE" };
	if (inventory.confidence < minimumConfidence) return { kind: "blocked", code: "LOW_INVENTORY_CONFIDENCE" };
	const missing: MissingSemanticRole[] = [];
	for (const segment of inventory.segments) for (const role of segment.roles) {
		if (role === "context") continue;
		if (!clausesForRole(contract, role).some((clause) => clauseCovers(clause, segment))) missing.push({ text: segment.text, role, start: segment.start, end: segment.end });
	}
	if (missing.length) return { kind: "blocked", code: "ROLE_COVERAGE_INCOMPLETE", missing };
	const capabilityOutcomes = inventory.segments.filter((segment) => segment.roles.includes("capability_requirement"));
	// The downstream Capability selector may choose alternatives for one outcome,
	// but it must not decide how many mandatory outcomes the Contract contains.
	// Normalize a broader primary clause from the independent, exact-span inventory
	// so "query and archive" becomes two Core-issued requirements without another
	// model inventing text. A coarser reviewer cannot safely erase primary outcomes.
	if (contract.capabilityRequirements.length > capabilityOutcomes.length
		|| contract.capabilityRequirements.some((clause) => !capabilityOutcomes.some((segment) => clauseCovers(clause, segment)))) {
		return { kind: "blocked", code: "CAPABILITY_REQUIREMENTS_NOT_ATOMIC" };
	}
	const normalizedCapabilityRequirements = capabilityOutcomes.map((segment): WorkContractClause => ({
		text: segment.text,
		source: { kind: "raw_request", start: segment.start, end: segment.end },
	}));
	return sameClauses(contract.capabilityRequirements, normalizedCapabilityRequirements)
		? { kind: "accepted" }
		: { kind: "accepted", normalizedCapabilityRequirements };
}

function sameClauses(left: readonly WorkContractClause[], right: readonly WorkContractClause[]): boolean {
	return left.length === right.length && left.every((clause, index) => {
		const candidate = right[index];
		return candidate !== undefined && clause.text === candidate.text && clause.source.kind === "raw_request"
			&& candidate.source.kind === "raw_request" && clause.source.start === candidate.source.start && clause.source.end === candidate.source.end;
	});
}

function decodeSegment(value: unknown, rawRequest: string, index: number): SemanticInventorySegment {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Semantic Inventory segment ${index} is invalid`);
	const segment = value as Record<string, unknown>;
	assertOnlyKeys(segment, ["text", "occurrence", "roles"], `Semantic Inventory segment ${index}`);
	if (typeof segment.text !== "string") throw new Error(`Semantic Inventory segment ${index} text is invalid`);
	if (!Array.isArray(segment.roles) || segment.roles.length === 0 || segment.roles.length > SEMANTIC_ROLES.length || segment.roles.some((role) => typeof role !== "string" || !ROLE_SET.has(role))) throw new Error(`Semantic Inventory segment ${index} roles are invalid`);
	const roles = segment.roles as SemanticRole[];
	if (new Set(roles).size !== roles.length) throw new Error(`Semantic Inventory segment ${index} roles contain duplicates`);
	if (typeof segment.occurrence !== "number") throw new Error(`Semantic Inventory segment ${index} occurrence is invalid`);
	const source = resolveSemanticOccurrence(rawRequest, segment.text, segment.occurrence);
	return { text: segment.text, occurrence: segment.occurrence, roles: [...roles], ...source };
}

function decodeTargetObjective(value: unknown, action: TurnAction, candidates: readonly { id: string; title: string }[]): string | undefined {
	const requiresTarget = action === "continue" || action === "correct" || action === "cancel";
	if (value === undefined || value === null) {
		if (requiresTarget) throw new Error(`Semantic Inventory ${action} must target one active Objective`);
		return undefined;
	}
	if (typeof value !== "string" || !value.trim() || value.length > 500 || !candidates.some((candidate) => candidate.id === value)) throw new Error("Semantic Inventory target does not match an active Objective");
	if (action === "create") throw new Error("Semantic Inventory create action cannot target an active Objective");
	return value;
}

function decodeAction(value: unknown): TurnAction {
	if (value !== "create" && value !== "continue" && value !== "correct" && value !== "query" && value !== "cancel") throw new Error("Semantic Inventory action is invalid");
	return value;
}

function decodeConfidence(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Semantic Inventory confidence is invalid");
	return value;
}

function assertMeaningfulCoverage(rawRequest: string, segments: readonly SemanticInventorySegment[]): void {
	const covered = new Uint8Array(rawRequest.length);
	for (const segment of segments) covered.fill(1, segment.start, segment.end);
	for (let index = 0; index < rawRequest.length; index++) if (isMeaningful(rawRequest[index]!) && !covered[index]) throw new Error(`Semantic Inventory coverage is incomplete at Raw Request position ${index}`);
}

function isMeaningful(value: string): boolean { return !/[\p{P}\p{S}\s]/u.test(value); }

function clausesForRole(contract: WorkContract, role: Exclude<SemanticRole, "context">): readonly WorkContractClause[] {
	if (role === "objective") return [contract.objective];
	if (role === "constraint") return contract.constraints;
	if (role === "prohibition") return contract.prohibitions;
	if (role === "acceptance_criterion") return contract.acceptanceCriteria;
	if (role === "capability_requirement") return contract.capabilityRequirements;
	return contract.uncertainties;
}

function clauseCovers(clause: WorkContractClause, segment: SemanticInventorySegment): boolean {
	return clause.source.kind === "raw_request" && clause.source.start <= segment.start && clause.source.end >= segment.end;
}

function requiredRawRequest(value: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 50_000) throw new Error("Semantic Inventory Raw Request is invalid");
	return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error(`${label} contains unsupported fields`);
}

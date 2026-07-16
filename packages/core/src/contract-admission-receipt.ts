import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { containsCredentialMaterial } from "./credential-material.ts";
import { createAdmittedWorkContractPlanningInput, isAdmittedWorkContractPlanningInput, type AdmittedWorkContractPlanningInput } from "./contract-planning-admission.ts";
import { createOpenWorldContract, type OpenWorldContract, type OpenWorldContractInput } from "./open-world-contract.ts";
import { OPEN_WORLD_CONTRACT_ADJUDICATION_SCHEMA_VERSION, hasSemanticOpenWorldContractAdjudication, type OpenWorldContractCompilationResult, type OpenWorldContractSemanticAdjudication } from "./open-world-contract-compiler.ts";
import type { Situation } from "./situation.ts";
import { WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION, hasSemanticWorkContractAdjudication, type AdjudicatedModelWorkContractBuildResult, type WorkContract, type WorkContractCognitionUsage, type WorkContractSemanticAdjudication } from "./work-contract.ts";

export const DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION = "beemax.durable-contract-admission.v2" as const;
export const DEFAULT_CONTRACT_ADMISSION_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_CONTRACT_ADMISSION_TTL_MS = 90 * 24 * 60 * 60_000;
const MAX_RECEIPT_BYTES = 1_000_000;
const MAX_RECEIPT_NODES = 50_000;
const MAX_RECEIPT_DEPTH = 64;

export interface ContractAdmissionObjectiveBinding {
	objectiveId: string;
	originalWorkContract: WorkContract;
	revisions: readonly { id: string; workContract: WorkContract; situation: Situation; createdAt: number }[];
}

export interface ContractAdmissionReceiptIntegrity {
	readonly keyIdSha256: string;
	sign(value: unknown): string;
	verify(value: unknown, signature: string): boolean;
}

export interface CreateContractAdmissionReceiptIntegrityInput {
	key: Uint8Array;
	profileId: string;
}

const receiptIntegrityAuthorities = new WeakSet<object>();

/** Creates a Profile-bound HMAC authority from a secret held outside Task storage. */
export function createContractAdmissionReceiptIntegrity(input: CreateContractAdmissionReceiptIntegrityInput): Readonly<ContractAdmissionReceiptIntegrity> {
	if (!(input.key instanceof Uint8Array) || input.key.byteLength < 32 || input.key.byteLength > 4_096) throw new Error("Contract admission integrity key must contain 32 to 4096 bytes");
	const profileId = boundedText(input.profileId, "Contract admission integrity Profile", 256);
	const derivedKey = createHmac("sha256", Buffer.from(input.key)).update(`${DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION}\0${profileId}`).digest();
	const keyIdSha256 = `sha256:${createHash("sha256").update("beemax.contract-admission.key-id\0").update(derivedKey).digest("hex")}`;
	const integrity: ContractAdmissionReceiptIntegrity = Object.freeze({
		keyIdSha256,
		sign: (value: unknown) => `hmac-sha256:${createHmac("sha256", derivedKey).update(stableJson(value)).digest("hex")}`,
		verify: (value: unknown, signature: string) => {
			if (!/^hmac-sha256:[a-f0-9]{64}$/i.test(signature)) return false;
			const expected = createHmac("sha256", derivedKey).update(stableJson(value)).digest();
			const actual = Buffer.from(signature.slice("hmac-sha256:".length), "hex");
			return actual.length === expected.length && timingSafeEqual(actual, expected);
		},
	});
	receiptIntegrityAuthorities.add(integrity);
	return integrity;
}

export interface DurableOpenWorldContractSnapshot extends Omit<OpenWorldContractInput, "admission"> {}

export interface DurableContractAdmissionReceipt {
	schemaVersion: typeof DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION;
	workContractSha256: string;
	objectiveBindingSha256: string;
	admittedAt: number;
	expiresAt: number;
	workContract: { cognitionBudgetChargeTokens: number; semanticAdjudication: WorkContractSemanticAdjudication };
	openWorld?: { snapshotSha256: string; snapshot: DurableOpenWorldContractSnapshot; cognitionBudgetChargeTokens: number; semanticAdjudication: OpenWorldContractSemanticAdjudication };
	integrity: { algorithm: "hmac-sha256"; keyIdSha256: string; valueHmacSha256: string };
}

type UnsignedDurableContractAdmissionReceipt = Omit<DurableContractAdmissionReceipt, "integrity">;

export interface CreateDurableContractAdmissionReceiptInput {
	admission: Readonly<AdmittedWorkContractPlanningInput>;
	openWorldCompilation?: Readonly<OpenWorldContractCompilationResult>;
	objectiveBinding: ContractAdmissionObjectiveBinding;
	integrity: Readonly<ContractAdmissionReceiptIntegrity>;
	admittedAt?: number;
	ttlMs?: number;
}

export interface RestoreDurableContractPlanningInput {
	receipt: unknown;
	workContract: WorkContract;
	objectiveBinding: ContractAdmissionObjectiveBinding;
	integrity: Readonly<ContractAdmissionReceiptIntegrity>;
	now?: number;
}

/** Projects process-local admission into a Profile-keyed, content-bound durable receipt. */
export function createDurableContractAdmissionReceipt(input: CreateDurableContractAdmissionReceiptInput): Readonly<DurableContractAdmissionReceipt> {
	assertIntegrityAuthority(input.integrity);
	if (!isAdmittedWorkContractPlanningInput(input.admission)) throw new Error("Durable Contract admission requires a runtime-admitted Work Contract handoff");
	const workResult = input.admission.admission;
	if (!hasSemanticWorkContractAdjudication(workResult) || workResult.source !== "model") throw new Error("Durable Contract admission requires independent Work Contract adjudication");
	const admittedAt = nonnegativeInteger(input.admittedAt ?? Date.now(), "admittedAt");
	const ttlMs = positiveInteger(input.ttlMs ?? DEFAULT_CONTRACT_ADMISSION_TTL_MS, "ttlMs");
	if (ttlMs > MAX_CONTRACT_ADMISSION_TTL_MS) throw new Error("Durable Contract admission TTL exceeds the maximum");
	const expiresAt = admittedAt + ttlMs;
	if (!Number.isSafeInteger(expiresAt)) throw new Error("Durable Contract admission expiry is invalid");
	const objectiveBindingSha256 = digestObjectiveBinding(input.objectiveBinding);
	let openWorld: UnsignedDurableContractAdmissionReceipt["openWorld"];
	if (input.openWorldCompilation) {
		if (!hasSemanticOpenWorldContractAdjudication(input.openWorldCompilation)) throw new Error("Durable Contract admission requires independently adjudicated OpenWorld compilation");
		if (stableDigest(input.openWorldCompilation.contract.workContract) !== stableDigest(input.admission.contract)) throw new Error("Durable OpenWorld compilation is bound to a different Work Contract");
		const snapshot = snapshotOpenWorldContract(input.openWorldCompilation.contract, input.admission.contract);
		openWorld = { snapshotSha256: stableDigest(snapshot), snapshot, cognitionBudgetChargeTokens: input.openWorldCompilation.cognitionBudgetChargeTokens, semanticAdjudication: structuredClone(input.openWorldCompilation.semanticAdjudication) };
	}
	const unsigned: UnsignedDurableContractAdmissionReceipt = {
		schemaVersion: DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION,
		workContractSha256: stableDigest(input.admission.contract),
		objectiveBindingSha256,
		admittedAt,
		expiresAt,
		workContract: { cognitionBudgetChargeTokens: workResult.cognitionBudgetChargeTokens, semanticAdjudication: structuredClone(workResult.semanticAdjudication) },
		...(openWorld ? { openWorld } : {}),
	};
	const receipt: DurableContractAdmissionReceipt = { ...unsigned, integrity: { algorithm: "hmac-sha256", keyIdSha256: input.integrity.keyIdSha256, valueHmacSha256: input.integrity.sign(unsigned) } };
	const encoded = stableJson(receipt);
	if (encoded.length > MAX_RECEIPT_BYTES || containsCredentialMaterial(encoded)) throw new Error("Durable Contract admission cannot contain credential material or exceed storage bounds");
	return deepFreeze(receipt);
}

/** Strict storage decoder. It validates bounded shape but never restores semantic brands. */
export function decodeDurableContractAdmissionReceipt(value: unknown): Readonly<DurableContractAdmissionReceipt> {
	assertBoundedJsonValue(value);
	const receipt = exactObject(value, "Durable Contract admission receipt", ["schemaVersion", "workContractSha256", "objectiveBindingSha256", "admittedAt", "expiresAt", "workContract", "openWorld", "integrity"], ["openWorld"]);
	if (receipt.schemaVersion !== DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION) throw new Error("Durable Contract admission schema version is unsupported");
	const admittedAt = nonnegativeInteger(receipt.admittedAt, "admittedAt");
	const expiresAt = nonnegativeInteger(receipt.expiresAt, "expiresAt");
	if (expiresAt <= admittedAt || expiresAt - admittedAt > MAX_CONTRACT_ADMISSION_TTL_MS) throw new Error("Durable Contract admission validity window is invalid");
	const work = exactObject(receipt.workContract, "Durable Work Contract admission", ["cognitionBudgetChargeTokens", "semanticAdjudication"]);
	const workCharge = positiveInteger(work.cognitionBudgetChargeTokens, "Work Contract cognition charge");
	const integrity = exactObject(receipt.integrity, "Durable Contract admission integrity", ["algorithm", "keyIdSha256", "valueHmacSha256"]);
	if (integrity.algorithm !== "hmac-sha256") throw new Error("Durable Contract admission integrity algorithm is unsupported");
	const decoded: DurableContractAdmissionReceipt = {
		schemaVersion: DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION,
		workContractSha256: sha256(receipt.workContractSha256, "Work Contract digest"),
		objectiveBindingSha256: sha256(receipt.objectiveBindingSha256, "Objective binding digest"),
		admittedAt,
		expiresAt,
		workContract: { cognitionBudgetChargeTokens: workCharge, semanticAdjudication: decodeWorkAdjudication(work.semanticAdjudication, workCharge) },
		integrity: { algorithm: "hmac-sha256", keyIdSha256: sha256(integrity.keyIdSha256, "integrity key id"), valueHmacSha256: hmacSha256(integrity.valueHmacSha256) },
	};
	if (receipt.openWorld !== undefined) {
		const open = exactObject(receipt.openWorld, "Durable OpenWorld admission", ["snapshotSha256", "snapshot", "cognitionBudgetChargeTokens", "semanticAdjudication"]);
		const openCharge = positiveInteger(open.cognitionBudgetChargeTokens, "OpenWorld cognition charge");
		decoded.openWorld = { snapshotSha256: sha256(open.snapshotSha256, "OpenWorld snapshot digest"), snapshot: decodeOpenWorldSnapshot(open.snapshot), cognitionBudgetChargeTokens: openCharge, semanticAdjudication: decodeOpenWorldAdjudication(open.semanticAdjudication, openCharge) };
	}
	const encoded = stableJson(decoded);
	if (encoded.length > MAX_RECEIPT_BYTES || containsCredentialMaterial(encoded)) throw new Error("Durable Contract admission receipt is unsafe to store");
	return deepFreeze(decoded);
}

/** Authenticates and revalidates a receipt before minting fresh process-local brands. */
export function restoreDurableContractPlanningInput(input: RestoreDurableContractPlanningInput): Readonly<AdmittedWorkContractPlanningInput> | Readonly<OpenWorldContract> {
	assertIntegrityAuthority(input.integrity);
	const receipt = decodeDurableContractAdmissionReceipt(input.receipt);
	const unsigned = unsignedReceipt(receipt);
	if (receipt.integrity.keyIdSha256 !== input.integrity.keyIdSha256 || !input.integrity.verify(unsigned, receipt.integrity.valueHmacSha256)) throw new Error("Durable Contract admission authentication failed");
	const now = nonnegativeInteger(input.now ?? Date.now(), "revalidation time");
	if (receipt.admittedAt > now) throw new Error("Durable Contract admission is not yet valid");
	if (receipt.expiresAt <= now) throw new Error("Durable Contract admission receipt expired");
	if (stableDigest(input.workContract) !== receipt.workContractSha256) throw new Error("Durable Contract admission Work Contract digest mismatch");
	if (digestObjectiveBinding(input.objectiveBinding) !== receipt.objectiveBindingSha256) throw new Error("Durable Contract admission Objective revision chain digest mismatch");
	const semanticAdjudication = structuredClone(receipt.workContract.semanticAdjudication);
	const workResult: AdjudicatedModelWorkContractBuildResult = { contract: input.workContract, source: "model", cognitionUsage: structuredClone(semanticAdjudication.cognitionUsage), cognitionBudgetChargeTokens: receipt.workContract.cognitionBudgetChargeTokens, semanticAdjudication };
	if (!hasSemanticWorkContractAdjudication(workResult)) throw new Error("Durable Contract admission Work Contract adjudication is invalid");
	const admission = createAdmittedWorkContractPlanningInput(workResult, input.workContract);
	if (!receipt.openWorld) return admission;
	if (stableDigest(receipt.openWorld.snapshot) !== receipt.openWorld.snapshotSha256) throw new Error("Durable Contract admission OpenWorld snapshot digest mismatch");
	const contract = createOpenWorldContract({ ...structuredClone(receipt.openWorld.snapshot), admission });
	const openWorldAdjudication = structuredClone(receipt.openWorld.semanticAdjudication);
	const compilation: OpenWorldContractCompilationResult = { contract, source: "model", cognitionUsage: structuredClone(openWorldAdjudication.cognitionUsage), cognitionBudgetChargeTokens: receipt.openWorld.cognitionBudgetChargeTokens, semanticAdjudication: openWorldAdjudication };
	if (!hasSemanticOpenWorldContractAdjudication(compilation)) throw new Error("Durable Contract admission OpenWorld adjudication is invalid");
	return contract;
}

/** Internal canonical equality helper for predicting idempotent correction chains. */
export function contractAdmissionWorkContractSha256(value: WorkContract): string { return stableDigest(value); }

function unsignedReceipt(receipt: Readonly<DurableContractAdmissionReceipt>): UnsignedDurableContractAdmissionReceipt {
	return { schemaVersion: receipt.schemaVersion, workContractSha256: receipt.workContractSha256, objectiveBindingSha256: receipt.objectiveBindingSha256, admittedAt: receipt.admittedAt, expiresAt: receipt.expiresAt, workContract: structuredClone(receipt.workContract), ...(receipt.openWorld ? { openWorld: structuredClone(receipt.openWorld) } : {}) };
}

function digestObjectiveBinding(binding: ContractAdmissionObjectiveBinding): string {
	assertBoundedJsonValue(binding);
	const objectiveId = boundedText(binding.objectiveId, "Contract admission Objective id", 1_000);
	if (!binding.originalWorkContract || typeof binding.originalWorkContract !== "object") throw new Error("Contract admission Objective original Work Contract is invalid");
	if (!Array.isArray(binding.revisions) || binding.revisions.length > 20) throw new Error("Contract admission Objective revision chain is invalid");
	for (const [index, revision] of binding.revisions.entries()) {
		if (!revision || typeof revision !== "object" || revision.id !== `${objectiveId}:revision:${index + 1}` || !revision.workContract || typeof revision.workContract !== "object" || !revision.situation || typeof revision.situation !== "object" || !Number.isSafeInteger(revision.createdAt) || revision.createdAt < 0) throw new Error("Contract admission Objective revision chain is invalid");
	}
	return stableDigest(binding);
}

function snapshotOpenWorldContract(contract: Readonly<OpenWorldContract>, workContract: WorkContract): DurableOpenWorldContractSnapshot {
	const criterionIndexes = new Map(workContract.acceptanceCriteria.map((clause, index) => [stableJson(clause), index]));
	const capabilityIndexes = new Map(workContract.capabilityRequirements.map((clause, index) => [stableJson(clause), index]));
	return structuredClone({
		id: contract.id,
		outcomes: contract.outcomes.map((outcome) => ({ id: outcome.id, acceptanceCriterionIndex: requiredClauseIndex(criterionIndexes, outcome.acceptanceCriterion, "acceptance criterion"), dependsOnOutcomeIds: [...outcome.dependsOnOutcomeIds], capabilityRequirementIds: [...outcome.capabilityRequirementIds], artifactRequirementIds: [...outcome.artifactRequirementIds], evidenceRequirementIds: [...outcome.evidenceRequirementIds] })),
		capabilityRequirements: contract.capabilityRequirements.map((requirement) => ({ id: requirement.id, workContractClauseIndex: requiredClauseIndex(capabilityIndexes, requirement.requirement, "capability requirement"), operation: requirement.operation, expectedOutputs: [...requirement.expectedOutputs] })),
		artifactRequirements: contract.artifactRequirements.map((requirement) => ({ id: requirement.id, mediaType: requirement.mediaType, role: requirement.role, verification: [...requirement.verification] })),
		evidenceRequirements: contract.evidenceRequirements.map((requirement) => ({ id: requirement.id, kinds: [...requirement.kinds] })),
	});
}

function decodeOpenWorldSnapshot(value: unknown): DurableOpenWorldContractSnapshot {
	const snapshot = exactObject(value, "OpenWorld snapshot", ["id", "outcomes", "capabilityRequirements", "artifactRequirements", "evidenceRequirements"]);
	openWorldReference(snapshot.id, "OpenWorld snapshot id");
	const outcomes = decodeObjectList(snapshot.outcomes, "OpenWorld snapshot outcomes", 1, 100, ["id", "acceptanceCriterionIndex", "dependsOnOutcomeIds", "capabilityRequirementIds", "artifactRequirementIds", "evidenceRequirementIds"]);
	for (const item of outcomes) {
		openWorldReference(item.id, "OpenWorld outcome id");
		nonnegativeInteger(item.acceptanceCriterionIndex, "OpenWorld acceptance criterion index");
		openWorldReferenceList(item.dependsOnOutcomeIds, "OpenWorld outcome dependencies", 0, 99);
		openWorldReferenceList(item.capabilityRequirementIds, "OpenWorld outcome capabilities", 0, 100);
		openWorldReferenceList(item.artifactRequirementIds, "OpenWorld outcome artifacts", 0, 100);
		openWorldReferenceList(item.evidenceRequirementIds, "OpenWorld outcome evidence", 1, 200);
	}
	const capabilities = decodeObjectList(snapshot.capabilityRequirements, "OpenWorld snapshot capability requirements", 0, 100, ["id", "workContractClauseIndex", "operation", "expectedOutputs"]);
	for (const item of capabilities) {
		openWorldReference(item.id, "OpenWorld capability id");
		nonnegativeInteger(item.workContractClauseIndex, "OpenWorld capability clause index");
		if (!["observe", "transform", "act", "deliver", "verify"].includes(String(item.operation))) throw new Error("OpenWorld snapshot capability operation is invalid");
		boundedUniqueTextList(item.expectedOutputs, "OpenWorld capability expected outputs", 1, 20);
	}
	const artifacts = decodeObjectList(snapshot.artifactRequirements, "OpenWorld snapshot artifact requirements", 0, 100, ["id", "mediaType", "role", "verification"]);
	for (const item of artifacts) {
		openWorldReference(item.id, "OpenWorld artifact id");
		const mediaType = boundedText(item.mediaType, "OpenWorld artifact media type", 256);
		if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType)) throw new Error("OpenWorld snapshot artifact media type is invalid");
		if (!["intermediate", "deliverable", "state"].includes(String(item.role))) throw new Error("OpenWorld snapshot artifact role is invalid");
		boundedEnumList(item.verification, "OpenWorld artifact verification", ["existence", "integrity", "semantic", "render", "consistency", "freshness", "delivery", "execution"]);
	}
	const evidence = decodeObjectList(snapshot.evidenceRequirements, "OpenWorld snapshot evidence requirements", 1, 200, ["id", "kinds"]);
	for (const item of evidence) {
		openWorldReference(item.id, "OpenWorld evidence id");
		boundedEnumList(item.kinds, "OpenWorld evidence kinds", ["observation", "effect", "artifact", "integrity", "semantic", "render", "consistency", "freshness", "delivery", "execution"]);
	}
	return structuredClone(snapshot) as unknown as DurableOpenWorldContractSnapshot;
}

function decodeWorkAdjudication(value: unknown, charge: number): WorkContractSemanticAdjudication {
	const receipt = exactObject(value, "Work Contract semantic adjudication", ["schemaVersion", "inventorySchemaVersion", "primaryModelIdentity", "reviewerModelIdentity", "reviewMode", "independentSamples", "cognitionUsage", "cognitionBudgetChargeTokens"]);
	if (receipt.schemaVersion !== WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION || receipt.inventorySchemaVersion !== "beemax.semantic-inventory.v1" || receipt.independentSamples !== true || receipt.cognitionBudgetChargeTokens !== charge) throw new Error("Work Contract semantic adjudication is invalid");
	const primary = modelIdentity(receipt.primaryModelIdentity);
	const reviewer = modelIdentity(receipt.reviewerModelIdentity);
	const reviewMode = reviewModeOf(receipt.reviewMode, primary, reviewer);
	const cognitionUsage = decodeUsage(receipt.cognitionUsage, primary, reviewer);
	return { schemaVersion: WORK_CONTRACT_ADJUDICATION_SCHEMA_VERSION, inventorySchemaVersion: "beemax.semantic-inventory.v1", primaryModelIdentity: primary, reviewerModelIdentity: reviewer, reviewMode, independentSamples: true, cognitionUsage, cognitionBudgetChargeTokens: charge };
}

function decodeOpenWorldAdjudication(value: unknown, charge: number): OpenWorldContractSemanticAdjudication {
	const receipt = exactObject(value, "OpenWorld semantic adjudication", ["schemaVersion", "primaryModelIdentity", "reviewerModelIdentity", "reviewMode", "independentSamples", "cognitionUsage", "cognitionBudgetChargeTokens"]);
	if (receipt.schemaVersion !== OPEN_WORLD_CONTRACT_ADJUDICATION_SCHEMA_VERSION || receipt.independentSamples !== true || receipt.cognitionBudgetChargeTokens !== charge) throw new Error("OpenWorld semantic adjudication is invalid");
	const primary = modelIdentity(receipt.primaryModelIdentity);
	const reviewer = modelIdentity(receipt.reviewerModelIdentity);
	const reviewMode = reviewModeOf(receipt.reviewMode, primary, reviewer);
	const cognitionUsage = decodeUsage(receipt.cognitionUsage, primary, reviewer);
	return { schemaVersion: OPEN_WORLD_CONTRACT_ADJUDICATION_SCHEMA_VERSION, primaryModelIdentity: primary, reviewerModelIdentity: reviewer, reviewMode, independentSamples: true, cognitionUsage, cognitionBudgetChargeTokens: charge };
}

function decodeUsage(value: unknown, primary: string, reviewer: string): WorkContractCognitionUsage {
	const usage = exactObject(value, "Contract cognition usage", ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "modelIdentities"]);
	const tokens = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
	if (!tokens.every((item) => Number.isSafeInteger(item) && (item as number) >= 0) || typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0 || !Array.isArray(usage.modelIdentities) || usage.modelIdentities.length > 100 || usage.modelIdentities.some((item) => { try { boundedText(item, "Contract cognition model identity", 512); return false; } catch { return true; } })) throw new Error("Contract cognition usage is invalid");
	const identities = usage.modelIdentities as string[];
	const valid = primary === reviewer ? identities.filter((item) => item === primary).length >= 2 : identities.includes(primary) && identities.includes(reviewer);
	if (!valid) throw new Error("Contract cognition usage does not prove independent samples");
	return { inputTokens: usage.inputTokens as number, outputTokens: usage.outputTokens as number, cacheReadTokens: usage.cacheReadTokens as number, cacheWriteTokens: usage.cacheWriteTokens as number, costUsd: usage.costUsd as number, modelIdentities: [...identities] };
}

function reviewModeOf(value: unknown, primary: string, reviewer: string): "different_models" | "same_model_independent_samples" {
	if (value === "different_models" && primary !== reviewer) return value;
	if (value === "same_model_independent_samples" && primary === reviewer) return value;
	throw new Error("Contract semantic review mode is invalid");
}

function assertBoundedJsonValue(value: unknown): void {
	const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
	const ancestors = new Set<object>();
	let nodes = 0;
	let textBytes = 0;
	while (stack.length) {
		const item = stack.pop()!;
		if (item.exit) { ancestors.delete(item.value as object); continue; }
		if (++nodes > MAX_RECEIPT_NODES || item.depth > MAX_RECEIPT_DEPTH) throw new Error("Durable Contract admission receipt exceeds structural bounds");
		if (typeof item.value === "string") { textBytes += Buffer.byteLength(item.value); if (textBytes > MAX_RECEIPT_BYTES) throw new Error("Durable Contract admission receipt exceeds storage bounds"); continue; }
		if (item.value === null || typeof item.value === "number" || typeof item.value === "boolean") continue;
		if (typeof item.value !== "object") throw new Error("Durable Contract admission receipt is not JSON-safe");
		if (ancestors.has(item.value)) throw new Error("Durable Contract admission receipt contains a cycle");
		ancestors.add(item.value);
		stack.push({ value: item.value, depth: item.depth, exit: true });
		for (const [key, nested] of Object.entries(item.value as Record<string, unknown>)) {
			textBytes += Buffer.byteLength(key);
			if (textBytes > MAX_RECEIPT_BYTES) throw new Error("Durable Contract admission receipt exceeds storage bounds");
			stack.push({ value: nested, depth: item.depth + 1 });
		}
	}
}

function decodeObjectList(value: unknown, label: string, minimum: number, maximum: number, keys: readonly string[]): Record<string, unknown>[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} is invalid`);
	return value.map((item) => exactObject(item, label, keys));
}

function exactObject(value: unknown, label: string, keys: readonly string[], optionalKeys: readonly string[] = []): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	const record = value as Record<string, unknown>;
	const allowed = new Set(keys);
	if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error(`${label} contains unsupported fields`);
	const optional = new Set(optionalKeys);
	if (keys.some((key) => !optional.has(key) && !Object.prototype.hasOwnProperty.call(record, key))) throw new Error(`${label} is missing required fields`);
	return record;
}

function openWorldReference(value: unknown, label: string): string {
	const reference = boundedText(value, label, 256);
	if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/.test(reference)) throw new Error(`${label} is invalid`);
	return reference;
}

function openWorldReferenceList(value: unknown, label: string, minimum: number, maximum: number): string[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} is invalid`);
	const references = value.map((item) => openWorldReference(item, label));
	if (new Set(references).size !== references.length) throw new Error(`${label} contains duplicates`);
	return references;
}

function boundedUniqueTextList(value: unknown, label: string, minimum: number, maximum: number): string[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} is invalid`);
	const items = value.map((item) => boundedText(item, label, 256));
	if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates`);
	return items;
}

function boundedEnumList(value: unknown, label: string, eligible: readonly string[]): string[] {
	const items = boundedUniqueTextList(value, label, 1, eligible.length);
	if (items.some((item) => !eligible.includes(item))) throw new Error(`${label} contains an unsupported value`);
	return items;
}

function requiredClauseIndex(indexes: ReadonlyMap<string, number>, clause: unknown, label: string): number { const index = indexes.get(stableJson(clause)); if (index === undefined) throw new Error(`Durable OpenWorld ${label} is not bound to the admitted Work Contract`); return index; }
function stableDigest(value: unknown): string { return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`; }
function stableJson(value: unknown): string { if (value === null || typeof value !== "object") { const encoded = JSON.stringify(value); return encoded === undefined ? "null" : encoded; } if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`; }
function sha256(value: unknown, label: string): string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(value)) throw new Error(`Durable Contract admission ${label} is invalid`); return value.toLowerCase(); }
function hmacSha256(value: unknown): string { if (typeof value !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/i.test(value)) throw new Error("Durable Contract admission HMAC is invalid"); return value.toLowerCase(); }
function modelIdentity(value: unknown): string { return boundedText(value, "Contract semantic model identity", 512); }
function boundedText(value: unknown, label: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid`); return value; }
function nonnegativeInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Durable Contract admission ${label} is invalid`); return value as number; }
function positiveInteger(value: unknown, label: string): number { const candidate = nonnegativeInteger(value, label); if (candidate <= 0) throw new Error(`Durable Contract admission ${label} must be positive`); return candidate; }
function assertIntegrityAuthority(value: Readonly<ContractAdmissionReceiptIntegrity>): void { if (!value || typeof value !== "object" || !receiptIntegrityAuthorities.has(value as object)) throw new Error("Contract admission integrity authority is not trusted"); }
function deepFreeze<T>(value: T): Readonly<T> { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); Object.freeze(value); } return value; }

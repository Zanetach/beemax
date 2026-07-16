import { createHash } from "node:crypto";
import { containsCredentialMaterial } from "./credential-material.ts";
import { createAdmittedWorkContractPlanningInput, isAdmittedWorkContractPlanningInput, type AdmittedWorkContractPlanningInput } from "./contract-planning-admission.ts";
import { createOpenWorldContract, type OpenWorldContract, type OpenWorldContractInput } from "./open-world-contract.ts";
import { hasSemanticOpenWorldContractAdjudication, type OpenWorldContractCompilationResult, type OpenWorldContractSemanticAdjudication } from "./open-world-contract-compiler.ts";
import { hasSemanticWorkContractAdjudication, type AdjudicatedModelWorkContractBuildResult, type WorkContract, type WorkContractSemanticAdjudication } from "./work-contract.ts";

export const DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION = "beemax.durable-contract-admission.v1" as const;
export const DEFAULT_CONTRACT_ADMISSION_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_CONTRACT_ADMISSION_TTL_MS = 90 * 24 * 60 * 60_000;

export interface DurableOpenWorldContractSnapshot extends Omit<OpenWorldContractInput, "admission"> {}

export interface DurableContractAdmissionReceipt {
	schemaVersion: typeof DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION;
	workContractSha256: string;
	admittedAt: number;
	expiresAt: number;
	workContract: {
		cognitionBudgetChargeTokens: number;
		semanticAdjudication: WorkContractSemanticAdjudication;
	};
	openWorld?: {
		snapshotSha256: string;
		snapshot: DurableOpenWorldContractSnapshot;
		cognitionBudgetChargeTokens: number;
		semanticAdjudication: OpenWorldContractSemanticAdjudication;
	};
}

export interface CreateDurableContractAdmissionReceiptInput {
	admission: Readonly<AdmittedWorkContractPlanningInput>;
	openWorldCompilation?: Readonly<OpenWorldContractCompilationResult>;
	admittedAt?: number;
	ttlMs?: number;
}

/**
 * Projects in-process admission brands into a content-bound durable receipt.
 * The receipt grants no Tool or Effect authority and must be re-admitted after
 * every process restart before it can reach contract-driven planning.
 */
export function createDurableContractAdmissionReceipt(input: CreateDurableContractAdmissionReceiptInput): Readonly<DurableContractAdmissionReceipt> {
	if (!isAdmittedWorkContractPlanningInput(input.admission)) throw new Error("Durable Contract admission requires a runtime-admitted Work Contract handoff");
	const workResult = input.admission.admission;
	if (!hasSemanticWorkContractAdjudication(workResult) || workResult.source !== "model") throw new Error("Durable Contract admission requires independent Work Contract adjudication");
	const admittedAt = nonnegativeInteger(input.admittedAt ?? Date.now(), "admittedAt");
	const ttlMs = positiveInteger(input.ttlMs ?? DEFAULT_CONTRACT_ADMISSION_TTL_MS, "ttlMs");
	if (ttlMs > MAX_CONTRACT_ADMISSION_TTL_MS) throw new Error("Durable Contract admission TTL exceeds the maximum");
	const expiresAt = admittedAt + ttlMs;
	if (!Number.isSafeInteger(expiresAt)) throw new Error("Durable Contract admission expiry is invalid");
	let openWorld: DurableContractAdmissionReceipt["openWorld"];
	if (input.openWorldCompilation) {
		if (!hasSemanticOpenWorldContractAdjudication(input.openWorldCompilation)) throw new Error("Durable Contract admission requires independently adjudicated OpenWorld compilation");
		if (stableDigest(input.openWorldCompilation.contract.workContract) !== stableDigest(input.admission.contract)) throw new Error("Durable OpenWorld compilation is bound to a different Work Contract");
		const snapshot = snapshotOpenWorldContract(input.openWorldCompilation.contract, input.admission.contract);
		openWorld = {
			snapshotSha256: stableDigest(snapshot),
			snapshot,
			cognitionBudgetChargeTokens: input.openWorldCompilation.cognitionBudgetChargeTokens,
			semanticAdjudication: structuredClone(input.openWorldCompilation.semanticAdjudication),
		};
	}
	const receipt: DurableContractAdmissionReceipt = {
		schemaVersion: DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION,
		workContractSha256: stableDigest(input.admission.contract),
		admittedAt,
		expiresAt,
		workContract: {
			cognitionBudgetChargeTokens: workResult.cognitionBudgetChargeTokens,
			semanticAdjudication: structuredClone(workResult.semanticAdjudication),
		},
		...(openWorld ? { openWorld } : {}),
	};
	if (containsCredentialMaterial(JSON.stringify(receipt))) throw new Error("Durable Contract admission cannot contain credential material");
	return deepFreeze(receipt);
}

/** Strict storage decoder. Semantic brands are intentionally not restored here. */
export function decodeDurableContractAdmissionReceipt(value: unknown): Readonly<DurableContractAdmissionReceipt> {
	const receipt = object(value, "Durable Contract admission receipt");
	if (receipt.schemaVersion !== DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION) throw new Error("Durable Contract admission schema version is unsupported");
	const admittedAt = nonnegativeInteger(receipt.admittedAt, "admittedAt");
	const expiresAt = nonnegativeInteger(receipt.expiresAt, "expiresAt");
	if (expiresAt <= admittedAt || expiresAt - admittedAt > MAX_CONTRACT_ADMISSION_TTL_MS) throw new Error("Durable Contract admission validity window is invalid");
	const workContract = object(receipt.workContract, "Durable Work Contract admission");
	const decoded: DurableContractAdmissionReceipt = {
		schemaVersion: DURABLE_CONTRACT_ADMISSION_SCHEMA_VERSION,
		workContractSha256: sha256(receipt.workContractSha256, "Work Contract digest"),
		admittedAt,
		expiresAt,
		workContract: {
			cognitionBudgetChargeTokens: positiveInteger(workContract.cognitionBudgetChargeTokens, "Work Contract cognition charge"),
			semanticAdjudication: structuredClone(object(workContract.semanticAdjudication, "Work Contract semantic adjudication")) as unknown as WorkContractSemanticAdjudication,
		},
	};
	if (receipt.openWorld !== undefined) {
		const openWorld = object(receipt.openWorld, "Durable OpenWorld admission");
		decoded.openWorld = {
			snapshotSha256: sha256(openWorld.snapshotSha256, "OpenWorld snapshot digest"),
			snapshot: structuredClone(object(openWorld.snapshot, "OpenWorld snapshot")) as unknown as DurableOpenWorldContractSnapshot,
			cognitionBudgetChargeTokens: positiveInteger(openWorld.cognitionBudgetChargeTokens, "OpenWorld cognition charge"),
			semanticAdjudication: structuredClone(object(openWorld.semanticAdjudication, "OpenWorld semantic adjudication")) as unknown as OpenWorldContractSemanticAdjudication,
		};
	}
	const encoded = JSON.stringify(decoded);
	if (encoded.length > 1_000_000 || containsCredentialMaterial(encoded)) throw new Error("Durable Contract admission receipt is unsafe to store");
	return deepFreeze(decoded);
}

/**
 * Revalidates time, digests, semantic receipts, graph references, and factory
 * invariants before minting fresh process-local planning brands.
 */
export function restoreDurableContractPlanningInput(receiptValue: unknown, workContract: WorkContract, now = Date.now()): Readonly<AdmittedWorkContractPlanningInput> | Readonly<OpenWorldContract> {
	const receipt = decodeDurableContractAdmissionReceipt(receiptValue);
	const checkedNow = nonnegativeInteger(now, "revalidation time");
	if (receipt.admittedAt > checkedNow) throw new Error("Durable Contract admission is not yet valid");
	if (receipt.expiresAt <= checkedNow) throw new Error("Durable Contract admission receipt expired");
	if (stableDigest(workContract) !== receipt.workContractSha256) throw new Error("Durable Contract admission Work Contract digest mismatch");
	const semanticAdjudication = structuredClone(receipt.workContract.semanticAdjudication);
	const workResult: AdjudicatedModelWorkContractBuildResult = {
		contract: workContract,
		source: "model",
		cognitionUsage: structuredClone(semanticAdjudication.cognitionUsage),
		cognitionBudgetChargeTokens: receipt.workContract.cognitionBudgetChargeTokens,
		semanticAdjudication,
	};
	if (!hasSemanticWorkContractAdjudication(workResult)) throw new Error("Durable Contract admission Work Contract adjudication is invalid");
	const admission = createAdmittedWorkContractPlanningInput(workResult, workContract);
	if (!receipt.openWorld) return admission;
	if (stableDigest(receipt.openWorld.snapshot) !== receipt.openWorld.snapshotSha256) throw new Error("Durable Contract admission OpenWorld snapshot digest mismatch");
	const contract = createOpenWorldContract({ ...structuredClone(receipt.openWorld.snapshot), admission });
	const openWorldAdjudication = structuredClone(receipt.openWorld.semanticAdjudication);
	const compilation: OpenWorldContractCompilationResult = {
		contract,
		source: "model",
		cognitionUsage: structuredClone(openWorldAdjudication.cognitionUsage),
		cognitionBudgetChargeTokens: receipt.openWorld.cognitionBudgetChargeTokens,
		semanticAdjudication: openWorldAdjudication,
	};
	if (!hasSemanticOpenWorldContractAdjudication(compilation)) throw new Error("Durable Contract admission OpenWorld adjudication is invalid");
	return contract;
}

function snapshotOpenWorldContract(contract: Readonly<OpenWorldContract>, workContract: WorkContract): DurableOpenWorldContractSnapshot {
	const criterionIndexes = new Map(workContract.acceptanceCriteria.map((clause, index) => [stableJson(clause), index]));
	const capabilityIndexes = new Map(workContract.capabilityRequirements.map((clause, index) => [stableJson(clause), index]));
	const snapshot: DurableOpenWorldContractSnapshot = {
		id: contract.id,
		outcomes: contract.outcomes.map((outcome) => ({
			id: outcome.id,
			acceptanceCriterionIndex: requiredClauseIndex(criterionIndexes, outcome.acceptanceCriterion, "acceptance criterion"),
			dependsOnOutcomeIds: [...outcome.dependsOnOutcomeIds],
			capabilityRequirementIds: [...outcome.capabilityRequirementIds],
			artifactRequirementIds: [...outcome.artifactRequirementIds],
			evidenceRequirementIds: [...outcome.evidenceRequirementIds],
		})),
		capabilityRequirements: contract.capabilityRequirements.map((requirement) => ({
			id: requirement.id,
			workContractClauseIndex: requiredClauseIndex(capabilityIndexes, requirement.requirement, "capability requirement"),
			operation: requirement.operation,
			expectedOutputs: [...requirement.expectedOutputs],
		})),
		artifactRequirements: contract.artifactRequirements.map((requirement) => ({ id: requirement.id, mediaType: requirement.mediaType, role: requirement.role, verification: [...requirement.verification] })),
		evidenceRequirements: contract.evidenceRequirements.map((requirement) => ({ id: requirement.id, kinds: [...requirement.kinds] })),
	};
	return structuredClone(snapshot);
}

function requiredClauseIndex(indexes: ReadonlyMap<string, number>, clause: unknown, label: string): number {
	const index = indexes.get(stableJson(clause));
	if (index === undefined) throw new Error(`Durable OpenWorld ${label} is not bound to the admitted Work Contract`);
	return index;
}

function stableDigest(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function sha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(value)) throw new Error(`Durable Contract admission ${label} is invalid`);
	return value.toLowerCase();
}

function nonnegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Durable Contract admission ${label} is invalid`);
	return value as number;
}

function positiveInteger(value: unknown, label: string): number {
	const candidate = nonnegativeInteger(value, label);
	if (candidate <= 0) throw new Error(`Durable Contract admission ${label} must be positive`);
	return candidate;
}

function deepFreeze<T>(value: T): Readonly<T> {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}

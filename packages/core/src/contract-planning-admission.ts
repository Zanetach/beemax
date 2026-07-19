import { hasSemanticWorkContractAdjudication, validateWorkContract, type AdjudicatedModelWorkContractBuildResult, type WorkContract } from "./work-contract.ts";

export interface AdmittedWorkContractPlanningInput {
	readonly admission: AdjudicatedModelWorkContractBuildResult;
	readonly contract: WorkContract;
}

const admittedWorkContractPlanningInputs = new WeakSet<object>();

/**
 * Package-internal handoff from the trusted Agent Runtime admission boundary.
 * This module is intentionally absent from the package root exports so
 * ordinary structural objects cannot manufacture planning provenance.
 */
export function createAdmittedWorkContractPlanningInput(admission: AdjudicatedModelWorkContractBuildResult, validatedContract?: WorkContract): Readonly<AdmittedWorkContractPlanningInput> {
	if (!isStructurallyAdjudicatedWorkContract(admission)) throw new Error("Contract-driven planning requires an admitted Work Contract with independent semantic adjudication");
	const contract = freezePlanningWorkContract(validatedContract ?? validateWorkContract(admission.contract, admission.contract.rawRequest));
	const input = Object.freeze({ admission: Object.freeze({ ...admission, contract }), contract });
	admittedWorkContractPlanningInputs.add(input);
	return input;
}

export function isAdmittedWorkContractPlanningInput(value: unknown): value is Readonly<AdmittedWorkContractPlanningInput> {
	return Boolean(value && typeof value === "object" && admittedWorkContractPlanningInputs.has(value));
}

function isStructurallyAdjudicatedWorkContract(value: unknown): value is AdjudicatedModelWorkContractBuildResult {
	return Boolean(value && typeof value === "object" && "contract" in value
		&& (value as { contract?: unknown }).contract && typeof (value as { contract?: unknown }).contract === "object"
		&& "source" in value && (value as { source?: unknown }).source === "model"
		&& hasSemanticWorkContractAdjudication(value as AdjudicatedModelWorkContractBuildResult));
}

function freezePlanningWorkContract(contract: WorkContract): WorkContract {
	const freezeClause = (clause: WorkContract["objective"]) => Object.freeze({ text: clause.text, source: Object.freeze({ ...clause.source }) });
	const freezeClauses = (clauses: WorkContract["constraints"]) => Object.freeze(clauses.map(freezeClause)) as unknown as WorkContract["constraints"];
	return Object.freeze({
		...contract,
		objective: freezeClause(contract.objective),
		constraints: freezeClauses(contract.constraints),
		prohibitions: freezeClauses(contract.prohibitions),
		acceptanceCriteria: freezeClauses(contract.acceptanceCriteria),
		capabilityRequirements: freezeClauses(contract.capabilityRequirements),
		uncertainties: freezeClauses(contract.uncertainties),
		...(contract.targetObjective ? { targetObjective: Object.freeze({ ...contract.targetObjective }) } : {}),
	});
}

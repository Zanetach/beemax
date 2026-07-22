import { PiWorkContractBuilder, type PiWorkContractModelCandidate } from "@thruvera/core";

/**
 * Interactive execution admits the user's intent once, then lets Pi execute and
 * repair against task-specific verification. OpenWorld graph compilation stays
 * available for offline/durable planning, but is not an execution admission
 * gate because it grants no Tool or Effect authority.
 */
export function createInteractiveContractCognition(models: PiWorkContractModelCandidate[]) {
	return Object.freeze({ workContractBuilder: new PiWorkContractBuilder({ models, topology: "inventory_compiler" }) });
}

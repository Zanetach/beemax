import type { AgentScope } from "./agent-scope.ts";
import { responsibilityOwnerKey, responsibilityOwnerKeys } from "./agent-scope.ts";
import type { MeasuredActionReliability } from "./action-governance.ts";
import { ActionGovernance } from "./action-governance.ts";
import type { ExecutionBudgetRef } from "./execution-envelope.ts";
import { initiativeScopeMatchesExecutionScope, type InitiativeObservation } from "./initiative-runtime.ts";
import type { Situation } from "./situation.ts";
import type { TaskRecord } from "./task-ledger.ts";
import type { ToolPolicy } from "./tool-runtime.ts";

export interface ProactiveCapability {
	name: string;
	policy: ToolPolicy;
	reliability: MeasuredActionReliability;
}

export interface ProactiveInvestigationPolicy {
	enabled: boolean;
	minExpectedValue: number;
	minConfidence: number;
	maxToolCalls: number;
	maxTokens: number;
	timeoutMs: number;
}

export interface ProactiveInvestigationExecution {
	objective: TaskRecord;
	prompt: string;
	allowedCapabilities: string[];
	budget: ExecutionBudgetRef;
	executionScope: AgentScope;
	observation: InitiativeObservation;
}

export interface ProactiveInvestigationExecutionResult {
	status: "succeeded" | "failed" | "cancelled";
	materialResult: boolean;
}

export interface ProactiveInvestigationMetric {
	observationId: string;
	objectiveId?: string;
	outcome: "rejected" | "active_updated" | "duplicate_terminal" | "material_result" | "quiet_no_result" | "execution_failed";
	reason?: string;
	expectedValue: number;
	confidence: number;
	maxToolCalls: number;
	maxTokens: number;
	notify: boolean;
	at: number;
}

export interface ProactiveInvestigationLedger {
	record(task: TaskRecord): void;
	queryTasks(query: { ownerKeys: string[]; id?: string; kinds?: Array<"objective">; statuses?: TaskRecord["status"][]; limit?: number }): TaskRecord[];
	updateSituation?(ownerKey: string, taskId: string, situation: Situation): boolean;
}

export interface ProactiveInvestigationRuntimeOptions {
	ledger: ProactiveInvestigationLedger;
	governance: ActionGovernance;
	execute: (input: ProactiveInvestigationExecution) => Promise<ProactiveInvestigationExecutionResult>;
	metrics?: { record(event: ProactiveInvestigationMetric): void };
	policy?: Partial<ProactiveInvestigationPolicy>;
}

export interface ProactiveInvestigationCandidate {
	observation: InitiativeObservation;
	executionScope: AgentScope;
	capabilities: ProactiveCapability[];
}

export type ProactiveInvestigationResult =
	| { kind: "admitted"; objective: TaskRecord; notify: boolean; materialResult: boolean }
	| { kind: "active_updated"; objective: TaskRecord; notify: false }
	| { kind: "rejected"; reason: string; notify: false };

const DEFAULT_POLICY: Readonly<ProactiveInvestigationPolicy> = Object.freeze({
	enabled: true,
	minExpectedValue: 0.7,
	minConfidence: 0.75,
	maxToolCalls: 6,
	maxTokens: 8_000,
	timeoutMs: 60_000,
});

/**
 * Converts evidence-backed Initiative observations into bounded, read-only
 * Objectives. Execution remains delegated to the existing Pi runtime.
 */
export class ProactiveInvestigationRuntime {
	private readonly options: ProactiveInvestigationRuntimeOptions;
	private readonly policy: ProactiveInvestigationPolicy;
	private readonly inFlight = new Set<string>();

	constructor(options: ProactiveInvestigationRuntimeOptions) {
		this.options = options;
		this.policy = normalizePolicy(options.policy);
	}

	async consider(candidate: ProactiveInvestigationCandidate, at = Date.now()): Promise<ProactiveInvestigationResult> {
		const { observation, executionScope } = candidate;
		const rejected = this.rejectionReason(candidate, at);
		if (rejected) {
			this.recordMetric(observation, at, "rejected", false, undefined, rejected);
			return { kind: "rejected", reason: rejected, notify: false };
		}

		const ownerKey = responsibilityOwnerKey(executionScope);
		const ownerKeys = responsibilityOwnerKeys(executionScope);
		const objectiveId = observation.relatedObjectiveId ?? `objective:initiative:${observation.dedupeKey}`;
		const active = this.options.ledger.queryTasks({ ownerKeys, id: objectiveId, kinds: ["objective"], statuses: ["pending", "running"], limit: 1 })[0];
		let objective: TaskRecord | undefined;
		if (active) {
			this.options.ledger.updateSituation?.(active.ownerKey, active.id, observation.situation);
			const updated = this.options.ledger.queryTasks({ ownerKeys, id: active.id, kinds: ["objective"], statuses: ["pending", "running"], limit: 1 })[0] ?? active;
			const recoverablePending = updated.status === "pending" && !observation.relatedObjectiveId && updated.idempotencyKey === `initiative:${observation.dedupeKey}`;
			if (!recoverablePending || this.inFlight.has(updated.id)) {
				this.recordMetric(observation, at, "active_updated", false, updated.id);
				return { kind: "active_updated", objective: updated, notify: false };
			}
			objective = updated;
		}
		const terminal = objective ? undefined : this.options.ledger.queryTasks({ ownerKeys, id: objectiveId, kinds: ["objective"], statuses: ["succeeded", "failed", "cancelled"], limit: 1 })[0];
		if (terminal) {
			this.recordMetric(observation, at, "duplicate_terminal", false, terminal.id, "The Initiative Objective has already reached a terminal state");
			return { kind: "rejected", reason: "The Initiative Objective has already reached a terminal state", notify: false };
		}

		if (!objective) {
			objective = createObjective(objectiveId, ownerKey, observation, executionScope, at);
			try {
				this.options.ledger.record(objective);
			} catch (error) {
				const raced = this.options.ledger.queryTasks({ ownerKeys, id: objectiveId, kinds: ["objective"], statuses: ["pending", "running"], limit: 1 })[0];
				if (!raced) throw error;
				this.options.ledger.updateSituation?.(ownerKey, raced.id, observation.situation);
				this.recordMetric(observation, at, "active_updated", false, raced.id, "A concurrent admission already created the Objective");
				return { kind: "active_updated", objective: raced, notify: false };
			}
		}

		const budget = Object.freeze({
			maxToolCalls: this.policy.maxToolCalls,
			maxTokens: this.policy.maxTokens,
			deadlineAt: at + this.policy.timeoutMs,
			maxCorrectiveAttempts: 1,
		});
		this.inFlight.add(objective.id);
		let execution: ProactiveInvestigationExecutionResult;
		try {
			execution = await this.options.execute({
				objective,
				prompt: investigationPrompt(observation),
				allowedCapabilities: [...new Set(candidate.capabilities.map(({ name }) => name))],
				budget,
				executionScope,
				observation,
			});
		} finally {
			this.inFlight.delete(objective.id);
		}
		const materialResult = execution.status === "succeeded" && execution.materialResult;
		const notify = materialResult;
		const outcome = execution.status !== "succeeded" ? "execution_failed" : materialResult ? "material_result" : "quiet_no_result";
		this.recordMetric(observation, at, outcome, notify, objective.id);
		return { kind: "admitted", objective, notify, materialResult };
	}

	private rejectionReason(candidate: ProactiveInvestigationCandidate, at: number): string | undefined {
		if (!this.policy.enabled) return "Proactive read-only investigation is disabled";
		if (!initiativeScopeMatchesExecutionScope(candidate.observation.scope, candidate.executionScope)) return "Initiative observation and execution scope do not match";
		if (candidate.observation.expectedValue < this.policy.minExpectedValue) return "Expected value is below the proactive admission threshold";
		if (candidate.observation.confidence < this.policy.minConfidence) return "Confidence is below the proactive admission threshold";
		if (candidate.observation.risk !== "none" && candidate.observation.risk !== "low") return "Initiative risk exceeds the read-only investigation threshold";
		if (!candidate.observation.evidenceRefs.length) return "The Initiative observation has no durable evidence";
		if (!candidate.capabilities.length) return "No investigation capability is available";
		for (const capability of candidate.capabilities) {
			if (capability.policy.sideEffect !== "none") return `Capability ${capability.name} is not read-only`;
			const decision = this.options.governance.decide({
				actionId: `initiative:${candidate.observation.id}`,
				toolName: capability.name,
				toolPolicy: capability.policy,
				effectStatus: "none",
				reliability: capability.reliability,
				at,
			});
			if (decision.outcome !== "allow") return `Capability ${capability.name} was not admitted: ${decision.reasonCode}`;
		}
		return undefined;
	}

	private recordMetric(observation: InitiativeObservation, at: number, outcome: ProactiveInvestigationMetric["outcome"], notify: boolean, objectiveId?: string, reason?: string): void {
		this.options.metrics?.record({
			observationId: observation.id,
			...(objectiveId ? { objectiveId } : {}),
			outcome,
			...(reason ? { reason } : {}),
			expectedValue: observation.expectedValue,
			confidence: observation.confidence,
			maxToolCalls: this.policy.maxToolCalls,
			maxTokens: this.policy.maxTokens,
			notify,
			at,
		});
	}
}

function createObjective(id: string, ownerKey: string, observation: InitiativeObservation, executionScope: AgentScope, at: number): TaskRecord {
	return {
		id,
		ownerKey,
		kind: "objective",
		title: observation.action.slice(0, 240),
		description: observation.rationale,
		acceptanceCriteria: observation.intendedVerification,
		recoveryPolicy: "safe_retry",
		idempotencyKey: `initiative:${observation.dedupeKey}`,
		executionScope: structuredClone(executionScope),
		situation: structuredClone(observation.situation),
		status: "pending",
		verificationStatus: "pending",
		createdAt: at,
	};
}

function investigationPrompt(observation: InitiativeObservation): string {
	return [observation.action, `Why this may matter: ${observation.rationale}`, `Verify: ${observation.intendedVerification}`, "Use only the admitted read-only capabilities. Report only source-backed findings; if nothing material is found, finish quietly."].join("\n\n");
}

function normalizePolicy(input: Partial<ProactiveInvestigationPolicy> | undefined): ProactiveInvestigationPolicy {
	const policy = { ...DEFAULT_POLICY, ...input };
	if (!Number.isFinite(policy.minExpectedValue) || policy.minExpectedValue < 0 || policy.minExpectedValue > 1) throw new Error("Proactive expected-value threshold must be between 0 and 1");
	if (!Number.isFinite(policy.minConfidence) || policy.minConfidence < 0 || policy.minConfidence > 1) throw new Error("Proactive confidence threshold must be between 0 and 1");
	for (const [name, value] of [["maxToolCalls", policy.maxToolCalls], ["maxTokens", policy.maxTokens], ["timeoutMs", policy.timeoutMs]] as const) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Proactive ${name} must be a positive safe integer`);
	}
	return policy;
}

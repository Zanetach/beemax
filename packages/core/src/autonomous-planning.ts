import { isAdmittedOpenWorldContract, type OpenWorldContract } from "./open-world-contract.ts";
import { isAdmittedWorkContractPlanningInput, type AdmittedWorkContractPlanningInput } from "./contract-planning-admission.ts";
import type { WorkContract } from "./work-contract.ts";

export type AutonomousExecutionMode = "direct" | "delegate" | "dag";
export type PlanningBasis = "raw_prompt" | "work_contract" | "open_world_contract";
export type PlanningVerificationDepth = "none" | "criterion" | "artifact" | "independent";

export interface PlanningResourceBudget {
	maxSubagents: number;
	maxToolCalls: number | null;
	maxTokens: number | null;
	maxCorrectiveAttempts: number;
}

export interface PlanningSignals {
	complexity: number;
	independentWorkItems: number;
	requiresResearch: boolean;
	requiresVerification: boolean;
	requestsParallelism: boolean;
	substantialWork: boolean;
}

export interface AutonomousPlanningDecision {
	mode: AutonomousExecutionMode;
	basis: PlanningBasis;
	verificationDepth: PlanningVerificationDepth;
	contractCoverage?: ContractPlanningCoverage;
	requiredTool?: "task_spawn" | "task_plan_execute";
	requiredTools: readonly ("task_spawn" | "task_wait" | "task_plan_execute")[];
	suggestedConcurrency: number;
	budget: PlanningResourceBudget;
	signals: PlanningSignals;
	reason: string;
	/** A content-free control hint safe to append to a model prompt or audit event. */
	directive(objectiveId?: string): string;
}

export interface ContractPlanningCoverage {
	contractId: string;
	outcomeIds: readonly string[];
	capabilityRequirementIds: readonly string[];
	artifactRequirementIds: readonly string[];
	evidenceRequirementIds: readonly string[];
	parallelWidth: number;
}

export type ContractPlanningInput = AdmittedWorkContractPlanningInput | OpenWorldContract;

export interface AutonomousPlanningPolicyOptions {
	maxConcurrent?: number;
	maxSubagents?: number;
	maxToolCalls?: number;
	maxTokens?: number;
	maxCorrectiveAttempts?: number;
}

/**
 * Deterministic admission policy for autonomous work.
 * It does not ask a model to classify its own prompt, so weak models receive
 * the same bounded execution mode and resource ceiling as strong models.
 */
export class AutonomousPlanningPolicy {
	private readonly capacity: { maxConcurrent: number; maxSubagents: number; maxToolCalls: number; maxTokens: number; maxCorrectiveAttempts: number };

	constructor(options: AutonomousPlanningPolicyOptions = {}) {
		this.capacity = {
			maxConcurrent: boundedInt(options.maxConcurrent, 3, 1, 20),
			maxSubagents: boundedInt(options.maxSubagents, 5, 0, 20),
			maxToolCalls: boundedInt(options.maxToolCalls, 32, 1, 1_000),
			maxTokens: boundedInt(options.maxTokens, 64_000, 1_000, 10_000_000),
			maxCorrectiveAttempts: boundedInt(options.maxCorrectiveAttempts, 1, 0, 5),
		};
	}

	createBudgetRegistry(): PlanningBudgetRegistry { return new PlanningBudgetRegistry(); }

	decide(input: string | ContractPlanningInput): AutonomousPlanningDecision {
		if (typeof input !== "string") {
			if (!isAdmittedOpenWorldContract(input) && !isAdmittedWorkContractPlanningInput(input)) throw new Error("Contract-driven planning requires an admitted Work Contract handoff or factory-admitted Open-World Contract");
			return this.decideContract(input);
		}
		const prompt = input;
		const normalized = prompt.trim();
		const signals = inspectPrompt(normalized);
		const forbidsDelegation = has(normalized.toLowerCase(), /(?:不|不要|无需|禁止)(?:再)?(?:委派|子代理|子\s*agent)|(?:do not|don't|without)\s+(?:delegate|delegation|sub-?agents?)/i);
		let mode: AutonomousExecutionMode = "direct";
		let reason = "Simple or single-step request; keep execution in the parent Agent";

		if ((signals.complexity >= 6 && (signals.requiresResearch || signals.substantialWork || signals.independentWorkItems >= 2)) || (signals.requiresResearch && signals.substantialWork)) {
			mode = "delegate";
			reason = "One substantial isolated work item benefits from a fresh Sub-Agent context";
		}
		if (signals.independentWorkItems >= 2 && signals.complexity >= 5) {
			mode = "dag";
			reason = "Multiple independent substantial work items can execute as a verified DAG";
		}
		if (forbidsDelegation) {
			mode = "direct";
			reason = "The user explicitly requires execution in the parent Agent";
		}

		const dagCapacity = Math.min(this.capacity.maxConcurrent, this.capacity.maxSubagents);
		if (mode === "dag" && (dagCapacity < 2 || (this.capacity.maxToolCalls !== null && this.capacity.maxToolCalls < 10) || (this.capacity.maxTokens !== null && this.capacity.maxTokens < 12_000))) {
			mode = this.capacity.maxSubagents > 0 ? "delegate" : "direct";
			reason = "DAG demand exceeds the configured resource budget or parallel capacity; degrade safely";
		}
		if (mode === "delegate" && this.capacity.maxSubagents < 1) {
			mode = "direct";
			reason = "Sub-Agent capacity is unavailable; execute directly within the configured budget";
		}

		const desiredWorkers = Math.max(2, Math.min(signals.independentWorkItems || 2, 8));
		const suggestedConcurrency = mode === "dag"
			? Math.min(desiredWorkers, this.capacity.maxConcurrent, this.capacity.maxSubagents)
			: 1;
		const maxSubagents = mode === "dag"
			? Math.min(this.capacity.maxSubagents, Math.max(suggestedConcurrency, signals.independentWorkItems))
			: mode === "delegate" ? Math.min(1, this.capacity.maxSubagents) : 0;
		const scale = mode === "dag" ? Math.max(2, maxSubagents) : mode === "delegate" ? 1 : 0;
		const directTokenTarget = signals.requiresResearch || signals.requiresVerification ? 20_000 : 12_000;
		const budget: PlanningResourceBudget = {
			maxSubagents,
			maxToolCalls: this.capacity.maxToolCalls === null ? null : Math.min(this.capacity.maxToolCalls, mode === "direct" ? 8 : Math.max(12, scale * 8)),
			maxTokens: this.capacity.maxTokens === null ? null : Math.min(this.capacity.maxTokens, mode === "direct" ? directTokenTarget : Math.max(20_000, scale * 16_000)),
			maxCorrectiveAttempts: mode === "direct" ? 0 : this.capacity.maxCorrectiveAttempts,
		};
		const requiredTools = mode === "dag" ? ["task_plan_execute"] as const : mode === "delegate" ? ["task_spawn", "task_wait"] as const : [];
		const requiredTool = requiredTools[0];
		const verificationDepth: PlanningVerificationDepth = signals.requiresVerification ? "criterion" : "none";
		const decision = { mode, basis: "raw_prompt" as const, verificationDepth, requiredTool, requiredTools, suggestedConcurrency, budget, signals, reason };
		return {
			...decision,
			directive: (objectiveId) => `[BeeMax execution policy: objective=${objectiveId ?? "turn-local"}; mode=${mode}; requiredTools=${requiredTools.length ? requiredTools.join("->") : "none"}; concurrency=${suggestedConcurrency}; maxSubagents=${budget.maxSubagents}; maxToolCalls=${budget.maxToolCalls ?? "unbounded"}; maxTokens=${budget.maxTokens ?? "unbounded"}; correctiveAttempts=${budget.maxCorrectiveAttempts}. This is the sole current execution policy for this Objective; ignore earlier BeeMax planning correction or execution policy messages for other Objectives, including unscoped messages. Complete requiredTools in order before giving a final answer.]`,
		};
	}

	private decideContract(contract: ContractPlanningInput): AutonomousPlanningDecision {
		let openWorld: OpenWorldContract | undefined;
		let workContract: WorkContract;
		if (isAdmittedOpenWorldContract(contract)) {
			openWorld = contract;
			workContract = contract.workContract;
		} else {
			workContract = contract.contract;
		}
		const outcomeIds = openWorld?.outcomes.map((outcome) => outcome.id) ?? workContract.acceptanceCriteria.map((_, index) => `criterion:${index}`);
		const capabilityRequirementIds = openWorld?.capabilityRequirements.map((requirement) => requirement.id) ?? workContract.capabilityRequirements.map((_, index) => `capability:${index}`);
		const artifactRequirementIds = openWorld?.artifactRequirements.map((requirement) => requirement.id) ?? [];
		const evidenceRequirementIds = openWorld?.evidenceRequirements.map((requirement) => requirement.id) ?? [];
		const parallelWidth = openWorld ? maximumOutcomeParallelWidth(openWorld) : Math.min(1, outcomeIds.length);
		const coverage: ContractPlanningCoverage = Object.freeze({
			contractId: openWorld?.id ?? "turn:work-contract",
			outcomeIds: Object.freeze(outcomeIds),
			capabilityRequirementIds: Object.freeze(capabilityRequirementIds),
			artifactRequirementIds: Object.freeze(artifactRequirementIds),
			evidenceRequirementIds: Object.freeze(evidenceRequirementIds),
			parallelWidth,
		});
		const verificationDepth = contractVerificationDepth(openWorld, outcomeIds.length);
		const requiresResearch = Boolean(openWorld?.capabilityRequirements.some((requirement) => requirement.operation === "observe")
			&& openWorld.evidenceRequirements.some((requirement) => requirement.kinds.includes("observation") || requirement.kinds.includes("freshness")));
		const substantialWork = outcomeIds.length > 1 || capabilityRequirementIds.length > 1 || artifactRequirementIds.length > 0 || evidenceRequirementIds.length > 1;
		const complexity = Math.min(10,
			outcomeIds.length
			+ capabilityRequirementIds.length
			+ artifactRequirementIds.length * 2
			+ evidenceRequirementIds.length
			+ workContract.uncertainties.length * 2,
		);
		const signals: PlanningSignals = {
			complexity,
			independentWorkItems: Math.max(1, parallelWidth),
			requiresResearch,
			requiresVerification: verificationDepth !== "none",
			requestsParallelism: parallelWidth >= 2,
			substantialWork,
		};
		const containsParentOnlyEffect = Boolean(openWorld?.capabilityRequirements.some((requirement) => requirement.operation === "act" || requirement.operation === "deliver"));
		let mode: AutonomousExecutionMode = "direct";
		let reason = "One admitted atomic outcome fits the parent Agent execution boundary";
		if (!containsParentOnlyEffect && openWorld && parallelWidth >= 2 && outcomeIds.length >= 2) {
			mode = "dag";
			reason = "The admitted outcome dependency graph contains parallel independently verifiable work";
		} else if (!containsParentOnlyEffect && substantialWork) {
			mode = "delegate";
			reason = "The admitted Contract contains substantial bounded work without a proven parallel outcome graph";
		} else if (containsParentOnlyEffect) {
			reason = "The admitted Contract includes an action or delivery Effect that remains in the parent Agent authority boundary";
		}
		if (contractForbidsDelegation(workContract) && mode !== "direct") {
			mode = "direct";
			reason = "The admitted Work Contract explicitly prohibits delegation";
		}
		if (workContract.executionMode === "direct" && mode !== "direct") {
			mode = "direct";
			reason = "The admitted Work Contract retains a direct execution boundary";
		} else if (workContract.executionMode === "delegate" && mode === "dag") {
			mode = "delegate";
			reason = "The admitted Work Contract permits delegation but not a multi-Task DAG";
		}

		const dagCapacity = Math.min(this.capacity.maxConcurrent, this.capacity.maxSubagents);
		if (mode === "dag" && (dagCapacity < 2 || this.capacity.maxToolCalls < 10 || this.capacity.maxTokens < 12_000)) {
			mode = this.capacity.maxSubagents > 0 ? "delegate" : "direct";
			reason = "The admitted Contract proves parallel work, but configured capacity requires a bounded degradation";
		}
		if (mode === "delegate" && this.capacity.maxSubagents < 1) {
			mode = "direct";
			reason = "The admitted Contract is substantial, but Sub-Agent capacity is unavailable";
		}

		const suggestedConcurrency = mode === "dag" ? Math.min(parallelWidth, this.capacity.maxConcurrent, this.capacity.maxSubagents) : 1;
		const maxSubagents = mode === "dag" ? Math.min(this.capacity.maxSubagents, outcomeIds.length) : mode === "delegate" ? 1 : 0;
		const effort = Math.max(1, outcomeIds.length + capabilityRequirementIds.length + artifactRequirementIds.length * 2 + evidenceRequirementIds.length);
		const toolTarget = mode === "direct" ? Math.max(4, effort * 2) : Math.max(12, effort * 3);
		const tokenTarget = Math.max(8_000, 4_000 + effort * 4_000 + workContract.uncertainties.length * 2_000);
		const maxCorrectiveAttempts = verificationDepth === "none" ? 0 : Math.min(this.capacity.maxCorrectiveAttempts, verificationDepth === "independent" ? 2 : 1);
		const budget: PlanningResourceBudget = {
			maxSubagents,
			maxToolCalls: Math.min(this.capacity.maxToolCalls, toolTarget),
			maxTokens: Math.min(this.capacity.maxTokens, tokenTarget),
			maxCorrectiveAttempts,
		};
		const requiredTools = mode === "dag" ? ["task_plan_execute"] as const : mode === "delegate" ? ["task_spawn", "task_wait"] as const : [];
		const requiredTool = requiredTools[0];
		const basis = openWorld ? "open_world_contract" as const : "work_contract" as const;
		return {
			mode,
			basis,
			verificationDepth,
			contractCoverage: coverage,
			requiredTool,
			requiredTools,
			suggestedConcurrency,
			budget,
			signals,
			reason,
			directive: (objectiveId) => `[BeeMax contract execution policy: objective=${objectiveId ?? "turn-local"}; contract=${coverage.contractId}; basis=${basis}; outcomes=${coverage.outcomeIds.join(",") || "none"}; capabilities=${coverage.capabilityRequirementIds.join(",") || "none"}; artifacts=${coverage.artifactRequirementIds.join(",") || "none"}; evidence=${coverage.evidenceRequirementIds.join(",") || "none"}; verificationDepth=${verificationDepth}; mode=${mode}; requiredTools=${requiredTools.length ? requiredTools.join("->") : "none"}; concurrency=${suggestedConcurrency}; maxSubagents=${budget.maxSubagents}; maxToolCalls=${budget.maxToolCalls}; maxTokens=${budget.maxTokens}; correctiveAttempts=${budget.maxCorrectiveAttempts}. This policy was derived after semantic Work Contract admission. Preserve every listed requirement through execution and Verification; do not substitute raw-prompt planning heuristics.]`,
		};
	}
}

/** Scope-bound handoff from turn admission to tools executing inside that turn. */
export class PlanningBudgetRegistry {
	private readonly active = new Map<string, { lease: string; decision: AutonomousPlanningDecision; objectiveTaskId?: string }>();

	begin(scopeKey: string, decision: AutonomousPlanningDecision, objectiveTaskId?: string): string {
		if (!scopeKey.trim()) throw new Error("Planning budget scope is required");
		const lease = crypto.randomUUID();
		this.active.set(scopeKey, { lease, decision, objectiveTaskId });
		return lease;
	}

	current(scopeKey: string): AutonomousPlanningDecision | undefined {
		return this.active.get(scopeKey)?.decision;
	}
	currentObjectiveTaskId(scopeKey: string): string | undefined { return this.active.get(scopeKey)?.objectiveTaskId; }

	end(scopeKey: string, lease: string): boolean {
		if (this.active.get(scopeKey)?.lease !== lease) return false;
		return this.active.delete(scopeKey);
	}
}

function inspectPrompt(prompt: string): PlanningSignals {
	const lower = prompt.toLowerCase();
	const requiresResearch = has(lower, /\b(research|investigate|audit|review|compare|benchmark|search|look up|latest|today|real[- ]?time|up[- ]to[- ]date)\b|\bcurrent\s+(?!(?:best|most\s+suitable|goal|task|objective|context|directory|workspace)\b)|研究|调研|审查|审核|对标|比较|查(?:一下|找)|查询|搜索|检索|今天|今日|当前(?!最(?:合适|佳|好)|目标|任务|上下文|目录|工作区)|最新|实时/);
	const requiresVerification = has(lower, /\b(verify|validate|test|evidence|acceptance|quality)\b|验证|测试|证据|验收|质量/);
	const requestsParallelism = has(lower, /\b(parallel|concurrent|independently)\b|并行|并发|独立地/);
	const synthesis = has(lower, /\b(synthesi[sz]e|combine|report|release|implement|build|refactor)\b|汇总|综合|报告|发布|实现|开发|重构/);
	const substantialWork = has(lower, /\b(deep(?:ly)?|comprehensive|thorough|evidence[- ]backed|official documentation|full (?:audit|review|report)|across (?:the )?(?:project|codebase))\b|深入|深度|全面|完整报告|整个项目|全项目|证据支持/);
	const orderedSteps = (prompt.match(/(?:^|\s)(?:\d+[.)]|[-*])\s/gm) ?? []).length;
	const enumeratedItems = estimateIndependentItems(prompt);
	const independentWorkItems = Math.max(
		requestsParallelism ? 2 : 1,
		orderedSteps >= 2 ? Math.min(orderedSteps, 8) : 1,
		enumeratedItems,
	);
	let complexity = 0;
	if (prompt.length >= 120) complexity++;
	if (prompt.length >= 300) complexity++;
	if (requiresResearch) complexity += 2;
	if (requiresVerification) complexity++;
	if (requestsParallelism) complexity += 2;
	if (synthesis) complexity++;
	if (independentWorkItems >= 3) complexity += 2;
	return { complexity, independentWorkItems, requiresResearch, requiresVerification, requestsParallelism, substantialWork };
}

function contractForbidsDelegation(contract: WorkContract): boolean {
	const delegation = /\b(?:delegate|delegation|delegating|sub[\s-]?agents?|child\s+agents?|worker\s+agents?)\b|(?:委派|转派|分派给|子代理|子智能体|子\s*agent)/i;
	const parentOnly = /\b(?:only\s+(?:the\s+)?(?:parent|main|primary|current)\s+agent|(?:parent|main|primary|current)\s+agent\s+only)\b|(?:仅|只)(?:允许|能|由|使用)?(?:父|主|当前)(?:代理|智能体|\s*agent)/i;
	return contract.prohibitions.some((clause) => delegation.test(clause.text))
		|| contract.constraints.some((clause) => parentOnly.test(clause.text));
}

function contractVerificationDepth(contract: OpenWorldContract | undefined, outcomeCount: number): PlanningVerificationDepth {
	if (outcomeCount === 0) return "none";
	if (!contract) return "criterion";
	const independentDimensions = new Set(["semantic", "render", "consistency", "freshness", "delivery", "execution"]);
	if (contract.artifactRequirements.some((requirement) => requirement.verification.some((dimension) => independentDimensions.has(dimension)))
		|| contract.evidenceRequirements.some((requirement) => requirement.kinds.some((kind) => independentDimensions.has(kind)))) return "independent";
	if (contract.artifactRequirements.length > 0) return "artifact";
	return "criterion";
}

function maximumOutcomeParallelWidth(contract: OpenWorldContract): number {
	const indegree = new Map(contract.outcomes.map((outcome) => [outcome.id, outcome.dependsOnOutcomeIds.length]));
	const dependents = new Map<string, string[]>();
	for (const outcome of contract.outcomes) for (const dependency of outcome.dependsOnOutcomeIds) {
		dependents.set(dependency, [...(dependents.get(dependency) ?? []), outcome.id]);
	}
	let wave = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
	let maximum = wave.length;
	let visited = 0;
	while (wave.length) {
		visited += wave.length;
		const next: string[] = [];
		for (const id of wave) for (const dependent of dependents.get(id) ?? []) {
			const degree = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, degree);
			if (degree === 0) next.push(dependent);
		}
		wave = next;
		maximum = Math.max(maximum, wave.length);
	}
	if (visited !== contract.outcomes.length) throw new Error("Open-world outcome dependency graph is cyclic");
	return Math.max(1, maximum);
}

function estimateIndependentItems(prompt: string): number {
	const candidate = prompt.match(/(?:review|audit|compare|研究|审查|审核|比较|对标)(?: the)?\s+(.+?)(?:\s+(?:in parallel|independently|并行|独立)|[;；。]|$)/i)?.[1];
	if (!candidate) return 1;
	const parts = candidate.split(/\s*,\s*|，|、|\s+and\s+|以及|和/).map((item) => item.trim()).filter(Boolean);
	return Math.max(1, Math.min(parts.length, 8));
}

function has(value: string, pattern: RegExp): boolean { return pattern.test(value); }
function boundedInt(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? Math.trunc(value!) : fallback));
}

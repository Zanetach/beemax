export type AutonomousExecutionMode = "direct" | "delegate" | "dag";

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
	requiredTool?: "task_spawn" | "task_plan_execute";
	requiredTools: readonly ("task_spawn" | "task_wait" | "task_plan_execute")[];
	suggestedConcurrency: number;
	budget: PlanningResourceBudget;
	signals: PlanningSignals;
	reason: string;
	/** A content-free control hint safe to append to a model prompt or audit event. */
	directive(objectiveId?: string): string;
}

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
	private readonly capacity: PlanningResourceBudget & { maxConcurrent: number };

	constructor(options: AutonomousPlanningPolicyOptions = {}) {
		this.capacity = {
			maxConcurrent: boundedInt(options.maxConcurrent, 3, 1, 20),
			maxSubagents: boundedInt(options.maxSubagents, 5, 0, 20),
			maxToolCalls: optionalBoundedInt(options.maxToolCalls, 1, 1_000),
			maxTokens: optionalBoundedInt(options.maxTokens, 1_000, 10_000_000),
			maxCorrectiveAttempts: boundedInt(options.maxCorrectiveAttempts, 1, 0, 5),
		};
	}

	createBudgetRegistry(): PlanningBudgetRegistry { return new PlanningBudgetRegistry(); }

	decide(prompt: string): AutonomousPlanningDecision {
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
		const budget: PlanningResourceBudget = {
			maxSubagents,
			maxToolCalls: this.capacity.maxToolCalls === null ? null : Math.min(this.capacity.maxToolCalls, mode === "direct" ? 8 : Math.max(12, scale * 8)),
			maxTokens: this.capacity.maxTokens === null ? null : Math.min(this.capacity.maxTokens, mode === "direct" ? 12_000 : Math.max(20_000, scale * 16_000)),
			maxCorrectiveAttempts: mode === "direct" ? 0 : this.capacity.maxCorrectiveAttempts,
		};
		const requiredTools = mode === "dag" ? ["task_plan_execute"] as const : mode === "delegate" ? ["task_spawn", "task_wait"] as const : [];
		const requiredTool = requiredTools[0];
		const decision = { mode, requiredTool, requiredTools, suggestedConcurrency, budget, signals, reason };
		return {
			...decision,
			directive: (objectiveId) => `[BeeMax execution policy: objective=${objectiveId ?? "turn-local"}; mode=${mode}; requiredTools=${requiredTools.length ? requiredTools.join("->") : "none"}; concurrency=${suggestedConcurrency}; maxSubagents=${budget.maxSubagents}; maxToolCalls=${budget.maxToolCalls ?? "unbounded"}; maxTokens=${budget.maxTokens ?? "unbounded"}; correctiveAttempts=${budget.maxCorrectiveAttempts}. This is the sole current execution policy for this Objective; ignore earlier BeeMax planning correction or execution policy messages for other Objectives, including unscoped messages. Complete requiredTools in order before giving a final answer.]`,
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
function optionalBoundedInt(value: number | undefined, minimum: number, maximum: number): number | null {
	return value === undefined ? null : Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? Math.trunc(value) : maximum));
}

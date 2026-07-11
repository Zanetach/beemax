export type AutonomousExecutionMode = "direct" | "delegate" | "dag";

export interface PlanningResourceBudget {
	maxSubagents: number;
	maxToolCalls: number;
	maxTokens: number;
	maxCorrectiveAttempts: number;
}

export interface PlanningSignals {
	complexity: number;
	independentWorkItems: number;
	requiresResearch: boolean;
	requiresVerification: boolean;
	requestsParallelism: boolean;
}

export interface AutonomousPlanningDecision {
	mode: AutonomousExecutionMode;
	requiredTool?: "task_spawn" | "task_plan_execute";
	suggestedConcurrency: number;
	budget: PlanningResourceBudget;
	signals: PlanningSignals;
	reason: string;
	/** A content-free control hint safe to append to a model prompt or audit event. */
	directive(): string;
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
			maxToolCalls: boundedInt(options.maxToolCalls, 40, 1, 1_000),
			maxTokens: boundedInt(options.maxTokens, 80_000, 1_000, 10_000_000),
			maxCorrectiveAttempts: boundedInt(options.maxCorrectiveAttempts, 1, 0, 5),
		};
	}

	createBudgetRegistry(): PlanningBudgetRegistry { return new PlanningBudgetRegistry(); }

	decide(prompt: string): AutonomousPlanningDecision {
		const normalized = prompt.trim();
		const signals = inspectPrompt(normalized);
		let mode: AutonomousExecutionMode = "direct";
		let reason = "Simple or single-step request; keep execution in the parent Agent";

		if (signals.complexity >= 3 || signals.requiresResearch) {
			mode = "delegate";
			reason = "One substantial isolated work item benefits from a fresh Sub-Agent context";
		}
		if (signals.independentWorkItems >= 2 && signals.complexity >= 5) {
			mode = "dag";
			reason = "Multiple independent substantial work items can execute as a verified DAG";
		}

		const dagCapacity = Math.min(this.capacity.maxConcurrent, this.capacity.maxSubagents);
		if (mode === "dag" && (dagCapacity < 2 || this.capacity.maxToolCalls < 10 || this.capacity.maxTokens < 12_000)) {
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
			maxToolCalls: Math.min(this.capacity.maxToolCalls, mode === "direct" ? 8 : Math.max(12, scale * 8)),
			maxTokens: Math.min(this.capacity.maxTokens, mode === "direct" ? 12_000 : Math.max(20_000, scale * 16_000)),
			maxCorrectiveAttempts: mode === "direct" ? 0 : this.capacity.maxCorrectiveAttempts,
		};
		const requiredTool = mode === "dag" ? "task_plan_execute" as const : mode === "delegate" ? "task_spawn" as const : undefined;
		const decision = { mode, requiredTool, suggestedConcurrency, budget, signals, reason };
		return {
			...decision,
			directive: () => `[BeeMax execution policy: mode=${mode}; requiredTool=${requiredTool ?? "none"}; concurrency=${suggestedConcurrency}; maxSubagents=${budget.maxSubagents}; maxToolCalls=${budget.maxToolCalls}; maxTokens=${budget.maxTokens}; correctiveAttempts=${budget.maxCorrectiveAttempts}. When requiredTool is not none, call it before giving a final answer.]`,
		};
	}
}

/** Scope-bound handoff from turn admission to tools executing inside that turn. */
export class PlanningBudgetRegistry {
	private readonly active = new Map<string, { lease: string; decision: AutonomousPlanningDecision }>();

	begin(scopeKey: string, decision: AutonomousPlanningDecision): string {
		if (!scopeKey.trim()) throw new Error("Planning budget scope is required");
		const lease = crypto.randomUUID();
		this.active.set(scopeKey, { lease, decision });
		return lease;
	}

	current(scopeKey: string): AutonomousPlanningDecision | undefined {
		return this.active.get(scopeKey)?.decision;
	}

	end(scopeKey: string, lease: string): boolean {
		if (this.active.get(scopeKey)?.lease !== lease) return false;
		return this.active.delete(scopeKey);
	}
}

function inspectPrompt(prompt: string): PlanningSignals {
	const lower = prompt.toLowerCase();
	const requiresResearch = has(lower, /\b(research|investigate|audit|review|compare|benchmark)\b|研究|调研|审查|审核|对标|比较/);
	const requiresVerification = has(lower, /\b(verify|validate|test|evidence|acceptance|quality)\b|验证|测试|证据|验收|质量/);
	const requestsParallelism = has(lower, /\b(parallel|concurrent|independent(?:ly)?)\b|并行|并发|独立/);
	const synthesis = has(lower, /\b(synthesi[sz]e|combine|report|release|implement|build|refactor)\b|汇总|综合|报告|发布|实现|开发|重构/);
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
	return { complexity, independentWorkItems, requiresResearch, requiresVerification, requestsParallelism };
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

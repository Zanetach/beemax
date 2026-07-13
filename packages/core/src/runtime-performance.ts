export const RUNTIME_PATHS = ["fast", "deep", "background"] as const;
export type RuntimePath = typeof RUNTIME_PATHS[number];

export interface RuntimePathBudget {
	p50Ms: number;
	p95Ms: number;
	maxContextChars: number;
	maxTokens: number;
	maxToolCalls: number;
	maxSubagents: number;
	maxRecallMs: number;
	maxSituationMs: number;
	maxInitiativeMs: number;
	maxCacheWriteTokens: number;
	maxConcurrency: number;
	maxBackpressureEvents: number;
}

export interface RuntimeMachineProfile {
	id: string;
	description: string;
	platform: string;
	arch: string;
	cpuPattern: string;
	minLogicalCpus: number;
	minMemoryGiB: number;
	nodeMajor: number;
	warmupIterations: number;
	sampleIterations: number;
	budgets: Record<RuntimePath, RuntimePathBudget>;
}

export interface RuntimePathObservation {
	durationsMs: readonly number[];
	contextChars: number;
	tokens: number;
	toolCalls: number;
	subagents: number;
	recallMs: number;
	situationMs: number;
	initiativeMs: number;
	cacheWriteTokens: number;
	concurrency: number;
	backpressureEvents: number;
}

export interface RuntimePerformanceInput {
	machineProfileId: string;
	budgets: Record<RuntimePath, RuntimePathBudget>;
	observations: Record<RuntimePath, RuntimePathObservation>;
}

export interface RuntimePathAssessment extends Omit<RuntimePathObservation, "durationsMs"> {
	samples: number;
	p50Ms: number;
	p95Ms: number;
}

export interface RuntimePerformanceAssessment {
	machineProfileId: string;
	passed: boolean;
	failures: string[];
	paths: Record<RuntimePath, RuntimePathAssessment>;
}

const RUNTIME_COST_METRICS = ["contextChars", "tokens", "toolCalls", "subagents", "cacheWriteTokens", "concurrency", "backpressureEvents"] as const;

/** Nearest-rank percentile over a defensive sorted copy. */
export function percentile(values: readonly number[], quantile: number): number {
	if (!values.length) throw new Error("Percentile requires at least one sample");
	if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) throw new Error("Percentile quantile must be between 0 and 1");
	const sorted = values.map((value) => finiteNonNegative(value, "duration sample")).sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
}

export function assessRuntimePerformance(input: RuntimePerformanceInput): RuntimePerformanceAssessment {
	const machineProfileId = input.machineProfileId.trim();
	if (!machineProfileId) throw new Error("Runtime machine Profile identity is required");
	const failures: string[] = [];
	const paths = {} as Record<RuntimePath, RuntimePathAssessment>;
	for (const path of RUNTIME_PATHS) {
		const budget = validateBudget(input.budgets[path], path);
		const observation = validateObservation(input.observations[path], path);
		const assessment: RuntimePathAssessment = {
			samples: observation.durationsMs.length,
			p50Ms: percentile(observation.durationsMs, 0.5),
			p95Ms: percentile(observation.durationsMs, 0.95),
			contextChars: observation.contextChars,
			tokens: observation.tokens,
			toolCalls: observation.toolCalls,
			subagents: observation.subagents,
			recallMs: observation.recallMs,
			situationMs: observation.situationMs,
			initiativeMs: observation.initiativeMs,
			cacheWriteTokens: observation.cacheWriteTokens,
			concurrency: observation.concurrency,
			backpressureEvents: observation.backpressureEvents,
		};
		paths[path] = assessment;
		check(failures, path, "P50 latency", assessment.p50Ms, budget.p50Ms);
		check(failures, path, "P95 latency", assessment.p95Ms, budget.p95Ms);
		check(failures, path, "context chars", assessment.contextChars, budget.maxContextChars);
		check(failures, path, "tokens", assessment.tokens, budget.maxTokens);
		check(failures, path, "Tool calls", assessment.toolCalls, budget.maxToolCalls);
		check(failures, path, "Sub-Agents", assessment.subagents, budget.maxSubagents);
		check(failures, path, "recall latency", assessment.recallMs, budget.maxRecallMs);
		check(failures, path, "Situation latency", assessment.situationMs, budget.maxSituationMs);
		check(failures, path, "Initiative latency", assessment.initiativeMs, budget.maxInitiativeMs);
		check(failures, path, "cache-write tokens", assessment.cacheWriteTokens, budget.maxCacheWriteTokens);
		check(failures, path, "concurrency", assessment.concurrency, budget.maxConcurrency);
		check(failures, path, "backpressure events", assessment.backpressureEvents, budget.maxBackpressureEvents);
	}
	return { machineProfileId, passed: failures.length === 0, failures, paths };
}

/** Compares deterministic execution demand independently from machine-dependent latency. */
export function runtimeCostRegressions(current: Record<RuntimePath, RuntimePathAssessment>, baseline: Record<RuntimePath, RuntimePathAssessment>): string[] {
	const failures: string[] = [];
	for (const path of RUNTIME_PATHS) {
		if (!current[path] || !baseline[path]) { failures.push(`${path} cost baseline is missing`); continue; }
		for (const metric of RUNTIME_COST_METRICS) if (current[path][metric] > baseline[path][metric]) failures.push(`${path} ${metric} cost regressed above baseline`);
	}
	return failures;
}

function validateBudget(budget: RuntimePathBudget | undefined, path: RuntimePath): RuntimePathBudget {
	if (!budget) throw new Error(`${path} Runtime budget is required`);
	for (const [key, value] of Object.entries(budget)) finiteNonNegative(value, `${path} ${key}`);
	if (budget.p50Ms > budget.p95Ms) throw new Error(`${path} P50 budget cannot exceed P95`);
	return budget;
}

function validateObservation(observation: RuntimePathObservation | undefined, path: RuntimePath): RuntimePathObservation {
	if (!observation || observation.durationsMs.length < 3) throw new Error(`${path} Runtime observation requires at least three duration samples`);
	for (const [key, value] of Object.entries(observation)) {
		if (key === "durationsMs") continue;
		finiteNonNegative(value as number, `${path} ${key}`);
	}
	return observation;
}

function check(failures: string[], path: RuntimePath, label: string, actual: number, maximum: number): void {
	if (actual > maximum) failures.push(`${path} ${label} exceeded ${maximum}`);
}

function finiteNonNegative(value: number, label: string): number {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
	return value;
}

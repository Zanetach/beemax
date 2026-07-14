import { capabilityDescriptor, type CapabilityDescriptor, type CapabilityRanker, type CapabilityRankingStrategy } from "./capability-runtime.ts";

export interface CapabilityRankingEvaluationCase {
	id: string;
	query: string;
	expected?: string;
	forbidden?: readonly string[];
}

export interface CapabilityRankingEvaluationFailure {
	caseId: string;
	code: "top1_miss" | "topk_miss" | "forbidden_activation" | "unexpected_activation";
	expected?: string;
	observed: string[];
}

export interface CapabilityRankingEvaluationReport {
	strategy: CapabilityRankingStrategy | "unknown";
	cases: number;
	metrics: { top1Accuracy: number; topKRecall: number; forbiddenActivationRate: number; noMatchPrecision: number };
	failures: CapabilityRankingEvaluationFailure[];
}

/** Provider-independent offline quality harness for lexical or semantic Capability rankers. */
export async function evaluateCapabilityRanking(input: {
	ranker: CapabilityRanker;
	inventory: readonly CapabilityDescriptor[];
	cases: readonly CapabilityRankingEvaluationCase[];
	limit?: number;
	activationThreshold?: number;
}): Promise<CapabilityRankingEvaluationReport> {
	if (!input.cases.length) throw new Error("Capability ranking evaluation requires at least one labeled case");
	const ids = new Set<string>();
	for (const scenario of input.cases) { const id = required(scenario.id, "Evaluation case id", 128); if (ids.has(id)) throw new Error(`Duplicate Capability ranking evaluation case id: ${id}`); ids.add(id); }
	const inventory = input.inventory.map(capabilityDescriptor);
	const names = new Set(inventory.map((descriptor) => descriptor.name));
	for (const scenario of input.cases) {
		if (scenario.expected && !names.has(scenario.expected)) throw new Error(`Evaluation case ${scenario.id} expects unknown Capability ${scenario.expected}`);
		for (const forbidden of scenario.forbidden ?? []) if (!names.has(forbidden)) throw new Error(`Evaluation case ${scenario.id} forbids unknown Capability ${forbidden}`);
	}
	const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 5), 100));
	const threshold = Math.max(0, Math.min(1, input.activationThreshold ?? 0.5));
	let expectedCases = 0; let top1 = 0; let topK = 0; let forbiddenCases = 0; let forbiddenActivations = 0; let negativeCases = 0; let quietNegatives = 0;
	const failures: CapabilityRankingEvaluationFailure[] = [];
	const strategies = new Set<CapabilityRankingStrategy>();
	for (const scenario of input.cases) {
		const ranked = await input.ranker.rank(required(scenario.query, "Evaluation query", 2_000), inventory, limit);
		for (const item of ranked) strategies.add(item.explanation.strategy);
		const observed = ranked.filter((item) => item.confidence >= threshold).map((item) => item.descriptor.name);
		if (scenario.expected) {
			expectedCases++;
			if (observed[0] === scenario.expected) top1++; else failures.push({ caseId: scenario.id, code: "top1_miss", expected: scenario.expected, observed });
			if (observed.includes(scenario.expected)) topK++; else failures.push({ caseId: scenario.id, code: "topk_miss", expected: scenario.expected, observed });
		} else {
			negativeCases++;
			if (!observed.length) quietNegatives++; else failures.push({ caseId: scenario.id, code: "unexpected_activation", observed });
		}
		if ((scenario.forbidden?.length ?? 0) > 0) {
			forbiddenCases++;
			if (scenario.forbidden!.some((name) => observed.includes(name))) { forbiddenActivations++; failures.push({ caseId: scenario.id, code: "forbidden_activation", observed }); }
		}
	}
	return {
		strategy: strategies.size === 1 ? [...strategies][0]! : "unknown",
		cases: input.cases.length,
		metrics: { top1Accuracy: expectedCases ? top1 / expectedCases : 1, topKRecall: expectedCases ? topK / expectedCases : 1, forbiddenActivationRate: forbiddenCases ? forbiddenActivations / forbiddenCases : 0, noMatchPrecision: negativeCases ? quietNegatives / negativeCases : 1 },
		failures,
	};
}

function required(value: string, label: string, maxLength: number): string { const normalized = value?.trim(); if (!normalized || normalized.length > maxLength) throw new Error(`${label} must be between 1 and ${maxLength} characters`); return normalized; }

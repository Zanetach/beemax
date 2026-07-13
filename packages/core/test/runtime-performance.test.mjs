import assert from "node:assert/strict";
import test from "node:test";
import { assessRuntimePerformance, percentile, runtimeCostRegressions } from "../dist/index.js";

const budgets = {
	fast: { p50Ms: 10, p95Ms: 25, maxContextChars: 12_000, maxTokens: 12_000, maxToolCalls: 8, maxSubagents: 0, maxRecallMs: 50, maxSituationMs: 25, maxInitiativeMs: 0, maxCacheWriteTokens: 2_000, maxConcurrency: 1, maxBackpressureEvents: 0 },
	deep: { p50Ms: 25, p95Ms: 100, maxContextChars: 12_000, maxTokens: 80_000, maxToolCalls: 40, maxSubagents: 5, maxRecallMs: 250, maxSituationMs: 50, maxInitiativeMs: 0, maxCacheWriteTokens: 8_000, maxConcurrency: 3, maxBackpressureEvents: 0 },
	background: { p50Ms: 50, p95Ms: 250, maxContextChars: 12_000, maxTokens: 8_000, maxToolCalls: 6, maxSubagents: 1, maxRecallMs: 250, maxSituationMs: 50, maxInitiativeMs: 25, maxCacheWriteTokens: 4_000, maxConcurrency: 4, maxBackpressureEvents: 0 },
};

test("runtime performance gate computes P50/P95 and accepts separate path budgets", () => {
	assert.equal(percentile([9, 1, 5, 3, 7], 0.5), 5);
	const observations = Object.fromEntries(Object.entries(budgets).map(([path, budget]) => [path, {
		durationsMs: [1, 2, 3, 4, 5], contextChars: budget.maxContextChars, tokens: budget.maxTokens, toolCalls: budget.maxToolCalls,
		subagents: budget.maxSubagents, recallMs: budget.maxRecallMs, situationMs: budget.maxSituationMs, initiativeMs: budget.maxInitiativeMs,
		cacheWriteTokens: budget.maxCacheWriteTokens, concurrency: budget.maxConcurrency, backpressureEvents: budget.maxBackpressureEvents,
	}]))
	const result = assessRuntimePerformance({ machineProfileId: "test-machine", budgets, observations });
	assert.equal(result.passed, true);
	assert.deepEqual(Object.keys(result.paths), ["fast", "deep", "background"]);
	assert.equal(result.paths.fast.p50Ms, 3);
	assert.equal(result.paths.fast.p95Ms, 5);
});

test("runtime performance gate blocks any latency or execution-cost regression", () => {
	const observations = Object.fromEntries(Object.entries(budgets).map(([path]) => [path, {
		durationsMs: [1, 2, 3], contextChars: 1, tokens: 1, toolCalls: 1, subagents: 0, recallMs: 1, situationMs: 1,
		initiativeMs: 0, cacheWriteTokens: 0, concurrency: 1, backpressureEvents: 0,
	}]))
	observations.deep.tokens = budgets.deep.maxTokens + 1;
	observations.background.backpressureEvents = 1;
	const result = assessRuntimePerformance({ machineProfileId: "test-machine", budgets, observations });
	assert.equal(result.passed, false);
	assert.ok(result.failures.includes("deep tokens exceeded 80000"));
	assert.ok(result.failures.includes("background backpressure events exceeded 0"));
});

test("relative cost baseline blocks regressions that remain under absolute ceilings", () => {
	const baseline = Object.fromEntries(Object.entries(budgets).map(([path]) => [path, {
		samples: 5, p50Ms: 1, p95Ms: 2, contextChars: 100, tokens: 1_000, toolCalls: 2, subagents: 0,
		recallMs: 1, situationMs: 1, initiativeMs: 0, cacheWriteTokens: 10, concurrency: 1, backpressureEvents: 0,
	}]))
	const current = structuredClone(baseline);
	current.deep.contextChars = 101;
	current.background.cacheWriteTokens = 11;
	assert.deepEqual(runtimeCostRegressions(current, baseline), [
		"deep contextChars cost regressed above baseline",
		"background cacheWriteTokens cost regressed above baseline",
	]);
});

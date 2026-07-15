import assert from "node:assert/strict";
import test from "node:test";
import { SemanticCapabilityRanker, evaluateCapabilityRanking } from "../dist/index.js";

const inventory = [
	{ kind: "tool", name: "web_search", description: "Search public web sources", version: "1", activeTools: ["web_search"] },
	{ kind: "mcp", name: "meeting_schedule", description: "Schedule a meeting", version: "1", activeTools: ["mcp_meeting_schedule"] },
	{ kind: "tool", name: "memory_recall", description: "Recall confirmed prior decisions", version: "1", activeTools: ["memory_recall"] },
];

test("Capability ranking evaluation measures semantic Top-1/Top-K recall and forbidden activation from a labeled corpus", async () => {
	const scores = new Map([
		["find fresh evidence online", [{ name: "web_search", similarity: 0.91 }, { name: "memory_recall", similarity: 0.2 }]],
		["book time with the team", [{ name: "meeting_schedule", similarity: 0.87 }]],
		["what did we decide before", [{ name: "memory_recall", similarity: 0.93 }]],
		["just say hello", []],
	]);
	const ranker = new SemanticCapabilityRanker({ similarities: async ({ query }) => scores.get(query) ?? [] });
	const report = await evaluateCapabilityRanking({
		ranker, inventory, limit: 3, activationThreshold: 0.5,
		cases: [
			{ id: "research-en", query: "find fresh evidence online", expected: "web_search", forbidden: ["meeting_schedule"] },
			{ id: "meeting-en", query: "book time with the team", expected: "meeting_schedule", forbidden: ["web_search"] },
			{ id: "memory-en", query: "what did we decide before", expected: "memory_recall" },
			{ id: "negative", query: "just say hello" },
		],
	});
	assert.equal(report.strategy, "semantic");
	assert.equal(report.metrics.top1Accuracy, 1);
	assert.equal(report.metrics.topKRecall, 1);
	assert.equal(report.metrics.forbiddenActivationRate, 0);
	assert.equal(report.metrics.noMatchPrecision, 1);
	assert.deepEqual(report.failures, []);
});

test("Capability ranking evaluation exposes misses instead of hiding them behind aggregate scores", async () => {
	const ranker = new SemanticCapabilityRanker({ similarities: async () => [{ name: "meeting_schedule", similarity: 0.8 }] });
	const report = await evaluateCapabilityRanking({ ranker, inventory, cases: [{ id: "miss", query: "find current evidence", expected: "web_search", forbidden: ["meeting_schedule"] }] });
	assert.equal(report.metrics.top1Accuracy, 0);
	assert.equal(report.metrics.forbiddenActivationRate, 1);
	assert.deepEqual(report.failures.map((failure) => failure.code), ["top1_miss", "topk_miss", "forbidden_activation"]);
});

test("Capability ranking evaluation requires every declared Capability for a multi-capability task", async () => {
	const ranker = new SemanticCapabilityRanker({ similarities: async () => [{ name: "web_search", similarity: 0.9 }] });
	const report = await evaluateCapabilityRanking({ ranker, inventory, cases: [{ id: "multi", query: "research and recall prior decisions", expected: "web_search", required: ["web_search", "memory_recall"] }] });
	assert.equal(report.metrics.top1Accuracy, 1);
	assert.equal(report.metrics.topKRecall, 0);
	assert.deepEqual(report.failures.map((failure) => failure.code), ["topk_miss"]);
});

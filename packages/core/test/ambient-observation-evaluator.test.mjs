import assert from "node:assert/strict";
import test from "node:test";
import { ModelBackedAmbientObservationEvaluator } from "../dist/index.js";

const observation = { text: "The deployment deadline moved to Friday", source: { platform: "feishu", chatId: "group", chatType: "group", messageId: "m1" }, timestamp: 1_000 };

test("Ambient Observation cognition retains a high-value proposal without customer-specific rules", async () => {
	const evaluator = new ModelBackedAmbientObservationEvaluator(async ({ text }) => {
		assert.equal(text, observation.text);
		return { disposition: "retain", relevance: 0.9, credibility: 0.7, expectedValue: 0.85, confidence: 0.8, rationale: "A reported deadline change can affect planned work", action: "Review work affected by the reported deadline", intendedVerification: "Confirm the deadline with an authoritative source" };
	});
	assert.deepEqual(await evaluator.evaluate(observation), {
		disposition: "retain", relevance: 0.9, credibility: 0.7, expectedValue: 0.85, confidence: 0.8,
		rationale: "A reported deadline change can affect planned work", action: "Review work affected by the reported deadline", intendedVerification: "Confirm the deadline with an authoritative source",
	});
});

test("Ambient Observation cognition overrides an unjustified retain decision", async () => {
	const evaluator = new ModelBackedAmbientObservationEvaluator(async () => ({ disposition: "retain", relevance: 0.2, credibility: 0.5, expectedValue: 0.1, confidence: 0.9, rationale: "Social chatter", action: "Read it", intendedVerification: "None" }));
	assert.deepEqual(await evaluator.evaluate(observation), { disposition: "ignore", relevance: 0.2, credibility: 0.5, expectedValue: 0.1, confidence: 0.9, rationale: "Social chatter" });
});

test("Ambient Observation cognition defers safely when inference is unavailable", async () => {
	const evaluator = new ModelBackedAmbientObservationEvaluator(async () => { throw new Error("provider unavailable"); });
	assert.deepEqual(await evaluator.evaluate(observation), { disposition: "defer", relevance: 0, credibility: 0, expectedValue: 0, confidence: 0, rationale: "Ambient Observation evaluation unavailable" });
});

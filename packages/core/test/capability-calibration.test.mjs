import assert from "node:assert/strict";
import test from "node:test";
import { compareCapabilityCalibrations, evaluateCapabilityCalibration } from "../dist/index.js";

const cases = [
	{ id: "research", requiredCapabilities: ["web_search"], forbiddenCapabilities: ["meeting_schedule"] },
	{ id: "meeting", requiredCapabilities: ["meeting_schedule"], forbiddenCapabilities: ["web_search"] },
	{ id: "direct-chat", requiredCapabilities: [] },
];

test("Capability calibration measures ranking, activation, verified completion, latency, tokens, and cost from correlated outcomes", () => {
	const report = evaluateCapabilityCalibration({
		mode: "live_provider", corpusVersion: "unknown-enterprise:v1", threshold: 0.75, cases,
		observations: [
			{ caseId: "research", cognitionId: "cap:1", ranked: [{ name: "web_search", confidence: 0.95 }], activatedCapabilities: ["web_search"], outcome: "accepted", latencyMs: 120, inputTokens: 40, outputTokens: 10, costUsd: 0.02, usageMeasurement: { measuredAttempts: 1, totalAttempts: 1 } },
			{ caseId: "meeting", cognitionId: "cap:2", ranked: [{ name: "meeting_schedule", confidence: 0.9 }], activatedCapabilities: ["meeting_schedule"], outcome: "accepted", latencyMs: 180, inputTokens: 50, outputTokens: 15, costUsd: 0.03, usageMeasurement: { measuredAttempts: 1, totalAttempts: 1 } },
			{ caseId: "direct-chat", cognitionId: "cap:3", ranked: [], activatedCapabilities: [], outcome: "accepted", latencyMs: 60, inputTokens: 20, outputTokens: 10, costUsd: 0.01, usageMeasurement: { measuredAttempts: 1, totalAttempts: 1 } },
		],
	});
	assert.deepEqual(report.metrics, {
		top1Accuracy: 1, topKRecall: 1, requiredCapabilityRecall: 1, forbiddenActivationRate: 0,
		unnecessaryActivationRate: 0, noMatchPrecision: 1, downstreamTaskCompletionRate: 1,
		averageLatencyMs: 120, totalTokens: 145, averageTokens: 145 / 3, totalCostUsd: 0.06, usageMeasurementRate: 1,
	});
	assert.deepEqual(report.failures, []);
});

test("Capability calibration rejects aggregate ranking gains that worsen authorization or task completion", () => {
	const baseline = evaluateCapabilityCalibration({
		mode: "frozen_semantic", corpusVersion: "unknown-enterprise:v1", threshold: 0.8, cases,
		observations: [
			{ caseId: "research", cognitionId: "cap:b1", ranked: [], activatedCapabilities: [], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 5, costUsd: 0 },
			{ caseId: "meeting", cognitionId: "cap:b2", ranked: [{ name: "meeting_schedule", confidence: 0.9 }], activatedCapabilities: ["meeting_schedule"], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 5, costUsd: 0 },
			{ caseId: "direct-chat", cognitionId: "cap:b3", ranked: [], activatedCapabilities: [], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 5, costUsd: 0 },
		],
	});
	const candidate = evaluateCapabilityCalibration({
		mode: "frozen_semantic", corpusVersion: "unknown-enterprise:v1", threshold: 0.7, cases,
		observations: [
			{ caseId: "research", cognitionId: "cap:c1", ranked: [{ name: "web_search", confidence: 0.95 }], activatedCapabilities: ["web_search", "meeting_schedule"], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 5, costUsd: 0 },
			{ caseId: "meeting", cognitionId: "cap:c2", ranked: [{ name: "meeting_schedule", confidence: 0.9 }], activatedCapabilities: ["meeting_schedule"], outcome: "rejected", latencyMs: 100, inputTokens: 10, outputTokens: 5, costUsd: 0 },
			{ caseId: "direct-chat", cognitionId: "cap:c3", ranked: [], activatedCapabilities: [], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 5, costUsd: 0 },
		],
	});
	assert.ok(candidate.metrics.top1Accuracy > baseline.metrics.top1Accuracy);
	const comparison = compareCapabilityCalibrations({ baseline: { version: "rank:v1", report: baseline }, candidate: { version: "rank:v2", report: candidate } });
	assert.equal(comparison.passed, false);
	assert.deepEqual(comparison.failures.map((failure) => failure.code).sort(), ["completion_regression", "forbidden_activation_regression", "unnecessary_activation_regression"]);
});

test("Capability calibration rejects candidates with material latency, token, or cost regressions", () => {
	const observations = [
		{ caseId: "research", cognitionId: "cap:r1", ranked: [{ name: "web_search", confidence: 0.95 }], activatedCapabilities: ["web_search"], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0.01, usageMeasurement: { measuredAttempts: 1, totalAttempts: 1 } },
		{ caseId: "meeting", cognitionId: "cap:r2", ranked: [{ name: "meeting_schedule", confidence: 0.95 }], activatedCapabilities: ["meeting_schedule"], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0.01, usageMeasurement: { measuredAttempts: 1, totalAttempts: 1 } },
		{ caseId: "direct-chat", cognitionId: "cap:r3", ranked: [], activatedCapabilities: [], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0.01, usageMeasurement: { measuredAttempts: 1, totalAttempts: 1 } },
	];
	const baseline = evaluateCapabilityCalibration({ mode: "live_provider", corpusVersion: "unknown-enterprise:v1", threshold: 0.8, cases, observations });
	const candidate = evaluateCapabilityCalibration({
		mode: "live_provider", corpusVersion: "unknown-enterprise:v1", threshold: 0.8, cases,
		observations: observations.map((observation, index) => ({
			...observation,
			cognitionId: `cap:c${index}`,
			latencyMs: 150,
			inputTokens: 12,
			outputTokens: 12,
			costUsd: 0.012,
		})),
	});
	const comparison = compareCapabilityCalibrations({ baseline: { version: "rank:v1", report: baseline }, candidate: { version: "rank:v2", report: candidate } });
	assert.equal(comparison.passed, false);
	assert.deepEqual(comparison.failures.map((failure) => failure.code).sort(), ["cost_regression", "latency_regression", "token_regression"]);
});

test("Capability calibration refuses promotion when any Provider attempt has incomplete cost evidence", () => {
	const observations = [
		{ caseId: "research", cognitionId: "cap:u1", ranked: [{ name: "web_search", confidence: 0.95 }], activatedCapabilities: ["web_search"], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0.01, usageMeasurement: { measuredAttempts: 1, totalAttempts: 2 } },
		{ caseId: "meeting", cognitionId: "cap:u2", ranked: [{ name: "meeting_schedule", confidence: 0.95 }], activatedCapabilities: ["meeting_schedule"], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0.01, usageMeasurement: { measuredAttempts: 1, totalAttempts: 1 } },
		{ caseId: "direct-chat", cognitionId: "cap:u3", ranked: [], activatedCapabilities: [], outcome: "accepted", latencyMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0.01, usageMeasurement: { measuredAttempts: 1, totalAttempts: 1 } },
	];
	const report = evaluateCapabilityCalibration({ mode: "live_provider", corpusVersion: "unknown-enterprise:v1", threshold: 0.8, cases, observations });
	assert.equal(report.metrics.usageMeasurementRate, 0.75);
	const comparison = compareCapabilityCalibrations({ baseline: { version: "rank:v1", report }, candidate: { version: "rank:v2", report } });
	assert.equal(comparison.passed, false);
	assert.ok(comparison.failures.some((failure) => failure.code === "cost_evidence_incomplete"));
});

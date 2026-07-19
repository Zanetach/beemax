import type { CapabilityKind } from "./capability-runtime.ts";
import type { CapabilityOutcomeStatus } from "./execution-trace.ts";

export const CAPABILITY_CALIBRATION_VERSION = "capability-ranking:v1" as const;

export type CapabilityCalibrationMode = "lexical" | "frozen_semantic" | "live_provider";
export interface CapabilityCalibrationCase {
	id: string;
	requiredCapabilities: readonly string[];
	forbiddenCapabilities?: readonly string[];
}
export interface CapabilityCalibrationRank { name: string; confidence: number; kind?: CapabilityKind; }
export interface CapabilityOutcomeObservation {
	caseId: string;
	cognitionId: string;
	routingLane?: "lexical" | "semantic";
	ranked: readonly CapabilityCalibrationRank[];
	activatedCapabilities: readonly string[];
	outcome: CapabilityOutcomeStatus;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	usageMeasurement?: { measuredAttempts: number; totalAttempts: number };
}
export interface CapabilityCalibrationMetrics {
	top1Accuracy: number;
	topKRecall: number;
	requiredCapabilityRecall: number;
	forbiddenActivationRate: number;
	unnecessaryActivationRate: number;
	noMatchPrecision: number;
	downstreamTaskCompletionRate: number;
	averageLatencyMs: number;
	totalTokens: number;
	averageTokens: number;
	totalCostUsd: number;
	usageMeasurementRate: number;
}
export interface CapabilityCalibrationFailure {
	caseId: string;
	code: "top1_miss" | "topk_miss" | "required_capability_miss" | "forbidden_activation" | "unnecessary_activation" | "unexpected_activation" | "incomplete_outcome";
	capabilities?: string[];
}
export interface CapabilityCalibrationReport {
	schemaVersion: 1;
	mode: CapabilityCalibrationMode;
	corpusVersion: string;
	threshold: number;
	cases: number;
	metrics: CapabilityCalibrationMetrics;
	failures: CapabilityCalibrationFailure[];
}
export interface CapabilityCalibrationComparisonFailure {
	code: "mode_mismatch" | "corpus_mismatch" | "version_not_advanced" | "top1_regression" | "topk_regression" | "required_recall_regression" | "forbidden_activation_regression" | "unnecessary_activation_regression" | "no_match_regression" | "completion_regression" | "latency_regression" | "token_regression" | "cost_regression" | "usage_measurement_regression" | "cost_evidence_incomplete";
	baseline?: number | string;
	candidate?: number | string;
}

export interface CapabilityCalibrationRegressionBudget {
	latencyRelative: number;
	latencyAbsoluteMs: number;
	resourceRelative: number;
}

export const DEFAULT_CAPABILITY_CALIBRATION_REGRESSION_BUDGET: Readonly<CapabilityCalibrationRegressionBudget> = Object.freeze({
	latencyRelative: 0.2,
	latencyAbsoluteMs: 5,
	resourceRelative: 0.05,
});

/** Computes outcome-bound quality without using request text or enterprise vocabulary. */
export function evaluateCapabilityCalibration(input: {
	mode: CapabilityCalibrationMode;
	corpusVersion: string;
	threshold: number;
	cases: readonly CapabilityCalibrationCase[];
	observations: readonly CapabilityOutcomeObservation[];
}): CapabilityCalibrationReport {
	if (!input.cases.length || input.cases.length > 10_000) throw new Error("Capability calibration requires a bounded non-empty corpus");
	const mode = validMode(input.mode); const corpusVersion = safeId(input.corpusVersion, "corpus version", 128);
	const threshold = bounded(input.threshold, "threshold", 0, 1);
	const cases = new Map<string, { required: string[]; forbidden: string[] }>();
	for (const scenario of input.cases) {
		const id = safeId(scenario.id, "case id", 128); if (cases.has(id)) throw new Error(`Duplicate Capability calibration case id: ${id}`);
		const required = uniqueNames(scenario.requiredCapabilities, "required capabilities");
		const forbidden = uniqueNames(scenario.forbiddenCapabilities ?? [], "forbidden capabilities");
		if (required.some((name) => forbidden.includes(name))) throw new Error(`Capability calibration case ${id} both requires and forbids one Capability`);
		cases.set(id, { required, forbidden });
	}
	if (input.observations.length !== cases.size) throw new Error("Capability calibration requires exactly one outcome observation per case");
	const observations = new Map<string, CapabilityOutcomeObservation>(); const cognitionIds = new Set<string>();
	for (const observation of input.observations) {
		const caseId = safeId(observation.caseId, "observation case id", 128); if (!cases.has(caseId) || observations.has(caseId)) throw new Error(`Capability calibration observation is unknown or duplicated: ${caseId}`);
		const cognitionId = safeId(observation.cognitionId, "cognition id", 128); if (cognitionIds.has(cognitionId)) throw new Error(`Duplicate Capability cognition identity: ${cognitionId}`); cognitionIds.add(cognitionId);
		observations.set(caseId, observation);
	}
	let positiveCases = 0; let top1 = 0; let allRequiredCases = 0; let requiredTotal = 0; let requiredFound = 0;
	let forbiddenCases = 0; let forbiddenActivations = 0; let activations = 0; let unnecessary = 0; let negativeCases = 0; let quietNegatives = 0; let accepted = 0;
	let latency = 0; let tokens = 0; let cost = 0; let measuredAttempts = 0; let totalAttempts = 0; const failures: CapabilityCalibrationFailure[] = [];
	for (const [caseId, labels] of cases) {
		const observation = observations.get(caseId)!;
		const ranked = validRanks(observation.ranked).filter((rank) => rank.confidence >= threshold);
		const observed = ranked.map((rank) => rank.name); const activated = uniqueNames(observation.activatedCapabilities, "activated capabilities");
		if (labels.required.length) {
			positiveCases++; requiredTotal += labels.required.length;
			if (labels.required.includes(observed[0] ?? "")) top1++; else failures.push({ caseId, code: "top1_miss", capabilities: observed });
			const found = labels.required.filter((name) => observed.includes(name)); requiredFound += found.length;
			if (found.length === labels.required.length) allRequiredCases++; else {
				failures.push({ caseId, code: "topk_miss", capabilities: observed });
				failures.push({ caseId, code: "required_capability_miss", capabilities: labels.required.filter((name) => !found.includes(name)) });
			}
		} else {
			negativeCases++; if (!activated.length) quietNegatives++; else failures.push({ caseId, code: "unexpected_activation", capabilities: activated });
		}
		if (labels.forbidden.length) {
			forbiddenCases++; const violated = labels.forbidden.filter((name) => activated.includes(name));
			if (violated.length) { forbiddenActivations++; failures.push({ caseId, code: "forbidden_activation", capabilities: violated }); }
		}
		activations += activated.length; const extra = activated.filter((name) => !labels.required.includes(name)); unnecessary += extra.length;
		if (extra.length && labels.required.length) failures.push({ caseId, code: "unnecessary_activation", capabilities: extra });
		if (observation.outcome === "accepted") accepted++; else failures.push({ caseId, code: "incomplete_outcome" });
		latency += nonNegative(observation.latencyMs, "latencyMs");
		tokens += nonNegative(observation.inputTokens, "inputTokens") + nonNegative(observation.outputTokens, "outputTokens");
		cost += nonNegative(observation.costUsd, "costUsd");
		if (mode === "live_provider" && !observation.usageMeasurement) throw new Error(`Live Capability calibration observation ${caseId} requires usage measurement evidence`);
		const measurement = observation.usageMeasurement ?? { measuredAttempts: 0, totalAttempts: 0 };
			const measured = nonNegativeInteger(measurement.measuredAttempts, "measured usage attempts");
			const total = nonNegativeInteger(measurement.totalAttempts, "total usage attempts");
			if (measured > total) throw new Error("Capability calibration measured usage attempts cannot exceed total attempts");
			if (mode === "live_provider") {
				if (observation.routingLane !== "lexical" && observation.routingLane !== "semantic") throw new Error(`Live Capability calibration observation ${caseId} requires a valid routing lane`);
				if (observation.routingLane === "semantic" && total === 0) throw new Error(`Live Capability calibration semantic observation ${caseId} requires at least one Provider attempt`);
				if (observation.routingLane === "lexical" && total !== 0) throw new Error(`Live Capability calibration deterministic observation ${caseId} must not claim Provider attempts`);
			}
		measuredAttempts += measured; totalAttempts += total;
	}
	const count = cases.size;
	return {
		schemaVersion: 1, mode, corpusVersion, threshold, cases: count,
		metrics: {
			top1Accuracy: positiveCases ? top1 / positiveCases : 1,
			topKRecall: positiveCases ? allRequiredCases / positiveCases : 1,
			requiredCapabilityRecall: requiredTotal ? requiredFound / requiredTotal : 1,
			forbiddenActivationRate: forbiddenCases ? forbiddenActivations / forbiddenCases : 0,
			unnecessaryActivationRate: activations ? unnecessary / activations : 0,
			noMatchPrecision: negativeCases ? quietNegatives / negativeCases : 1,
			downstreamTaskCompletionRate: accepted / count,
			averageLatencyMs: latency / count,
			totalTokens: tokens, averageTokens: tokens / count, totalCostUsd: rounded(cost), usageMeasurementRate: totalAttempts ? measuredAttempts / totalAttempts : 1,
		}, failures,
	};
}

/** A ranking change is promotable only when identity, safety, false-positive and completion gates do not regress. */
export function compareCapabilityCalibrations(input: {
	baseline: { version: string; report: CapabilityCalibrationReport };
	candidate: { version: string; report: CapabilityCalibrationReport };
	regressionBudget?: CapabilityCalibrationRegressionBudget;
}): { passed: boolean; failures: CapabilityCalibrationComparisonFailure[] } {
	const baselineVersion = safeId(input.baseline.version, "baseline version", 128); const candidateVersion = safeId(input.candidate.version, "candidate version", 128);
	const baseline = input.baseline.report; const candidate = input.candidate.report; const failures: CapabilityCalibrationComparisonFailure[] = [];
	if (baseline.mode !== candidate.mode) failures.push({ code: "mode_mismatch", baseline: baseline.mode, candidate: candidate.mode });
	if (baseline.corpusVersion !== candidate.corpusVersion || baseline.cases !== candidate.cases) failures.push({ code: "corpus_mismatch", baseline: `${baseline.corpusVersion}:${baseline.cases}`, candidate: `${candidate.corpusVersion}:${candidate.cases}` });
	if (baselineVersion === candidateVersion) failures.push({ code: "version_not_advanced", baseline: baselineVersion, candidate: candidateVersion });
	const lowerIsRegression = (code: CapabilityCalibrationComparisonFailure["code"], left: number, right: number) => { if (right < left) failures.push({ code, baseline: left, candidate: right }); };
	const higherIsRegression = (code: CapabilityCalibrationComparisonFailure["code"], left: number, right: number) => { if (right > left) failures.push({ code, baseline: left, candidate: right }); };
	lowerIsRegression("top1_regression", baseline.metrics.top1Accuracy, candidate.metrics.top1Accuracy);
	lowerIsRegression("topk_regression", baseline.metrics.topKRecall, candidate.metrics.topKRecall);
	lowerIsRegression("required_recall_regression", baseline.metrics.requiredCapabilityRecall, candidate.metrics.requiredCapabilityRecall);
	higherIsRegression("forbidden_activation_regression", baseline.metrics.forbiddenActivationRate, candidate.metrics.forbiddenActivationRate);
	higherIsRegression("unnecessary_activation_regression", baseline.metrics.unnecessaryActivationRate, candidate.metrics.unnecessaryActivationRate);
	lowerIsRegression("no_match_regression", baseline.metrics.noMatchPrecision, candidate.metrics.noMatchPrecision);
	lowerIsRegression("completion_regression", baseline.metrics.downstreamTaskCompletionRate, candidate.metrics.downstreamTaskCompletionRate);
	lowerIsRegression("usage_measurement_regression", baseline.metrics.usageMeasurementRate, candidate.metrics.usageMeasurementRate);
	if (candidate.metrics.usageMeasurementRate < 1) failures.push({ code: "cost_evidence_incomplete", baseline: 1, candidate: candidate.metrics.usageMeasurementRate });
	const budget = validRegressionBudget(input.regressionBudget ?? DEFAULT_CAPABILITY_CALIBRATION_REGRESSION_BUDGET);
	const latencyLimit = baseline.metrics.averageLatencyMs * (1 + budget.latencyRelative) + budget.latencyAbsoluteMs;
	if (candidate.metrics.averageLatencyMs > latencyLimit) failures.push({ code: "latency_regression", baseline: baseline.metrics.averageLatencyMs, candidate: candidate.metrics.averageLatencyMs });
	const tokensLimit = baseline.metrics.totalTokens * (1 + budget.resourceRelative);
	if (candidate.metrics.totalTokens > tokensLimit) failures.push({ code: "token_regression", baseline: baseline.metrics.totalTokens, candidate: candidate.metrics.totalTokens });
	const costLimit = baseline.metrics.totalCostUsd * (1 + budget.resourceRelative);
	if (candidate.metrics.totalCostUsd > costLimit) failures.push({ code: "cost_regression", baseline: baseline.metrics.totalCostUsd, candidate: candidate.metrics.totalCostUsd });
	return { passed: failures.length === 0, failures };
}

function validMode(value: CapabilityCalibrationMode): CapabilityCalibrationMode { if (value !== "lexical" && value !== "frozen_semantic" && value !== "live_provider") throw new Error("Capability calibration mode is invalid"); return value; }
function validRanks(values: readonly CapabilityCalibrationRank[]): CapabilityCalibrationRank[] {
	if (!Array.isArray(values) || values.length > 100) throw new Error("Capability calibration ranks must be a bounded list");
	const names = new Set<string>(); return values.map((rank) => { const name = safeId(rank.name, "ranked Capability", 128); if (names.has(name)) throw new Error(`Duplicate ranked Capability: ${name}`); names.add(name); return { name, confidence: bounded(rank.confidence, "confidence", 0, 1), ...(rank.kind ? { kind: rank.kind } : {}) }; });
}
function uniqueNames(values: readonly string[], label: string): string[] { if (!Array.isArray(values) || values.length > 100) throw new Error(`Capability calibration ${label} must be bounded`); const names = values.map((value) => safeId(value, label, 128)); if (new Set(names).size !== names.length) throw new Error(`Capability calibration ${label} contain duplicates`); return names; }
function safeId(value: string, label: string, max: number): string { const normalized = value?.trim(); if (!normalized || normalized.length > max || !/^[a-z0-9][a-z0-9._:-]*$/i.test(normalized)) throw new Error(`Capability calibration ${label} is invalid`); return normalized; }
function bounded(value: number, label: string, min: number, max: number): number { if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Capability calibration ${label} is invalid`); return value; }
function nonNegative(value: number, label: string): number { return bounded(value, label, 0, Number.MAX_SAFE_INTEGER); }
function nonNegativeInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Capability calibration ${label} is invalid`); return value; }
function validRegressionBudget(value: CapabilityCalibrationRegressionBudget): CapabilityCalibrationRegressionBudget {
	return {
		latencyRelative: bounded(value.latencyRelative, "latency regression budget", 0, 10),
		latencyAbsoluteMs: bounded(value.latencyAbsoluteMs, "absolute latency regression budget", 0, 60_000),
		resourceRelative: bounded(value.resourceRelative, "resource regression budget", 0, 10),
	};
}
function rounded(value: number): number { return Math.round(value * 1e12) / 1e12; }

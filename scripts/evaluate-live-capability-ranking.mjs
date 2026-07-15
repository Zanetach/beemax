#!/usr/bin/env node
import { CAPABILITY_CALIBRATION_VERSION, evaluateCapabilityRanking, SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY } from "../packages/core/dist/index.js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../apps/cli/dist/config.js";
import { configuredAuxiliaryTextModels, configuredCapabilityRanker } from "../apps/cli/dist/model-catalog.js";
import { capabilityInventory, capabilityRankingCases } from "../evals/capability-ranking-corpus.mjs";
import { liveCapabilityImplementationDigest } from "./capability-ranking-evidence.mjs";
import { executeCalibrationThresholdTrials, executeCapabilityAuthorityProbe, executeOutcomeBoundCapabilityRun } from "./capability-outcome-harness.mjs";

const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1]?.trim() : process.env.BEEMAX_PROFILE?.trim();
if (!profile) throw new Error("Live Capability ranking evaluation requires --profile <name> or BEEMAX_PROFILE");

const config = loadConfig(undefined, profile);
const models = configuredAuxiliaryTextModels(config);
if (!models.length) throw new Error(`Profile ${profile} has no configured, authenticated text model for live semantic evaluation`);

const fallbackQueries = [];
const cognitionAttempts = [];
const observedRankings = [];
const caseByCognitionId = new Map();
const baseRanker = configuredCapabilityRanker(
	models,
	(usage) => cognitionAttempts.push({ caseId: usage.cognitionId ? caseByCognitionId.get(usage.cognitionId) ?? "unknown" : "unknown", ...usage }),
	({ query }) => fallbackQueries.push(query),
	config.agent.capabilityCognition,
);
const observedRanker = {
	async rank(query, inventory, limit, signal, context) {
		const caseId = capabilityRankingCases.find((scenario) => scenario.query === query)?.id ?? "unknown";
		if (context?.cognitionId) caseByCognitionId.set(context.cognitionId, caseId);
		const ranked = await baseRanker.rank(query, inventory, limit, signal, context);
		observedRankings.push({ caseId, cognitionId: context?.cognitionId ?? "eval:unknown", candidates: ranked.map((item) => ({ kind: item.descriptor.kind, name: item.descriptor.name, version: item.descriptor.version, confidence: item.confidence, strategy: item.explanation.strategy })) });
		return ranked;
	},
};
const report = await evaluateCapabilityRanking({
	ranker: observedRanker,
	inventory: capabilityInventory,
	cases: capabilityRankingCases,
	limit: 5,
	activationThreshold: SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY,
});
const failures = [];
const outcomeExecution = await executeOutcomeBoundCapabilityRun({ mode: "live_provider", threshold: SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY, observedRankings, cognitionAttempts });
const calibration = outcomeExecution.report;
const calibrationTrials = await executeCalibrationThresholdTrials({ baselineVersion: CAPABILITY_CALIBRATION_VERSION, baseline: calibration, thresholds: [0.8, 0.9, 0.99], observedRankings, cognitionAttempts });
const authorityProbe = await executeCapabilityAuthorityProbe();
if (report.strategy !== "semantic") failures.push(`Live Capability evaluation did not exclusively observe semantic rankings (strategy=${report.strategy})`);
if (fallbackQueries.length) failures.push(`Live Capability evaluation used lexical fallback for ${fallbackQueries.length} case(s)`);
if (report.metrics.top1Accuracy < 0.85) failures.push("Live semantic Capability Top-1 accuracy is below 0.85");
if (report.metrics.topKRecall < 0.95) failures.push("Live semantic Capability Top-K recall is below 0.95");
if (report.metrics.forbiddenActivationRate > 0) failures.push("Live semantic Capability ranking activated a forbidden candidate");
if (report.metrics.noMatchPrecision < 1) failures.push("Live semantic Capability ranking forced a match for a negative case");
if (calibration.metrics.requiredCapabilityRecall < 0.95) failures.push("Live semantic required-Capability recall is below 0.95");
if (calibration.metrics.unnecessaryActivationRate > 0 || calibration.metrics.forbiddenActivationRate > 0) failures.push("Live semantic Capability routing produced unnecessary or forbidden activation");
if (calibration.metrics.downstreamTaskCompletionRate < 0.95) failures.push("Live semantic downstream task completion is below 0.95");
if (calibration.metrics.usageMeasurementRate !== 1) failures.push("Live semantic cost evidence is incomplete");

const artifact = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	profile,
	models: models.map(({ model }) => `${model.provider}/${model.id}`),
	implementationDigest: await liveCapabilityImplementationDigest(),
	threshold: SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY,
	calibrationVersion: CAPABILITY_CALIBRATION_VERSION,
	fallbackCases: fallbackQueries.map((query) => capabilityRankingCases.find((scenario) => scenario.query === query)?.id ?? "unknown"),
	cognitionAttempts,
	observedRankings,
	report,
	calibration,
	taskReceipts: outcomeExecution.receipts,
	calibrationTrials,
	authorityProbe,
	gate: { passed: failures.length === 0, failures },
};
const writeIndex = args.indexOf("--write");
if (writeIndex >= 0) {
	const path = args[writeIndex + 1]?.trim();
	if (!path) throw new Error("--write requires an artifact path");
	await writeFile(resolve(path), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

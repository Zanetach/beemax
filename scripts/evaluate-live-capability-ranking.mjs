#!/usr/bin/env node
import { AuthStorage, CAPABILITY_CALIBRATION_VERSION, evaluateCapabilityRanking, SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY } from "../packages/core/dist/index.js";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../apps/cli/dist/config.js";
import { configuredCapabilityRanker, resolveProfileCognitionModels } from "../apps/cli/dist/model-catalog.js";
import { capabilityInventory, capabilityRankingCases } from "../evals/capability-ranking-corpus.mjs";
import { liveCapabilityImplementationDigest } from "./capability-ranking-evidence.mjs";
import { executeCalibrationThresholdTrials, executeCapabilityAuthorityProbe, executeOutcomeBoundCapabilityRun } from "./capability-outcome-harness.mjs";
import { executeLivePiCapabilityOutcomeRun } from "./pi-capability-outcome-harness.mjs";

const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1]?.trim() : process.env.BEEMAX_PROFILE?.trim();
if (!profile) throw new Error("Live Capability ranking evaluation requires --profile <name> or BEEMAX_PROFILE");
const piConcurrencyIndex = args.indexOf("--pi-concurrency");
const piConcurrencyValue = piConcurrencyIndex >= 0 ? Number(args[piConcurrencyIndex + 1]) : 2;
if (!Number.isSafeInteger(piConcurrencyValue) || piConcurrencyValue < 1 || piConcurrencyValue > 8) throw new Error("--pi-concurrency must be an integer from 1 to 8");

const config = loadConfig(undefined, profile);
const profileAuth = AuthStorage.create(join(config.paths.agentDir, "auth.json"));
const profileCognitionModels = await resolveProfileCognitionModels(config, async (provider) => {
	return profileAuth.getApiKey(provider, { includeFallback: false });
});
const models = [];
for (const candidate of profileCognitionModels) {
	const apiKey = candidate.apiKey ?? await candidate.getApiKey?.();
	if (apiKey) models.push({ model: candidate.model, apiKey });
}
if (!models.length) throw new Error(`Profile ${profile} has no configured, authenticated text model for live semantic evaluation`);

const fallbackQueries = [];
const cognitionAttempts = [];
const observedRankings = [];
const caseByCognitionId = new Map();
// Exercise the exact production composition: decisive local metadata takes the
// deterministic fast path, while ambiguous and negative cases must traverse the
// real model-backed semantic lane and retain measured Provider usage.
const baseRanker = configuredCapabilityRanker(
	models,
	(usage) => cognitionAttempts.push({ caseId: usage.cognitionId ? caseByCognitionId.get(usage.cognitionId) ?? "unknown" : "unknown", ...usage }),
	{
		...config.agent.capabilityCognition,
		onFallback: ({ query }) => fallbackQueries.push(query),
	},
);
const observedRanker = {
	async rank(query, inventory, limit, signal, context) {
		const caseId = capabilityRankingCases.find((scenario) => scenario.query === query)?.id ?? "unknown";
		if (context?.cognitionId) caseByCognitionId.set(context.cognitionId, caseId);
		const attemptsBefore = cognitionAttempts.length;
		let ranked;
		try { ranked = await baseRanker.rank(query, inventory, limit, signal, context); }
		catch (error) { throw new Error(`Live Capability ranking failed for case ${caseId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
		const strategy = cognitionAttempts.length > attemptsBefore ? "semantic" : "lexical";
		observedRankings.push({ caseId, cognitionId: context?.cognitionId ?? "eval:unknown", strategy, candidates: ranked.map((item) => ({ kind: item.descriptor.kind, name: item.descriptor.name, version: item.descriptor.version, confidence: item.confidence, strategy: item.explanation.strategy })) });
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
const piOutcome = await executeLivePiCapabilityOutcomeRun({
	models: profileCognitionModels,
	threshold: SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY,
	observedRankings,
	concurrency: piConcurrencyValue,
});
if (report.strategy !== "progressive") failures.push(`Live Capability evaluation did not observe both production progressive lanes (strategy=${report.strategy})`);
if (!observedRankings.some((ranking) => ranking.strategy === "lexical") || !observedRankings.some((ranking) => ranking.strategy === "semantic")) failures.push("Live Capability evaluation did not exercise both deterministic and model-backed routing lanes");
if (fallbackQueries.length) failures.push(`Live Capability evaluation used lexical fallback for ${fallbackQueries.length} case(s)`);
if (report.metrics.top1Accuracy < 0.85) failures.push("Live progressive Capability Top-1 accuracy is below 0.85");
if (report.metrics.topKRecall < 0.95) failures.push("Live progressive Capability Top-K recall is below 0.95");
if (report.metrics.forbiddenActivationRate > 0) failures.push("Live progressive Capability ranking activated a forbidden candidate");
if (report.metrics.noMatchPrecision < 1) failures.push("Live progressive Capability ranking forced a match for a negative case");
if (calibration.metrics.requiredCapabilityRecall < 0.95) failures.push("Live progressive required-Capability recall is below 0.95");
if (calibration.metrics.unnecessaryActivationRate > 0 || calibration.metrics.forbiddenActivationRate > 0) failures.push("Live progressive Capability routing produced unnecessary or forbidden activation");
if (calibration.metrics.downstreamTaskCompletionRate < 0.95) failures.push("Live progressive downstream task completion is below 0.95");
if (piOutcome.accepted / piOutcome.cases < 0.95) failures.push("Live Pi Tool Spec outcome completion is below 0.95");
if (piOutcome.evidenceFailures.length) failures.push(`Live Pi Provider evidence failed: ${piOutcome.evidenceFailures.join(", ")}`);
if (piOutcome.admissionFailures.length) failures.push(`Live Pi model-first admission failed: ${piOutcome.admissionFailures.join(", ")}`);

const artifact = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	profile,
	rankingMode: "production_progressive",
	models: models.map(({ model }) => `${model.provider}/${model.id}`),
	implementationDigest: await liveCapabilityImplementationDigest(),
	threshold: SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY,
	calibrationVersion: CAPABILITY_CALIBRATION_VERSION,
	piConcurrency: piConcurrencyValue,
	fallbackCases: fallbackQueries.map((query) => capabilityRankingCases.find((scenario) => scenario.query === query)?.id ?? "unknown"),
	cognitionAttempts,
	observedRankings,
	report,
	calibration,
	taskReceipts: outcomeExecution.receipts,
	calibrationTrials,
	authorityProbe,
	piOutcome,
	gate: { passed: failures.length === 0, failures },
};
const writeIndex = args.indexOf("--write");
if (writeIndex >= 0) {
	const path = args[writeIndex + 1]?.trim();
	if (!path) throw new Error("--write requires an artifact path");
	await writeFile(resolve(path), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
if (!args.includes("--quiet")) process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

#!/usr/bin/env node
import { AuthStorage, CAPABILITY_CALIBRATION_VERSION, evaluateCapabilityRanking, PiWorkContractBuilder, SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY } from "../packages/core/dist/index.js";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createHash } from "node:crypto";
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

const config = loadConfig(undefined, profile);
const profileAuth = AuthStorage.create(join(config.paths.agentDir, "auth.json"));
const profileCognitionModels = await resolveProfileCognitionModels(config, async (provider) => {
	return profileAuth.getApiKey(provider, { includeFallback: false });
});
// The release gate deliberately keeps credential lookup dynamic even for a
// statically configured key, so every receipt proves the same just-in-time
// credential boundary used by short-lived OAuth tokens.
const credentialResolutionEvents = [];
const liveCognitionModels = profileCognitionModels.map((candidate) => ({
	model: candidate.model,
	getApiKey: async () => {
		credentialResolutionEvents.push({
			provider: candidate.model.provider,
			modelIdentity: `${candidate.model.provider}/${candidate.model.id}/${candidate.model.api}`,
			source: candidate.apiKey ? "profile_config" : "profile_auth_storage",
		});
		return candidate.apiKey ?? await candidate.getApiKey?.();
	},
}));
const models = [];
for (const candidate of liveCognitionModels) {
	const apiKey = await candidate.getApiKey();
	if (apiKey) models.push({ model: candidate.model, apiKey });
}
if (!models.length) throw new Error(`Profile ${profile} has no configured, authenticated text model for live semantic evaluation`);
const workContractProviderTurns = [];
const workContractBuilder = new PiWorkContractBuilder({
	models: liveCognitionModels,
	complete: async (model, context, options) => {
		const response = await completeSimple(model, context, options);
		const modelIdentity = `${model.provider}/${model.id}/${model.api}`;
		const lane = context.systemPrompt.includes("Independently inventory") ? "semantic_inventory" : "work_contract";
		const usage = {
			inputTokens: finiteNonnegative(response.usage?.input), outputTokens: finiteNonnegative(response.usage?.output),
			cacheReadTokens: finiteNonnegative(response.usage?.cacheRead), cacheWriteTokens: finiteNonnegative(response.usage?.cacheWrite),
			costUsd: finiteNonnegative(response.usage?.cost?.total),
		};
		const providerResponseIdentitySha256 = `sha256:${createHash("sha256").update(JSON.stringify({ modelIdentity, lane, stopReason: response.stopReason, content: response.content, usage })).digest("hex")}`;
		workContractProviderTurns.push({ modelIdentity, lane, providerResponseIdentitySha256, ...usage });
		return response;
	},
});

const fallbackQueries = [];
const cognitionAttempts = [];
const observedRankings = [];
const caseByCognitionId = new Map();
const baseRanker = configuredCapabilityRanker(
	models,
	(usage) => cognitionAttempts.push({ caseId: usage.cognitionId ? caseByCognitionId.get(usage.cognitionId) ?? "unknown" : "unknown", ...usage }),
	config.agent.capabilityCognition,
);
const observedRanker = {
	async rank(query, inventory, limit, signal, context) {
		const caseId = capabilityRankingCases.find((scenario) => scenario.query === query)?.id ?? "unknown";
		if (context?.cognitionId) caseByCognitionId.set(context.cognitionId, caseId);
		let ranked;
		try { ranked = await baseRanker.rank(query, inventory, limit, signal, context); }
		catch (error) { throw new Error(`Live Capability ranking failed for case ${caseId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
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
const piOutcome = await executeLivePiCapabilityOutcomeRun({
	models: liveCognitionModels,
	threshold: SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY,
	observedRankings,
	workContractBuilder,
	getCredentialResolutionEvents: () => credentialResolutionEvents.map((event) => ({ ...event })),
	getWorkContractProviderTurns: () => workContractProviderTurns.map((turn) => ({ ...turn })),
});
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
if (piOutcome.accepted / piOutcome.cases < 0.95) failures.push("Live Pi Tool Spec outcome completion is below 0.95");
if (piOutcome.budgetFailures.length) failures.push(`Live Pi execution budget failed: ${piOutcome.budgetFailures.join(", ")}`);
if (piOutcome.workContractFailures.length) failures.push(`Live Pi production Work Contract composition failed: ${piOutcome.workContractFailures.join(", ")}`);

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
	piOutcome,
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

function finiteNonnegative(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }

#!/usr/bin/env node
import { evaluateCapabilityRanking, SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY } from "../packages/core/dist/index.js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../apps/cli/dist/config.js";
import { configuredAuxiliaryTextModels, configuredCapabilityRanker } from "../apps/cli/dist/model-catalog.js";
import { capabilityInventory, capabilityRankingCases } from "../evals/capability-ranking-corpus.mjs";
import { liveCapabilityImplementationDigest } from "./capability-ranking-evidence.mjs";

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
let activeQuery;
const baseRanker = configuredCapabilityRanker(
	models,
	(usage) => cognitionAttempts.push({ caseId: capabilityRankingCases.find((scenario) => scenario.query === activeQuery)?.id ?? "unknown", ...usage }),
	({ query }) => fallbackQueries.push(query),
);
const observedRanker = {
	async rank(query, inventory, limit, signal) {
		activeQuery = query;
		try {
			const ranked = await baseRanker.rank(query, inventory, limit, signal);
			observedRankings.push({ caseId: capabilityRankingCases.find((scenario) => scenario.query === query)?.id ?? "unknown", candidates: ranked.map((item) => ({ name: item.descriptor.name, confidence: item.confidence, strategy: item.explanation.strategy })) });
			return ranked;
		}
		finally { activeQuery = undefined; }
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
if (report.strategy !== "semantic") failures.push(`Live Capability evaluation did not exclusively observe semantic rankings (strategy=${report.strategy})`);
if (fallbackQueries.length) failures.push(`Live Capability evaluation used lexical fallback for ${fallbackQueries.length} case(s)`);
if (report.metrics.top1Accuracy < 0.85) failures.push("Live semantic Capability Top-1 accuracy is below 0.85");
if (report.metrics.topKRecall < 0.95) failures.push("Live semantic Capability Top-K recall is below 0.95");
if (report.metrics.forbiddenActivationRate > 0) failures.push("Live semantic Capability ranking activated a forbidden candidate");
if (report.metrics.noMatchPrecision < 1) failures.push("Live semantic Capability ranking forced a match for a negative case");

const artifact = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	profile,
	models: models.map(({ model }) => `${model.provider}/${model.id}`),
	implementationDigest: await liveCapabilityImplementationDigest(),
	threshold: SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY,
	fallbackCases: fallbackQueries.map((query) => capabilityRankingCases.find((scenario) => scenario.query === query)?.id ?? "unknown"),
	cognitionAttempts,
	observedRankings,
	report,
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

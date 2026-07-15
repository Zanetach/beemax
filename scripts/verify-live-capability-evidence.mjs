#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY } from "../packages/core/dist/index.js";
import { capabilityInventory, capabilityRankingCases } from "../evals/capability-ranking-corpus.mjs";
import { liveCapabilityImplementationDigest } from "./capability-ranking-evidence.mjs";

const path = resolve(process.argv[2] || "evals/baselines/capability-ranking-live.json");
const artifact = JSON.parse(await readFile(path, "utf8"));
const failures = [];
if (artifact?.schemaVersion !== 1) failures.push("live semantic evidence schema is invalid");
if (artifact?.implementationDigest !== await liveCapabilityImplementationDigest()) failures.push("live semantic evidence does not match the current implementation and corpus");
if (!artifact?.gate?.passed || artifact?.gate?.failures?.length) failures.push("live semantic evidence gate did not pass");
if (artifact?.report?.strategy !== "semantic") failures.push("live semantic evidence did not exclusively use semantic ranking");
if (!Array.isArray(artifact?.fallbackCases) || artifact.fallbackCases.length) failures.push("live semantic evidence contains lexical fallback cases or lacks fallback attestation");
if (!Array.isArray(artifact?.models) || !artifact.models.length) failures.push("live semantic evidence has no concrete model identity");
if (artifact?.threshold !== SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY) failures.push("live semantic evidence threshold does not match the production threshold");
const generatedAt = Date.parse(artifact?.generatedAt);
if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > 30 * 24 * 60 * 60_000 || generatedAt > Date.now() + 5 * 60_000) failures.push("live semantic evidence is missing, expired, or future-dated");
if (artifact?.report?.metrics?.top1Accuracy < 0.85 || artifact?.report?.metrics?.topKRecall < 0.95 || artifact?.report?.metrics?.forbiddenActivationRate !== 0 || artifact?.report?.metrics?.noMatchPrecision !== 1) failures.push("live semantic evidence metrics are below the release gate");

const knownCapabilities = new Set(capabilityInventory.map((candidate) => candidate.name));
const knownCases = new Map(capabilityRankingCases.map((scenario) => [scenario.id, scenario]));
const rankings = Array.isArray(artifact?.observedRankings) ? artifact.observedRankings : [];
const rankingByCase = new Map();
for (const ranking of rankings) {
	if (!knownCases.has(ranking?.caseId) || rankingByCase.has(ranking.caseId) || !Array.isArray(ranking?.candidates)) { failures.push("live semantic evidence has unknown, duplicate, or malformed case rankings"); continue; }
	const candidates = [];
	for (const candidate of ranking.candidates) {
		if (!knownCapabilities.has(candidate?.name) || candidate?.strategy !== "semantic" || !Number.isFinite(candidate?.confidence) || candidate.confidence < artifact.threshold || candidate.confidence > 1) { failures.push(`live semantic evidence has an invalid observed candidate for ${ranking.caseId}`); continue; }
		candidates.push(candidate.name);
	}
	rankingByCase.set(ranking.caseId, candidates);
}
if (rankingByCase.size !== capabilityRankingCases.length) failures.push("live semantic evidence does not contain exactly one ranking for every corpus case");

let expectedCases = 0; let top1 = 0; let topK = 0; let forbiddenCases = 0; let forbiddenActivations = 0; let negativeCases = 0; let quietNegatives = 0;
for (const scenario of capabilityRankingCases) {
	const observed = rankingByCase.get(scenario.id) ?? [];
	if (scenario.expected) { expectedCases++; if (observed[0] === scenario.expected) top1++; if (observed.includes(scenario.expected)) topK++; }
	else { negativeCases++; if (!observed.length) quietNegatives++; }
	if (scenario.forbidden?.length) { forbiddenCases++; if (scenario.forbidden.some((name) => observed.includes(name))) forbiddenActivations++; }
}
const recomputedMetrics = {
	top1Accuracy: expectedCases ? top1 / expectedCases : 1,
	topKRecall: expectedCases ? topK / expectedCases : 1,
	forbiddenActivationRate: forbiddenCases ? forbiddenActivations / forbiddenCases : 0,
	noMatchPrecision: negativeCases ? quietNegatives / negativeCases : 1,
};
if (JSON.stringify(artifact?.report?.metrics) !== JSON.stringify(recomputedMetrics)) failures.push("live semantic evidence report metrics do not match its per-case observations");

const attempts = Array.isArray(artifact?.cognitionAttempts) ? artifact.cognitionAttempts : [];
for (const attempt of attempts) {
	if (!knownCases.has(attempt?.caseId) || !artifact.models?.includes(attempt?.modelId) || !Number.isSafeInteger(attempt?.attempt) || attempt.attempt < 1 || attempt.attempt > 5 || !Number.isFinite(attempt?.estimatedTokens) || attempt.estimatedTokens < 1 || !Number.isFinite(attempt?.durationMs) || attempt.durationMs < 0 || (attempt.actualTokens !== undefined && (!Number.isFinite(attempt.actualTokens) || attempt.actualTokens < 0)) || (attempt.costUsd !== undefined && (!Number.isFinite(attempt.costUsd) || attempt.costUsd < 0)) || (attempt.status !== "succeeded" && attempt.status !== "failed")) failures.push("live semantic evidence has an invalid cognition attempt");
}
for (const scenario of capabilityRankingCases) if (!attempts.some((attempt) => attempt.caseId === scenario.id && attempt.status === "succeeded")) failures.push(`live semantic evidence has no successful model attempt for ${scenario.id}`);
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, artifact: path, passed: failures.length === 0, failures }, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LexicalCapabilityRanker, SemanticCapabilityRanker, evaluateCapabilityRanking } from "../packages/core/dist/index.js";
import { capabilityInventory, capabilityRankingCases, frozenSemanticSimilarities } from "../evals/capability-ranking-corpus.mjs";
import { executeOutcomeBoundCapabilityRun } from "./capability-outcome-harness.mjs";

const args = process.argv.slice(2);
const observe = (ranker) => {
	const observedRankings = [];
	return { observedRankings, ranker: { async rank(query, inventory, limit, signal, context) {
		const ranked = await ranker.rank(query, inventory, limit, signal, context);
		observedRankings.push({ caseId: capabilityRankingCases.find((scenario) => scenario.query === query)?.id ?? "unknown", cognitionId: context?.cognitionId ?? "eval:unknown", candidates: ranked.map((item) => ({ kind: item.descriptor.kind, name: item.descriptor.name, confidence: item.confidence, strategy: item.explanation.strategy })) });
		return ranked;
	} } };
};
const lexicalObserved = observe(new LexicalCapabilityRanker());
const frozenObserved = observe(new SemanticCapabilityRanker({ similarities: async ({ query }) => frozenSemanticSimilarities[query] ?? [] }));
const lexical = await evaluateCapabilityRanking({ ranker: lexicalObserved.ranker, inventory: capabilityInventory, cases: capabilityRankingCases, limit: 5, activationThreshold: 0.5 });
const semanticContract = await evaluateCapabilityRanking({ ranker: frozenObserved.ranker, inventory: capabilityInventory, cases: capabilityRankingCases, limit: 5, activationThreshold: 0.5 });
const lexicalExecution = await executeOutcomeBoundCapabilityRun({ mode: "lexical", threshold: 0.5, observedRankings: lexicalObserved.observedRankings });
const frozenExecution = await executeOutcomeBoundCapabilityRun({ mode: "frozen_semantic", threshold: 0.5, observedRankings: frozenObserved.observedRankings });
const calibration = { lexical: lexicalExecution.report, frozenSemantic: frozenExecution.report };
const failures = [];
if (lexical.metrics.topKRecall < 0.85) failures.push("Lexical Capability Top-K recall is below 0.85");
if (lexical.metrics.forbiddenActivationRate > 0) failures.push("Lexical Capability ranking activated a forbidden capability");
if (lexical.metrics.noMatchPrecision < 1) failures.push("Lexical Capability ranking activated a capability for a negative case");
if (semanticContract.metrics.top1Accuracy < 1 || semanticContract.metrics.topKRecall < 1 || semanticContract.metrics.forbiddenActivationRate > 0 || semanticContract.metrics.noMatchPrecision < 1) failures.push("Semantic Capability ranking contract regressed");
if (calibration.lexical.metrics.downstreamTaskCompletionRate < 0.85) failures.push("Lexical Capability downstream task completion is below 0.85");
if (calibration.frozenSemantic.metrics.downstreamTaskCompletionRate < 1 || calibration.frozenSemantic.metrics.unnecessaryActivationRate > 0) failures.push("Frozen semantic Capability outcome contract regressed");
const artifact = { schemaVersion: 1, corpus: { version: "unknown-enterprise-multilingual:v1", cases: capabilityRankingCases.length, inventory: capabilityInventory.length }, lexical, semanticContract: { ...semanticContract, scope: "frozen-provider-contract; not a concrete embedding model quality claim" }, calibration, taskReceipts: { lexical: lexicalExecution.receipts, frozenSemantic: frozenExecution.receipts }, environment: { node: process.version, platform: process.platform, arch: process.arch }, gate: { passed: failures.length === 0, failures } };
const writeIndex = args.indexOf("--write");
if (writeIndex >= 0) await writeFile(resolve(args[writeIndex + 1] || "artifacts/capability-ranking.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

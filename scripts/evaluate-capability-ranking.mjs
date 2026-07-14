#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LexicalCapabilityRanker, SemanticCapabilityRanker, evaluateCapabilityRanking } from "../packages/core/dist/index.js";
import { capabilityInventory, capabilityRankingCases, frozenSemanticSimilarities } from "../evals/capability-ranking-corpus.mjs";

const args = process.argv.slice(2);
const lexical = await evaluateCapabilityRanking({ ranker: new LexicalCapabilityRanker(), inventory: capabilityInventory, cases: capabilityRankingCases, limit: 5, activationThreshold: 0.5 });
const semanticContract = await evaluateCapabilityRanking({ ranker: new SemanticCapabilityRanker({ similarities: async ({ query }) => frozenSemanticSimilarities[query] ?? [] }), inventory: capabilityInventory, cases: capabilityRankingCases, limit: 5, activationThreshold: 0.5 });
const failures = [];
if (lexical.metrics.topKRecall < 0.85) failures.push("Lexical Capability Top-K recall is below 0.85");
if (lexical.metrics.forbiddenActivationRate > 0) failures.push("Lexical Capability ranking activated a forbidden capability");
if (lexical.metrics.noMatchPrecision < 1) failures.push("Lexical Capability ranking activated a capability for a negative case");
if (semanticContract.metrics.top1Accuracy < 1 || semanticContract.metrics.topKRecall < 1 || semanticContract.metrics.forbiddenActivationRate > 0 || semanticContract.metrics.noMatchPrecision < 1) failures.push("Semantic Capability ranking contract regressed");
const artifact = { schemaVersion: 1, corpus: { cases: capabilityRankingCases.length, inventory: capabilityInventory.length }, lexical, semanticContract: { ...semanticContract, scope: "frozen-provider-contract; not a concrete embedding model quality claim" }, environment: { node: process.version, platform: process.platform, arch: process.arch }, gate: { passed: failures.length === 0, failures } };
const writeIndex = args.indexOf("--write");
if (writeIndex >= 0) await writeFile(resolve(args[writeIndex + 1] || "artifacts/capability-ranking.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

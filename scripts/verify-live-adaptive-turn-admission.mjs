#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { adaptiveTurnAdmissionCases } from "../evals/adaptive-turn-admission-corpus.mjs";
import { liveAdaptiveAdmissionImplementationDigest } from "./adaptive-turn-admission-evidence.mjs";

const path = resolve(process.argv[2] || "evals/baselines/adaptive-turn-admission-live.json");
const artifact = JSON.parse(await readFile(path, "utf8"));
const failures = [];
if (artifact?.schemaVersion !== 1) failures.push("live Adaptive Turn Admission evidence schema is invalid");
if (artifact?.implementationDigest !== await liveAdaptiveAdmissionImplementationDigest()) failures.push("live Adaptive Turn Admission evidence does not match the current implementation and corpus");
if (!Array.isArray(artifact?.models) || !artifact.models.length || artifact.models.some((model) => typeof model !== "string" || !model.includes("/"))) failures.push("live Adaptive Turn Admission evidence has no concrete model identity");
const generatedAt = Date.parse(artifact?.generatedAt);
if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > 30 * 24 * 60 * 60_000 || generatedAt > Date.now() + 5 * 60_000) failures.push("live Adaptive Turn Admission evidence is missing, expired, or future-dated");

const observations = Array.isArray(artifact?.cases) ? artifact.cases : [];
const observationById = new Map(observations.map((observation) => [observation?.id, observation]));
if (observations.length !== adaptiveTurnAdmissionCases.length || observationById.size !== observations.length) failures.push("live Adaptive Turn Admission evidence has missing or duplicate cases");
for (const scenario of adaptiveTurnAdmissionCases) {
	const observation = observationById.get(scenario.id);
	if (!observation || observation.request !== scenario.request || observation.mode !== scenario.mode || observation.expectedBasis !== scenario.expectedBasis || observation.expectedPlanningMode !== scenario.expectedPlanningMode) { failures.push(`${scenario.id}: corpus identity does not match`); continue; }
	if (observation.observedAdmissionLane !== scenario.expectedBasis || observation.planningBasis !== scenario.expectedBasis || observation.planningMode !== scenario.expectedPlanningMode) failures.push(`${scenario.id}: admission or planning lane does not match`);
	if (scenario.expectedBasis === "raw_prompt" && (observation.workContractCalls !== 0 || observation.workContractProviderTurns !== 0 || observation.workContractAdmitted !== false)) failures.push(`${scenario.id}: direct lane invoked Contract cognition`);
	if (scenario.expectedBasis === "work_contract" && (observation.workContractCalls !== 1 || observation.workContractProviderTurns < 1 || observation.workContractAdmitted !== true)) failures.push(`${scenario.id}: semantic Contract admission evidence is incomplete`);
	const inputTokens = nonnegativeNumber(observation.inputTokens);
	const outputTokens = nonnegativeNumber(observation.outputTokens);
	const totalTokens = nonnegativeNumber(observation.totalTokens);
	if (observation.runtimeFailure || observation.outcomeStatus !== "answered" || typeof observation.model !== "string" || !observation.model || !Number.isSafeInteger(observation.answerChars) || observation.answerChars < 1 || inputTokens === undefined || outputTokens === undefined || totalTokens === undefined || totalTokens < 1 || totalTokens !== inputTokens + outputTokens) failures.push(`${scenario.id}: live Pi completion evidence is incomplete`);
	const mainTurns = Array.isArray(observation.mainPiProviderEvidence) ? observation.mainPiProviderEvidence : [];
	const mainPiTokens = mainTurns.reduce((total, turn) => total + finite(turn?.inputTokens) + finite(turn?.outputTokens), 0);
	if (!mainTurns.length || mainTurns.some((turn) => !artifact.models.includes(turn?.modelIdentity) || turn?.traceCorrelated !== true || turn?.providerResponseStatus !== "reported" || !/^sha256:[a-f0-9]{64}$/.test(turn?.providerResponseIdentitySha256 ?? "") || nonnegativeNumber(turn?.inputTokens) === undefined || nonnegativeNumber(turn?.outputTokens) === undefined) || mainPiTokens + finite(observation.workContractTokens) !== totalTokens) failures.push(`${scenario.id}: main Pi Provider evidence is incomplete`);
	if (scenario.expectedBasis === "work_contract") {
		const turns = Array.isArray(observation.workContractProviderEvidence) ? observation.workContractProviderEvidence : [];
		const measuredContractTokens = turns.reduce((total, turn) => total + finite(turn?.inputTokens) + finite(turn?.outputTokens), 0);
		if (turns.length !== observation.workContractProviderTurns || !turns.some((turn) => nonnegativeNumber(turn?.inputTokens) !== undefined && nonnegativeNumber(turn?.outputTokens) !== undefined && turn.inputTokens + turn.outputTokens > 0) || observation.workContractTokens !== measuredContractTokens) failures.push(`${scenario.id}: measured Contract Provider evidence is incomplete`);
		for (const turn of turns) if (!artifact.models.includes(turn?.model) || !Number.isFinite(turn?.durationMs) || turn.durationMs < 0 || turn?.providerResponseStatus !== "reported" || !/^sha256:[a-f0-9]{64}$/.test(turn?.providerResponseIdentitySha256 ?? "") || !/^sha256:[a-f0-9]{64}$/.test(turn?.contentSha256 ?? "")) failures.push(`${scenario.id}: Contract Provider receipt is malformed`);
	}
}

const correct = observations.filter((item) => item?.observedAdmissionLane === item?.expectedBasis).length;
const direct = observations.filter((item) => item?.expectedBasis === "raw_prompt");
const contracted = observations.filter((item) => item?.expectedBasis === "work_contract");
const recomputedMetrics = {
	cases: observations.length,
	correct,
	accuracy: observations.length ? correct / observations.length : 0,
	directCases: direct.length,
	contractCases: contracted.length,
	averageDirectDurationMs: average(direct.map((item) => finite(item?.durationMs))),
	averageContractDurationMs: average(contracted.map((item) => finite(item?.durationMs))),
	totalRunTokens: observations.reduce((total, item) => total + finite(item?.totalTokens), 0),
	totalMainPiProviderTokens: observations.reduce((total, item) => total + (Array.isArray(item?.mainPiProviderEvidence) ? item.mainPiProviderEvidence : []).reduce((sum, turn) => sum + finite(turn?.inputTokens) + finite(turn?.outputTokens), 0), 0),
	totalWorkContractTokens: observations.reduce((total, item) => total + finite(item?.workContractTokens), 0),
	totalWorkContractProviderTurns: observations.reduce((total, item) => total + finite(item?.workContractProviderTurns), 0),
};
if (JSON.stringify(artifact?.metrics) !== JSON.stringify(recomputedMetrics)) failures.push("live Adaptive Turn Admission metrics do not match case evidence");
if (!artifact?.gate?.passed || artifact?.gate?.failures?.length) failures.push("live Adaptive Turn Admission producer gate did not pass");

const result = { schemaVersion: 1, artifact: path, passed: failures.length === 0, failures };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

function finite(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }
function nonnegativeNumber(value) { return Number.isFinite(value) && value >= 0 ? value : undefined; }
function average(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0; }

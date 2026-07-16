#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CAPABILITY_CALIBRATION_VERSION, SEMANTIC_CAPABILITY_MINIMUM_SIMILARITY } from "../packages/core/dist/index.js";
import { capabilityInventory, capabilityRankingCases } from "../evals/capability-ranking-corpus.mjs";
import { liveCapabilityImplementationDigest } from "./capability-ranking-evidence.mjs";
import { LIVE_PI_OUTCOME_BUDGET } from "./pi-capability-outcome-harness.mjs";

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
if (artifact?.calibrationVersion !== CAPABILITY_CALIBRATION_VERSION) failures.push("live semantic evidence calibration version does not match production");
const generatedAt = Date.parse(artifact?.generatedAt);
if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > 30 * 24 * 60 * 60_000 || generatedAt > Date.now() + 5 * 60_000) failures.push("live semantic evidence is missing, expired, or future-dated");
if (artifact?.report?.metrics?.top1Accuracy < 0.85 || artifact?.report?.metrics?.topKRecall < 0.95 || artifact?.report?.metrics?.forbiddenActivationRate !== 0 || artifact?.report?.metrics?.noMatchPrecision !== 1) failures.push("live semantic evidence metrics are below the release gate");

const knownCapabilities = new Map(capabilityInventory.map((candidate) => [candidate.name, candidate]));
const knownCases = new Map(capabilityRankingCases.map((scenario) => [scenario.id, scenario]));
const rankings = Array.isArray(artifact?.observedRankings) ? artifact.observedRankings : [];
const rankingByCase = new Map();
for (const ranking of rankings) {
	if (!knownCases.has(ranking?.caseId) || rankingByCase.has(ranking.caseId) || !Array.isArray(ranking?.candidates)) { failures.push("live semantic evidence has unknown, duplicate, or malformed case rankings"); continue; }
	if (typeof ranking.cognitionId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(ranking.cognitionId)) failures.push(`live semantic evidence has invalid cognition identity for ${ranking.caseId}`);
	const candidates = [];
	for (const candidate of ranking.candidates) {
		const descriptor = knownCapabilities.get(candidate?.name);
		if (!descriptor || candidate?.kind !== descriptor.kind || candidate?.version !== descriptor.version || candidate?.strategy !== "semantic" || !Number.isFinite(candidate?.confidence) || candidate.confidence < artifact.threshold || candidate.confidence > 1) { failures.push(`live semantic evidence has an invalid observed candidate for ${ranking.caseId}`); continue; }
		candidates.push(candidate.name);
	}
	rankingByCase.set(ranking.caseId, candidates);
}
if (rankingByCase.size !== capabilityRankingCases.length) failures.push("live semantic evidence does not contain exactly one ranking for every corpus case");

let expectedCases = 0; let top1 = 0; let topK = 0; let forbiddenCases = 0; let forbiddenActivations = 0; let negativeCases = 0; let quietNegatives = 0;
for (const scenario of capabilityRankingCases) {
	const observed = rankingByCase.get(scenario.id) ?? [];
	if (scenario.expected) { expectedCases++; if (observed[0] === scenario.expected) top1++; const required = scenario.required?.length ? scenario.required : [scenario.expected]; if (required.every((name) => observed.includes(name))) topK++; }
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
	const ranking = rankings.find((item) => item.cognitionId === attempt?.cognitionId);
	const measured = Number.isFinite(attempt?.actualTokens) && attempt.actualTokens >= 0 && Number.isFinite(attempt?.actualInputTokens) && attempt.actualInputTokens >= 0 && Number.isFinite(attempt?.actualOutputTokens) && attempt.actualOutputTokens >= 0 && attempt.actualTokens === attempt.actualInputTokens + attempt.actualOutputTokens && Number.isFinite(attempt?.costUsd) && attempt.costUsd >= 0;
	const partial = [attempt?.actualInputTokens, attempt?.actualOutputTokens, attempt?.costUsd].some((value) => Number.isFinite(value));
	const expectedUsageStatus = measured ? "measured" : partial ? "partial" : "unavailable";
	if (!knownCases.has(attempt?.caseId) || ranking?.caseId !== attempt.caseId || !artifact.models?.includes(attempt?.modelId) || !Number.isSafeInteger(attempt?.attempt) || attempt.attempt < 1 || attempt.attempt > 5 || !Number.isFinite(attempt?.estimatedTokens) || attempt.estimatedTokens < 1 || !Number.isFinite(attempt?.durationMs) || attempt.durationMs < 0 || attempt?.usageStatus !== expectedUsageStatus || (attempt.status !== "succeeded" && attempt.status !== "failed") || (attempt.status === "succeeded" && !measured)) failures.push("live semantic evidence has an invalid cognition attempt");
}
for (const scenario of capabilityRankingCases) if (!attempts.some((attempt) => attempt.caseId === scenario.id && attempt.status === "succeeded")) failures.push(`live semantic evidence has no successful model attempt for ${scenario.id}`);
const recomputedCalibrationMetrics = recomputeOutcomeMetrics(artifact?.taskReceipts, rankings, attempts, artifact.threshold);
verifyReportMetadata(artifact?.calibration, "live_provider", artifact.threshold);
if (JSON.stringify(artifact?.calibration?.metrics) !== JSON.stringify(recomputedCalibrationMetrics)) failures.push("live semantic outcome calibration does not match its Tool Spec, execution, Verification, usage, and cost receipts");
if (artifact?.calibration?.metrics?.requiredCapabilityRecall < 0.95 || artifact?.calibration?.metrics?.unnecessaryActivationRate !== 0 || artifact?.calibration?.metrics?.forbiddenActivationRate !== 0 || artifact?.calibration?.metrics?.downstreamTaskCompletionRate < 0.95 || artifact?.calibration?.metrics?.usageMeasurementRate !== 1) failures.push("live semantic outcome calibration is below the release gate or has incomplete cost evidence");
const trials = Array.isArray(artifact?.calibrationTrials) ? artifact.calibrationTrials : [];
if (trials.length !== 3 || JSON.stringify(trials.map((trial) => trial.threshold)) !== JSON.stringify([0.8, 0.9, 0.99])) failures.push("live semantic threshold trials are missing or malformed");
for (const trial of trials) {
	const metrics = recomputeOutcomeMetrics(trial.receipts, rankings, attempts, trial.threshold);
	verifyReportMetadata(trial?.report, "live_provider", trial.threshold);
	if (JSON.stringify(trial?.report?.metrics) !== JSON.stringify(metrics)) failures.push(`threshold ${trial.threshold} report does not match its independent execution receipts`);
	const expectedPromotionFailures = calibrationRegressionCodes(recomputedCalibrationMetrics, metrics);
	if (trial.version !== `${CAPABILITY_CALIBRATION_VERSION}:threshold-${trial.threshold}` || trial?.promotion?.passed !== (expectedPromotionFailures.length === 0) || JSON.stringify((trial?.promotion?.failures ?? []).map((item) => item.code)) !== JSON.stringify(expectedPromotionFailures)) failures.push(`threshold ${trial.threshold} promotion decision is not evidence-bound`);
}
verifyAuthorityProbe(artifact?.authorityProbe);
verifyLivePiOutcome(artifact?.piOutcome);

function recomputeOutcomeMetrics(receiptsValue, observedRankings, usageAttempts, threshold) {
	const receipts = Array.isArray(receiptsValue) ? receiptsValue : [];
	const receiptIds = receipts.map((receipt) => receipt?.caseId);
	if (receipts.length !== capabilityRankingCases.length || new Set(receiptIds).size !== receipts.length || receiptIds.some((id) => !knownCases.has(id))) failures.push(`task receipts are duplicate, unknown, or incomplete at threshold ${threshold}`);
	const receiptByCase = new Map(receipts.map((receipt) => [receipt?.caseId, receipt]));
	let positive = 0; let top1Count = 0; let allRequired = 0; let requiredTotal = 0; let requiredFound = 0; let forbiddenCasesCount = 0; let forbiddenCount = 0; let activationCount = 0; let unnecessaryCount = 0; let negatives = 0; let quiet = 0; let completed = 0; let latency = 0; let inputTokens = 0; let outputTokens = 0; let cost = 0; let measuredUsageAttempts = 0; let totalUsageAttempts = 0;
	for (const scenario of capabilityRankingCases) {
		const ranking = observedRankings.find((item) => item.caseId === scenario.id); const receipt = receiptByCase.get(scenario.id);
		if (!ranking || !receipt) { failures.push(`missing task receipt for ${scenario.id} at threshold ${threshold}`); continue; }
		const selected = ranking.candidates.filter((candidate) => candidate.confidence >= threshold).map((candidate) => candidate.name);
		const required = scenario.required?.length ? scenario.required : scenario.expected ? [scenario.expected] : [];
		const activated = verifyTaskReceipt(receipt, scenario, ranking, selected, threshold);
		if (scenario.expected) { positive++; if (selected[0] === scenario.expected) top1Count++; if (required.every((name) => selected.includes(name))) allRequired++; requiredTotal += required.length; requiredFound += required.filter((name) => selected.includes(name)).length; }
		else { negatives++; if (!activated.length) quiet++; }
		if (scenario.forbidden?.length) { forbiddenCasesCount++; if (scenario.forbidden.some((name) => activated.includes(name))) forbiddenCount++; }
		activationCount += activated.length; unnecessaryCount += activated.filter((name) => !required.includes(name)).length;
		if (receipt.downstreamOutcome === "accepted") completed++;
		const caseAttempts = usageAttempts.filter((attempt) => attempt.cognitionId === ranking.cognitionId);
		latency += receipt.durationMs + caseAttempts.reduce((sum, attempt) => sum + attempt.durationMs, 0);
		const measuredAttempts = caseAttempts.filter((attempt) => attempt.usageStatus === "measured");
		measuredUsageAttempts += measuredAttempts.length; totalUsageAttempts += caseAttempts.length;
		inputTokens += measuredAttempts.reduce((sum, attempt) => sum + attempt.actualInputTokens, 0); outputTokens += measuredAttempts.reduce((sum, attempt) => sum + attempt.actualOutputTokens, 0); cost += measuredAttempts.reduce((sum, attempt) => sum + attempt.costUsd, 0);
	}
	const count = capabilityRankingCases.length;
	return { top1Accuracy: positive ? top1Count / positive : 1, topKRecall: positive ? allRequired / positive : 1, requiredCapabilityRecall: requiredTotal ? requiredFound / requiredTotal : 1, forbiddenActivationRate: forbiddenCasesCount ? forbiddenCount / forbiddenCasesCount : 0, unnecessaryActivationRate: activationCount ? unnecessaryCount / activationCount : 0, noMatchPrecision: negatives ? quiet / negatives : 1, downstreamTaskCompletionRate: completed / count, averageLatencyMs: latency / count, totalTokens: inputTokens + outputTokens, averageTokens: (inputTokens + outputTokens) / count, totalCostUsd: Math.round(cost * 1e12) / 1e12, usageMeasurementRate: totalUsageAttempts ? measuredUsageAttempts / totalUsageAttempts : 1 };
}

function verifyTaskReceipt(receipt, scenario, ranking, selectedNames, threshold) {
	if (receipt.cognitionId !== ranking.cognitionId || receipt.threshold !== threshold || receipt.accessScopeId !== `scope:capability-eval:${scenario.id}` || !Array.isArray(receipt.executionTrace) || !Array.isArray(receipt.activeToolSnapshots) || !Array.isArray(receipt.toolSpecPlans)) failures.push(`task receipt identity, scope, or Tool Spec evidence is invalid for ${scenario.id}`);
	const expectedCandidates = ranking.candidates.filter((candidate) => candidate.confidence >= threshold).map(({ kind, name, version, confidence }) => ({ kind, name, version, confidence }));
	if (JSON.stringify(receipt.selectedCandidates) !== JSON.stringify(expectedCandidates)) failures.push(`task receipt candidates do not match ranking for ${scenario.id}`);
	const events = Array.isArray(receipt.executionTrace) ? receipt.executionTrace : [];
	if (events.some((event, index) => !Number.isSafeInteger(event?.sequence) || event.sequence < 1 || (index > 0 && event.sequence <= events[index - 1].sequence))) failures.push(`task receipt trace sequence is invalid for ${scenario.id}`);
	const decision = events.find((event) => event.type === "capability.decision" && event.cognitionId === ranking.cognitionId);
	const downstream = events.find((event) => event.type === "capability.downstream_execution_outcome" && event.cognitionId === ranking.cognitionId);
	const verification = [...events].reverse().find((event) => event.type === "verification.settled"); const settled = [...events].reverse().find((event) => event.type === "execution.settled");
	if (!decision || JSON.stringify(decision.candidates) !== JSON.stringify(expectedCandidates)) failures.push(`task receipt lacks the correlated Capability decision for ${scenario.id}`);
	const settledTools = events.filter((event) => event.type === "tool.settled" && event.status === "succeeded");
	const successfulTools = settledTools.map((event) => event.toolName);
	const startedEvents = events.filter((item) => item.type === "tool.started");
	const allSettledEvents = events.filter((item) => item.type === "tool.settled");
	const modelTurns = events.filter((event) => event.type === "model.turn_settled");
	const allModelToolCalls = modelTurns.flatMap((event) => (event.assistantToolCalls ?? []).map((call) => ({ event, call })));
	if (!modelTurns.length || new Set(modelTurns.map((event) => event.assistantTurnId)).size !== modelTurns.length || modelTurns.some((event) => {
		const toolCalls = Array.isArray(event.assistantToolCalls) ? event.assistantToolCalls : [];
		return !/^assistant-turn:[0-9a-f-]{36}$/i.test(event.assistantTurnId ?? "") || event.providerResponseStatus !== "reported" || !/^sha256:[a-f0-9]{64}$/i.test(event.providerResponseIdentitySha256 ?? "") || toolCalls.length > 100 || new Set(toolCalls.map((call) => call?.toolCallId)).size !== toolCalls.length || toolCalls.some((call) => typeof call?.toolCallId !== "string" || !call.toolCallId || typeof call.toolName !== "string" || !call.toolName || !/^sha256:[a-f0-9]{64}$/i.test(call.argumentsSha256 ?? ""));
	}) || new Set(allModelToolCalls.map(({ call }) => call?.toolCallId)).size !== allModelToolCalls.length) failures.push(`task receipt lacks valid globally unique Provider-backed model Turn evidence for ${scenario.id}`);
	const startedCounts = new Map(); const settledCounts = new Map();
	for (const event of startedEvents) startedCounts.set(event.toolCallId, (startedCounts.get(event.toolCallId) ?? 0) + 1);
	for (const event of allSettledEvents) settledCounts.set(event.toolCallId, (settledCounts.get(event.toolCallId) ?? 0) + 1);
	for (const toolCallId of new Set([...startedCounts.keys(), ...settledCounts.keys()])) if (startedCounts.get(toolCallId) !== 1 || settledCounts.get(toolCallId) !== 1) failures.push(`Tool call ${toolCallId} is orphaned or duplicated for ${scenario.id}`);
	for (const event of startedEvents) {
		const toolSettled = allSettledEvents.find((item) => item.toolCallId === event.toolCallId);
		const plan = [...events].reverse().find((item) => item.type === "tool_spec.published" && item.sequence < event.sequence && item.toolSpecPlanId === event.toolSpecPlanId);
		const modelTurn = modelTurns.find((item) => item.assistantTurnId === event.assistantTurnId);
		const modelToolCall = modelTurn?.assistantToolCalls?.find((item) => item.toolCallId === event.toolCallId);
		const originMatches = modelTurn && modelToolCall?.toolName === event.toolName && modelToolCall.argumentsSha256 === event.argumentsSha256 && toolSettled?.assistantTurnId === modelTurn.assistantTurnId && toolSettled.toolName === modelToolCall.toolName && toolSettled.argumentsSha256 === modelToolCall.argumentsSha256 && event.providerResponseStatus === modelTurn.providerResponseStatus && event.providerResponseIdentitySha256 === modelTurn.providerResponseIdentitySha256 && toolSettled.providerResponseStatus === modelTurn.providerResponseStatus && toolSettled.providerResponseIdentitySha256 === modelTurn.providerResponseIdentitySha256;
		if (!event.toolSpecPlanId || toolSettled?.toolSpecPlanId !== event.toolSpecPlanId || !plan?.directTools?.includes(event.toolName) || !originMatches || !(modelTurn.sequence < event.sequence) || !(event.sequence < toolSettled?.sequence) || !(toolSettled.sequence < verification?.sequence)) failures.push(`Tool ${event.toolName} lacks its exact Provider-backed model Turn, prior Tool Spec, unique settlement, or pre-Verification ordering for ${scenario.id}`);
	}
	for (const { event: modelTurn, call: modelToolCall } of allModelToolCalls) {
		const started = startedEvents.find((event) => event.toolCallId === modelToolCall.toolCallId); const settled = allSettledEvents.find((event) => event.toolCallId === modelToolCall.toolCallId);
		if (startedCounts.get(modelToolCall.toolCallId) !== 1 || settledCounts.get(modelToolCall.toolCallId) !== 1 || started?.assistantTurnId !== modelTurn.assistantTurnId || settled?.assistantTurnId !== modelTurn.assistantTurnId) failures.push(`model Tool call lacks one exact same-Turn execution for ${scenario.id}`);
	}
	for (const toolName of successfulTools) if (!receipt.activeToolSnapshots.some((snapshot) => Array.isArray(snapshot) && snapshot.includes(toolName))) failures.push(`Tool ${toolName} executed outside the Tool Spec snapshots for ${scenario.id}`);
	const selectedCandidates = ranking.candidates.filter((candidate) => candidate.confidence >= threshold);
	const capabilityReceipts = settledTools.flatMap((event) => event.capabilityReceipt ? [event.capabilityReceipt] : []);
	if (new Set(capabilityReceipts.map((item) => item.id)).size !== capabilityReceipts.length) failures.push(`Capability receipts are duplicated for ${scenario.id}`);
	for (const event of settledTools.filter((item) => item.capabilityReceipt)) {
		const capabilityReceipt = event.capabilityReceipt;
		const candidate = selectedCandidates.find((item) => item.name === capabilityReceipt.name);
		const descriptor = candidate ? knownCapabilities.get(candidate.name) : undefined;
		const allowedSources = candidate?.kind === "skill" ? ["skill_complete"] : descriptor?.activeTools ?? [];
		if (!candidate || capabilityReceipt.kind !== candidate.kind || capabilityReceipt.version !== candidate.version || capabilityReceipt.sourceTool !== event.toolName || !allowedSources.includes(event.toolName)) failures.push(`Capability receipt has an unknown or mutable identity for ${scenario.id}`);
	}
	const candidateSources = new Map(selectedCandidates.map((candidate) => [candidate.name, candidate.kind === "skill" ? ["skill_complete"] : knownCapabilities.get(candidate.name)?.activeTools ?? []]));
	for (const event of settledTools) {
		const possibleCandidates = selectedCandidates.filter((candidate) => candidateSources.get(candidate.name)?.includes(event.toolName));
		if (possibleCandidates.length && !event.capabilityReceipt) failures.push(`Successful Capability execution lacks an immutable receipt for ${scenario.id}`);
	}
	const activated = selectedCandidates.flatMap((candidate) => capabilityReceipts.some((item) => item.kind === candidate.kind && item.name === candidate.name && item.version === candidate.version) ? [candidate.name] : []);
	if (JSON.stringify(receipt.activatedCapabilities) !== JSON.stringify(activated)) failures.push(`task receipt activation projection is invalid for ${scenario.id}`);
	const required = scenario.required?.length ? scenario.required : scenario.expected ? [scenario.expected] : [];
	const expectedAccepted = required.every((name) => activated.includes(name)) && !(scenario.forbidden ?? []).some((name) => activated.includes(name)) && (required.length > 0 || activated.length === 0);
	const expectedOutcome = expectedAccepted ? "accepted" : "rejected"; const expectedExecution = expectedAccepted ? "succeeded" : "failed";
	if (verification?.status !== expectedOutcome || downstream?.status !== expectedOutcome || settled?.status !== expectedExecution || receipt.verificationStatus !== expectedOutcome || receipt.downstreamOutcome !== expectedOutcome || receipt.status !== expectedExecution) failures.push(`task receipt Verification or settlement is invalid for ${scenario.id}`);
	return activated;
}

function calibrationRegressionCodes(baseline, candidate) {
	const codes = [];
	if (candidate.top1Accuracy < baseline.top1Accuracy) codes.push("top1_regression");
	if (candidate.topKRecall < baseline.topKRecall) codes.push("topk_regression");
	if (candidate.requiredCapabilityRecall < baseline.requiredCapabilityRecall) codes.push("required_recall_regression");
	if (candidate.forbiddenActivationRate > baseline.forbiddenActivationRate) codes.push("forbidden_activation_regression");
	if (candidate.unnecessaryActivationRate > baseline.unnecessaryActivationRate) codes.push("unnecessary_activation_regression");
	if (candidate.noMatchPrecision < baseline.noMatchPrecision) codes.push("no_match_regression");
	if (candidate.downstreamTaskCompletionRate < baseline.downstreamTaskCompletionRate) codes.push("completion_regression");
	if (candidate.averageLatencyMs > baseline.averageLatencyMs * 1.2 + 5) codes.push("latency_regression");
	if (candidate.totalTokens > baseline.totalTokens * 1.05) codes.push("token_regression");
	if (candidate.totalCostUsd > baseline.totalCostUsd * 1.05) codes.push("cost_regression");
	if (candidate.usageMeasurementRate < baseline.usageMeasurementRate) codes.push("usage_measurement_regression");
	if (candidate.usageMeasurementRate < 1) codes.push("cost_evidence_incomplete");
	return codes;
}

function verifyReportMetadata(report, mode, threshold) {
	if (report?.schemaVersion !== 1 || report?.mode !== mode || report?.corpusVersion !== "unknown-enterprise-multilingual:v1" || report?.threshold !== threshold || report?.cases !== capabilityRankingCases.length || !Array.isArray(report?.failures)) failures.push(`Capability calibration report metadata is invalid at threshold ${threshold}`);
}

function verifyAuthorityProbe(receipt) {
	const events = Array.isArray(receipt?.executionTrace) ? receipt.executionTrace : [];
	const toolExecuted = events.some((event) => event.type === "tool.started" && event.toolName === "authority_probe_mutation");
	const exposed = (Array.isArray(receipt?.activeToolSnapshots) && receipt.activeToolSnapshots.some((snapshot) => Array.isArray(snapshot) && snapshot.includes("authority_probe_mutation"))) || (Array.isArray(receipt?.toolSpecPlans) && receipt.toolSpecPlans.some((plan) => plan?.directTools?.includes("authority_probe_mutation")));
	const verification = [...events].reverse().find((event) => event.type === "verification.settled"); const downstream = [...events].reverse().find((event) => event.type === "capability.downstream_execution_outcome"); const decision = events.find((event) => event.type === "capability.decision");
	const expectedCandidate = [{ kind: "tool", name: "authority_probe_mutation", version: "probe:1", confidence: 1 }];
	if (receipt?.caseId !== "authority-probe" || receipt?.cognitionId !== "eval:authority-probe" || receipt?.accessScopeId !== "scope:capability-eval:authority-probe" || JSON.stringify(receipt?.selectedCandidates) !== JSON.stringify(expectedCandidate) || decision?.cognitionId !== "eval:authority-probe" || JSON.stringify(decision?.candidates) !== JSON.stringify(expectedCandidate) || downstream?.cognitionId !== "eval:authority-probe" || toolExecuted || exposed || verification?.status !== "rejected" || downstream?.status !== "rejected" || receipt?.status !== "failed") failures.push("authorization probe did not prove the scoped unauthorized decision, Tool Spec denial, and rejected Verification");
}

function verifyLivePiOutcome(outcome) {
	const receipts = Array.isArray(outcome?.receipts) ? outcome.receipts : [];
	const recomputedMetrics = independentlySummarizeLivePiOutcomeReceipts(receipts); const recomputedBudgetFailures = independentlyVerifyLivePiBudget(recomputedMetrics, LIVE_PI_OUTCOME_BUDGET);
	const recomputedWorkContractFailures = independentlyVerifyProductionWorkContracts(receipts);
	const generatedAt = Date.parse(outcome?.generatedAt);
	if (outcome?.schemaVersion !== 1 || outcome?.mode !== "live_pi" || !/^execution:live-pi:[0-9a-f-]{36}$/i.test(outcome?.runId ?? "") || !Number.isFinite(generatedAt) || Date.now() - generatedAt > 30 * 24 * 60 * 60_000 || generatedAt > Date.now() + 5 * 60_000 || !artifact.models?.includes(outcome?.modelId) || outcome?.cases !== capabilityRankingCases.length || receipts.length !== capabilityRankingCases.length || new Set(receipts.map((receipt) => receipt?.caseId)).size !== receipts.length || JSON.stringify(outcome?.metrics) !== JSON.stringify(recomputedMetrics) || JSON.stringify(outcome?.budget) !== JSON.stringify(LIVE_PI_OUTCOME_BUDGET) || JSON.stringify(outcome?.budgetFailures) !== JSON.stringify(recomputedBudgetFailures)) { failures.push("Live Pi outcome metadata, freshness, corpus coverage, or execution budget evidence is invalid"); return; }
	if (JSON.stringify(outcome?.workContractFailures) !== JSON.stringify(recomputedWorkContractFailures)) { failures.push("Live Pi production Work Contract composition evidence is invalid"); return; }
	if (recomputedBudgetFailures.length) failures.push(`Live Pi execution budget failed: ${recomputedBudgetFailures.join(", ")}`);
	if (recomputedWorkContractFailures.length) failures.push(`Live Pi production Work Contract composition failed: ${recomputedWorkContractFailures.join(", ")}`);
	let accepted = 0;
	for (const scenario of capabilityRankingCases) {
		const ranking = rankings.find((item) => item.caseId === scenario.id); const receipt = receipts.find((item) => item.caseId === scenario.id);
		if (!ranking || !receipt) { failures.push(`Live Pi outcome is missing ${scenario.id}`); continue; }
		const selected = ranking.candidates.filter((candidate) => candidate.confidence >= artifact.threshold).map(({ kind, name, version, confidence }) => ({ kind, name, version, confidence }));
		if (receipt.cognitionId !== ranking.cognitionId || receipt.executionId !== `${outcome.runId}:${scenario.id}` || receipt.accessScopeId !== `scope:live-pi:${scenario.id}` || JSON.stringify(receipt.selectedCandidates) !== JSON.stringify(selected) || !Array.isArray(receipt.executionTrace) || ["piToolCalls", "piToolErrors", "toolAudit"].some((key) => key in receipt)) failures.push(`Live Pi receipt identity or content-free evidence shape is invalid for ${scenario.id}`);
		const events = Array.isArray(receipt.executionTrace) ? receipt.executionTrace : [];
		if (events.some((event, index) => !Number.isSafeInteger(event?.sequence) || event.sequence < 1 || (index > 0 && event.sequence <= events[index - 1].sequence))) failures.push(`Live Pi trace sequence is invalid for ${scenario.id}`);
		const executionStarts = events.filter((event) => event.type === "execution.started"); const executionSettles = events.filter((event) => event.type === "execution.settled");
		if (executionStarts.length !== 1 || executionSettles.length !== 1 || events[0] !== executionStarts[0] || events.at(-1) !== executionSettles[0] || events.some((event, index) => event.executionId !== receipt.executionId || event.accessScopeId !== receipt.accessScopeId || !Number.isFinite(event.at) || (index > 0 && event.at < events[index - 1].at))) failures.push(`Live Pi trace lifecycle, ownership, or time ordering is invalid for ${scenario.id}`);
		const decision = events.find((event) => event.type === "capability.decision" && event.cognitionId === ranking.cognitionId);
		const verification = [...events].reverse().find((event) => event.type === "verification.settled");
		const downstream = [...events].reverse().find((event) => event.type === "capability.downstream_execution_outcome" && event.cognitionId === ranking.cognitionId);
		const execution = [...events].reverse().find((event) => event.type === "execution.settled");
		if (!decision || JSON.stringify(decision.candidates) !== JSON.stringify(selected)) failures.push(`Live Pi outcome lacks its correlated Capability decision for ${scenario.id}`);
		const modelTurns = events.filter((event) => event.type === "model.turn_settled" && Number.isFinite(event.inputTokens) && event.inputTokens >= 0 && Number.isFinite(event.outputTokens) && event.outputTokens >= 0);
		const allModelToolCalls = modelTurns.flatMap((event) => (event.assistantToolCalls ?? []).map((call) => ({ event, call })));
		if (!modelTurns.length) failures.push(`Live Pi outcome has no measured model turn for ${scenario.id}`);
		if (new Set(modelTurns.map((event) => event.assistantTurnId)).size !== modelTurns.length || modelTurns.some((event) => {
			const toolCalls = Array.isArray(event.assistantToolCalls) ? event.assistantToolCalls : [];
			const validToolCalls = toolCalls.length <= 100 && new Set(toolCalls.map((call) => call?.toolCallId)).size === toolCalls.length && toolCalls.every((call) => typeof call?.toolCallId === "string" && call.toolCallId && typeof call.toolName === "string" && call.toolName && /^sha256:[a-f0-9]{64}$/i.test(call.argumentsSha256 ?? ""));
			return !/^assistant-turn:[0-9a-f-]{36}$/i.test(event.assistantTurnId ?? "") || !validToolCalls || event.providerResponseStatus !== "reported" && event.providerResponseStatus !== "unavailable" || event.providerResponseStatus === "reported" && !/^sha256:[a-f0-9]{64}$/i.test(event.providerResponseIdentitySha256 ?? "") || event.providerResponseStatus === "unavailable" && (event.providerResponseIdentitySha256 !== undefined || toolCalls.length > 0);
		}) || new Set(allModelToolCalls.map(({ call }) => call?.toolCallId)).size !== allModelToolCalls.length) failures.push(`Live Pi model Turn, global Tool-call identity, or Provider response identity is invalid for ${scenario.id}`);
		const started = events.filter((event) => event.type === "tool.started");
		const settled = events.filter((event) => event.type === "tool.settled");
		const startedCounts = new Map(); const settledCounts = new Map();
		for (const event of started) startedCounts.set(event.toolCallId, (startedCounts.get(event.toolCallId) ?? 0) + 1);
		for (const event of settled) settledCounts.set(event.toolCallId, (settledCounts.get(event.toolCallId) ?? 0) + 1);
		for (const toolCallId of new Set([...startedCounts.keys(), ...settledCounts.keys()])) if (!toolCallId || startedCounts.get(toolCallId) !== 1 || settledCounts.get(toolCallId) !== 1) failures.push(`Live Pi Tool call is orphaned or duplicated for ${scenario.id}`);
		for (const event of started) {
			const toolSettled = settled.find((item) => item.toolCallId === event.toolCallId);
			const plan = [...events].reverse().find((item) => item.type === "tool_spec.published" && item.sequence < event.sequence && item.toolSpecPlanId === event.toolSpecPlanId);
			const modelTurn = modelTurns.find((item) => item.assistantTurnId === event.assistantTurnId);
			const modelToolCall = modelTurn?.assistantToolCalls?.find((item) => item.toolCallId === event.toolCallId);
			const originMatches = modelTurn && modelTurn.providerResponseStatus === "reported" && modelToolCall?.toolName === event.toolName && modelToolCall.argumentsSha256 === event.argumentsSha256 && toolSettled?.assistantTurnId === modelTurn.assistantTurnId && toolSettled.toolName === modelToolCall.toolName && toolSettled.argumentsSha256 === modelToolCall.argumentsSha256 && event.providerResponseStatus === modelTurn.providerResponseStatus && event.providerResponseIdentitySha256 === modelTurn.providerResponseIdentitySha256 && toolSettled.providerResponseStatus === modelTurn.providerResponseStatus && toolSettled.providerResponseIdentitySha256 === modelTurn.providerResponseIdentitySha256;
			if (!event.toolSpecPlanId || toolSettled?.toolSpecPlanId !== event.toolSpecPlanId || !plan?.directTools?.includes(event.toolName) || !originMatches || !(modelTurn.sequence < event.sequence) || !(event.sequence < toolSettled?.sequence) || !(toolSettled.sequence < verification?.sequence)) failures.push(`Live Pi Tool ${event.toolName} lacks its exact assistant Turn, Provider response, prior Tool Spec, unique settlement, or pre-Verification ordering for ${scenario.id}`);
		}
		for (const { event: modelTurn, call: modelToolCall } of allModelToolCalls) {
			const startedEvent = started.find((event) => event.toolCallId === modelToolCall.toolCallId); const settledEvent = settled.find((event) => event.toolCallId === modelToolCall.toolCallId);
			if (startedCounts.get(modelToolCall.toolCallId) !== 1 || settledCounts.get(modelToolCall.toolCallId) !== 1 || startedEvent?.assistantTurnId !== modelTurn.assistantTurnId || settledEvent?.assistantTurnId !== modelTurn.assistantTurnId) failures.push(`Live Pi assistant Tool call lacks one exact same-Turn execution for ${scenario.id}`);
		}
		const successfulToolEvents = events.filter((event) => event.type === "tool.settled" && event.status === "succeeded");
		const allowedTools = new Set(selected.flatMap((candidate) => candidate.kind === "skill" ? ["capability_discover", "skill_read", "skill_complete"] : [`eval_${candidate.name}`, "capability_discover"]));
		if (successfulToolEvents.some((event) => !allowedTools.has(event.toolName))) failures.push(`Live Pi outcome used an unnecessary Tool for ${scenario.id}`);
		const capabilityReceipts = successfulToolEvents.filter((event) => event.capabilityReceipt).map((event) => ({ event, receipt: event.capabilityReceipt }));
		if (new Set(capabilityReceipts.map((item) => item.receipt.id)).size !== capabilityReceipts.length) failures.push(`Live Pi Capability receipts are duplicated for ${scenario.id}`);
		const skillLifecycleReceipts = successfulToolEvents.filter((event) => event.skillLifecycleReceipt).map((event) => ({ event, receipt: event.skillLifecycleReceipt }));
		if (new Set(skillLifecycleReceipts.map((item) => item.receipt.id)).size !== skillLifecycleReceipts.length) failures.push(`Live Pi Skill lifecycle receipts are duplicated for ${scenario.id}`);
		for (const item of skillLifecycleReceipts) {
			const candidate = selected.find((entry) => entry.kind === "skill" && entry.name === item.receipt.name && entry.version === item.receipt.version);
			const expectedTool = { activated: "skill_activate", routed: "skill_route", resource_read: "skill_resource_read", read: "skill_read", completed: "skill_complete" }[item.receipt.phase];
			if (!candidate || typeof item.receipt.id !== "string" || item.receipt.sourceTool !== expectedTool || item.event.toolName !== expectedTool) failures.push(`Live Pi outcome has an invalid Skill lifecycle receipt for ${scenario.id}`);
		}
		for (const event of successfulToolEvents) {
			const directCandidate = selected.find((candidate) => candidate.kind !== "skill" && event.toolName === `eval_${candidate.name}`);
			if (directCandidate && (!event.capabilityReceipt || event.capabilityReceipt.name !== directCandidate.name)) failures.push(`Live Pi Direct Capability execution lacks its required receipt for ${scenario.id}`);
			if (event.toolName === "skill_read" && event.skillLifecycleReceipt?.phase !== "read") failures.push(`Live Pi skill_read lacks its required lifecycle receipt for ${scenario.id}`);
			if (event.toolName === "skill_complete" && (event.skillLifecycleReceipt?.phase !== "completed" || event.capabilityReceipt?.kind !== "skill")) failures.push(`Live Pi skill_complete lacks its required lifecycle and Capability receipts for ${scenario.id}`);
		}
		for (const item of capabilityReceipts) {
			const candidate = selected.find((entry) => entry.kind === item.receipt.kind && entry.name === item.receipt.name && entry.version === item.receipt.version);
			const expectedSource = candidate?.kind === "skill" ? "skill_complete" : candidate ? `eval_${candidate.name}` : undefined;
			if (!candidate || typeof item.receipt.id !== "string" || item.receipt.sourceTool !== item.event.toolName || item.event.toolName !== expectedSource) failures.push(`Live Pi outcome has an invalid Capability receipt for ${scenario.id}`);
			if (candidate?.kind === "skill") {
				const read = skillLifecycleReceipts.find((entry) => entry.receipt.name === candidate.name && entry.receipt.version === candidate.version && entry.receipt.phase === "read");
				const completed = skillLifecycleReceipts.find((entry) => entry.receipt.name === candidate.name && entry.receipt.version === candidate.version && entry.receipt.phase === "completed" && entry.event === item.event);
				if (!read || !completed || !(read.event.sequence < completed.event.sequence)) failures.push(`Live Pi Skill lifecycle is incomplete or out of order for ${scenario.id}`);
			}
		}
		const activated = capabilityReceipts.map((item) => item.receipt.name);
		if (new Set(activated).size !== activated.length) failures.push(`Live Pi activated a Capability more than once for ${scenario.id}`);
		const required = scenario.required?.length ? scenario.required : scenario.expected ? [scenario.expected] : [];
		const expectedAccepted = required.every((name) => activated.includes(name)) && (scenario.forbidden ?? []).every((name) => !activated.includes(name)) && (required.length > 0 || activated.length === 0);
		const expectedVerification = expectedAccepted ? "accepted" : "rejected"; const expectedExecution = expectedAccepted ? "succeeded" : "failed";
		if (verification?.status !== expectedVerification || downstream?.status !== expectedVerification || execution?.status !== expectedExecution || receipt.verificationStatus !== expectedVerification || receipt.status !== expectedExecution) failures.push(`Live Pi independent Verification is invalid for ${scenario.id}`);
		if (receipt.verificationStatus === "accepted") accepted++;
	}
	if (outcome.accepted !== accepted || accepted / capabilityRankingCases.length < 0.95) failures.push("Live Pi outcome completion is below the release gate or does not match its receipts");
}

function independentlyVerifyProductionWorkContracts(receipts) {
	const workContractFailures = [];
	for (const receipt of receipts) {
		const caseId = typeof receipt?.caseId === "string" && receipt.caseId ? receipt.caseId : "unknown";
		const evidence = receipt?.workContract;
		if (evidence?.source !== "model") workContractFailures.push(`${caseId}:source_not_model`);
		if (!independentlyValidSemanticWorkContractEvidence(evidence)) workContractFailures.push(`${caseId}:semantic_adjudication_missing`);
		if (!Number.isFinite(evidence?.cognitionBudgetChargeTokens) || evidence.cognitionBudgetChargeTokens <= 0) workContractFailures.push(`${caseId}:cognition_charge_missing`);
		if (!independentlyValidCredentialResolutionEvidence(evidence)) workContractFailures.push(`${caseId}:credential_resolver_unread`);
	}
	return workContractFailures;
}

function independentlyValidSemanticWorkContractEvidence(evidence) {
	const adjudication = evidence?.semanticAdjudication; const usage = evidence?.cognitionUsage;
	if (evidence?.semanticAdjudicationValid !== true || adjudication?.schemaVersion !== "beemax.work-contract-adjudication.v1" || adjudication?.inventorySchemaVersion !== "beemax.semantic-inventory.v1" || adjudication?.independentSamples !== true) return false;
	const primary = adjudication.primaryModelIdentity; const reviewer = adjudication.reviewerModelIdentity;
	if (typeof primary !== "string" || !primary || typeof reviewer !== "string" || !reviewer) return false;
	if (adjudication.reviewMode === "different_models" ? primary === reviewer : adjudication.reviewMode !== "same_model_independent_samples" || primary !== reviewer) return false;
	if (!Number.isFinite(adjudication.cognitionBudgetChargeTokens) || adjudication.cognitionBudgetChargeTokens !== evidence.cognitionBudgetChargeTokens) return false;
	if (!usage || ![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.costUsd].every((value) => Number.isFinite(value) && value >= 0) || !Array.isArray(usage.modelIdentities) || usage.modelIdentities.length < 2 || !usage.modelIdentities.every((value) => typeof value === "string" && value)) return false;
	if (evidence.cognitionBudgetChargeTokens < usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens) return false;
	if (!usage.modelIdentities.includes(primary) || !usage.modelIdentities.includes(reviewer)) return false;
	return [primary, reviewer].every((identity) => artifact.models.some((modelId) => identity.startsWith(`${modelId}/`))) && independentlyValidWorkContractProviderTurns(evidence, usage, adjudication);
}

function independentlyValidCredentialResolutionEvidence(evidence) {
	const resolutions = evidence?.credentialResolutions;
	if (!Array.isArray(resolutions) || !resolutions.length || evidence.credentialResolverReads !== resolutions.length) return false;
	if (!resolutions.every((item) => item && typeof item.provider === "string" && item.provider && typeof item.modelIdentity === "string" && item.modelIdentity && (item.source === "profile_auth_storage" || item.source === "profile_config"))) return false;
	const identities = new Set(resolutions.map((item) => item.modelIdentity)); const adjudication = evidence.semanticAdjudication;
	if (!identities.has(adjudication?.primaryModelIdentity) || !identities.has(adjudication?.reviewerModelIdentity)) return false;
	const resolutionCounts = countBy(resolutions, (item) => item.modelIdentity); const turnCounts = countBy(evidence.providerTurns ?? [], (item) => item.modelIdentity);
	return [...turnCounts].every(([identity, count]) => (resolutionCounts.get(identity) ?? 0) >= count);
}

function independentlyValidWorkContractProviderTurns(evidence, usage, adjudication) {
	const turns = evidence?.providerTurns;
	if (!Array.isArray(turns) || turns.length < 2 || !turns.every((turn) => turn && (turn.lane === "work_contract" || turn.lane === "semantic_inventory") && typeof turn.modelIdentity === "string" && /^sha256:[a-f0-9]{64}$/i.test(turn.providerResponseIdentitySha256 ?? "") && [turn.inputTokens, turn.outputTokens, turn.cacheReadTokens, turn.cacheWriteTokens, turn.costUsd].every((value) => Number.isFinite(value) && value >= 0))) return false;
	if (new Set(turns.map((turn) => turn.providerResponseIdentitySha256)).size !== turns.length) return false;
	if (!turns.some((turn) => turn.lane === "work_contract" && turn.modelIdentity === adjudication.primaryModelIdentity) || !turns.some((turn) => turn.lane === "semantic_inventory" && turn.modelIdentity === adjudication.reviewerModelIdentity)) return false;
	const sum = (key) => turns.reduce((total, turn) => total + turn[key], 0);
	return sum("inputTokens") === usage.inputTokens && sum("outputTokens") === usage.outputTokens && sum("cacheReadTokens") === usage.cacheReadTokens && sum("cacheWriteTokens") === usage.cacheWriteTokens && Math.abs(sum("costUsd") - usage.costUsd) < 1e-12;
}

function countBy(items, keyOf) { const counts = new Map(); for (const item of items) { const key = keyOf(item); counts.set(key, (counts.get(key) ?? 0) + 1); } return counts; }

function independentlySummarizeLivePiOutcomeReceipts(receipts) {
	const cases = receipts.length;
	let modelTurns = 0; let measuredTurns = 0; let providerReportedTurns = 0; let providerUnavailableTurns = 0; let totalInputTokens = 0; let totalOutputTokens = 0; let totalCostUsd = 0; let totalDurationMs = 0; let maxDurationMs = 0; let maxTokensPerCase = 0; let maxModelTurnsPerCase = 0;
	for (const receipt of receipts) {
		const events = Array.isArray(receipt?.executionTrace) ? receipt.executionTrace : [];
		const turns = events.filter((event) => event?.type === "model.turn_settled");
		const inputTokens = turns.reduce((total, event) => total + independentFiniteNonnegative(event.inputTokens), 0);
		const outputTokens = turns.reduce((total, event) => total + independentFiniteNonnegative(event.outputTokens), 0);
		const started = events.find((event) => event?.type === "execution.started");
		const settled = [...events].reverse().find((event) => event?.type === "execution.settled");
		const durationMs = Number.isFinite(started?.at) && Number.isFinite(settled?.at) ? Math.max(0, settled.at - started.at) : 0;
		modelTurns += turns.length;
		measuredTurns += turns.filter((event) => Number.isFinite(event.inputTokens) && event.inputTokens >= 0 && Number.isFinite(event.outputTokens) && event.outputTokens >= 0 && event.inputTokens + event.outputTokens > 0).length;
		providerReportedTurns += turns.filter((event) => event.providerResponseStatus === "reported").length;
		providerUnavailableTurns += turns.filter((event) => event.providerResponseStatus === "unavailable").length;
		totalInputTokens += inputTokens; totalOutputTokens += outputTokens;
		totalCostUsd += turns.reduce((total, event) => total + independentFiniteNonnegative(event.costUsd), 0);
		totalDurationMs += durationMs; maxDurationMs = Math.max(maxDurationMs, durationMs); maxTokensPerCase = Math.max(maxTokensPerCase, inputTokens + outputTokens); maxModelTurnsPerCase = Math.max(maxModelTurnsPerCase, turns.length);
	}
	return { cases, modelTurns, usageMeasurementRate: modelTurns ? measuredTurns / modelTurns : 0, providerReportedTurns, providerUnavailableTurns, providerResponseReportingRate: modelTurns ? providerReportedTurns / modelTurns : 0, totalInputTokens, totalOutputTokens, totalTokens: totalInputTokens + totalOutputTokens, averageTokensPerCase: cases ? (totalInputTokens + totalOutputTokens) / cases : 0, maxTokensPerCase, totalCostUsd: Math.round(totalCostUsd * 1e12) / 1e12, costEvidence: totalCostUsd > 0 ? "provider_reported" : "unpriced", averageDurationMs: cases ? totalDurationMs / cases : 0, maxDurationMs, maxModelTurnsPerCase };
}

function independentlyVerifyLivePiBudget(metrics, budget) {
	const budgetFailures = [];
	if (metrics.usageMeasurementRate !== 1) budgetFailures.push("usage_incomplete");
	if (metrics.averageTokensPerCase > budget.maxAverageTokensPerCase) budgetFailures.push("average_tokens_exceeded");
	if (metrics.maxTokensPerCase > budget.maxTokensPerCase) budgetFailures.push("case_tokens_exceeded");
	if (metrics.averageDurationMs > budget.maxAverageDurationMs) budgetFailures.push("average_duration_exceeded");
	if (metrics.maxDurationMs > budget.maxDurationMs) budgetFailures.push("case_duration_exceeded");
	if (metrics.maxModelTurnsPerCase > budget.maxModelTurnsPerCase) budgetFailures.push("model_turns_exceeded");
	return budgetFailures;
}

function independentFiniteNonnegative(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, artifact: path, passed: failures.length === 0, failures }, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

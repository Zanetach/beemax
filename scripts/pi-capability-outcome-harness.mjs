import { mkdtempSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
	BeeMaxAgentRuntime,
	FileExecutionTraceStore,
	buildBeeMaxRuntimeFactory,
	createAccessScopeRef,
	createExecutionEnvelope,
	defineTool,
	READ_ONLY_TOOL_POLICY,
	withToolPolicy,
} from "../packages/core/dist/index.js";
import { capabilityInventory, capabilityRankingCases } from "../evals/capability-ranking-corpus.mjs";

export const LIVE_PI_OUTCOME_BUDGET = Object.freeze({
	maxAverageTokensPerCase: 4_000,
	maxTokensPerCase: 6_000,
	maxAverageDurationMs: 30_000,
	maxDurationMs: 90_000,
	maxModelTurnsPerCase: 4,
});

export async function executeLivePiCapabilityOutcomeRun({ models, model, apiKey, threshold, observedRankings }) {
	const modelCandidates = livePiModelCandidates({ models, model, apiKey });
	const rankingByCase = new Map(observedRankings.map((ranking) => [ranking.caseId, ranking]));
	const runId = `execution:live-pi:${randomUUID()}`;
	const receipts = [];
	for (const scenario of capabilityRankingCases) {
		const ranking = rankingByCase.get(scenario.id);
		if (!ranking) throw new Error(`Live Pi outcome is missing ranking ${scenario.id}`);
		receipts.push(await executeLivePiCapabilityTask({ scenario, ranking, threshold, models: modelCandidates, runId }));
	}
	const metrics = summarizeLivePiOutcomeReceipts(receipts);
	return {
		schemaVersion: 1,
		mode: "live_pi",
		runId,
		generatedAt: new Date().toISOString(),
		modelId: `${modelCandidates[0].model.provider}/${modelCandidates[0].model.id}`,
		cases: receipts.length,
		accepted: receipts.filter((receipt) => receipt.verificationStatus === "accepted").length,
		metrics,
		budget: LIVE_PI_OUTCOME_BUDGET,
		budgetFailures: livePiBudgetFailures(metrics, LIVE_PI_OUTCOME_BUDGET),
		receipts,
	};
}

export async function executeLivePiCapabilityTask({ scenario, ranking, threshold, models, model, apiKey, createAgent, runId = "execution:live-pi" }) {
	const root = mkdtempSync(join(tmpdir(), "beemax-live-pi-capability-"));
	try { return await executeLivePiCapabilityTaskInRoot({ scenario, ranking, threshold, models: livePiModelCandidates({ models, model, apiKey }), createAgent, runId }, root); }
	finally { rmSync(root, { recursive: true, force: true }); }
}

async function executeLivePiCapabilityTaskInRoot({ scenario, ranking, threshold, models, createAgent, runId }, root) {
	const primary = models[0];
	const candidates = ranking.candidates.filter((candidate) => candidate.confidence >= threshold);
	const descriptors = new Map(capabilityInventory.map((descriptor) => [descriptor.name, descriptor]));
	const sourceByCapability = new Map(candidates.map((candidate) => [candidate.name, candidate.kind === "skill" ? "skill_complete" : `eval_${candidate.name}`]));
	const readSkills = new Set();
	const completed = new Set();
	const trace = new FileExecutionTraceStore(join(root, "trace.jsonl"), 1_000);
	const executionId = `${runId}:${scenario.id}`;
	const scopeId = `scope:live-pi:${scenario.id}`;
	const source = { platform: "cli", chatId: `live-pi-${scenario.id}`, chatType: "dm", userId: "evaluator" };
	const tools = createLivePiEvaluationTools({ candidates, descriptors, sourceByCapability, readSkills, completed, cognitionId: ranking.cognitionId });
	const factory = createAgent ?? buildBeeMaxRuntimeFactory({
		provider: "custom",
		model: primary.model.id,
		baseUrl: primary.model.baseUrl,
		customProtocol: primary.model.api,
		modelLimits: { contextWindow: primary.model.contextWindow, maxTokens: primary.model.maxTokens },
		cwd: root,
		agentDir: join(root, "agent"),
		getApiKey: (provider) => models.find((candidate) => candidate.model.provider === provider)?.apiKey ?? primary.apiKey,
		additionalModelProviders: models.map((candidate) => candidate.model.provider),
		systemPrompt: "You are a capability execution evaluator. Read the user's request and the current BeeMax Tool Spec. Call every and only the tools needed to satisfy it. Never claim completion without the tool result. If no tool is needed, answer directly without calling capability_discover. capability_discover is only for an unresolved explicit capability requirement. For a selected Skill, call skill_read with its exact name and then skill_complete with the same name.",
		skillToolset: "safe",
		tools: tools.map((tool) => tool.name),
		createTools: () => tools,
	});
	const required = scenario.required?.length ? scenario.required : scenario.expected ? [scenario.expected] : [];
	const forbidden = scenario.forbidden ?? [];
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:live-pi-eval",
		fallbackModels: models.slice(1).map((candidate) => candidate.model),
		maxModelFallbacks: Math.max(0, models.length - 1),
		taskLedger: evaluationLedger(),
		executionTrace: trace,
		turnUnderstanding: { understand: () => ({ action: "create", goal: scenario.query, constraints: [], acceptanceCriteria: [scenario.query], uncertainties: [], memoryQuery: scenario.query, capabilityQuery: scenario.query, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => ({ source: "model", contract: { schemaVersion: "beemax.work-contract.v1", rawRequest: scenario.query, action: "create", objective: clause(scenario.query), constraints: [], prohibitions: [], acceptanceCriteria: [clause(scenario.query)], capabilityRequirements: candidates.length ? [clause(scenario.query)] : [], uncertainties: [], executionMode: "direct", confidence: 1 } }) },
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: 12, maxTokens: 8_000, maxCorrectiveAttempts: 1 }, signals: { substantialWork: true, requiresVerification: true }, reason: "live Pi capability outcome", directive: () => "Use the current Tool Spec to complete the request; do not describe hypothetical calls." }) },
		verifyObjectiveCandidate: async (_task, _answer, _signal, context) => {
			const successful = new Set(context?.successfulToolNames ?? []);
			const activated = candidates.filter((candidate) => candidate.kind === "skill" ? completed.has(candidate.name) : successful.has(sourceByCapability.get(candidate.name))).map((candidate) => candidate.name);
			const allowedTools = new Set(candidates.flatMap((candidate) => candidate.kind === "skill" ? ["capability_discover", "skill_read", "skill_complete"] : [`eval_${candidate.name}`, "capability_discover"]));
			const accepted = [...successful].every((toolName) => allowedTools.has(toolName)) && required.every((name) => activated.includes(name)) && forbidden.every((name) => !activated.includes(name)) && (required.length > 0 || activated.length === 0);
			return { accepted, feedback: accepted ? undefined : "The model did not produce the exact required Capability receipts." };
		},
		createAgent: factory,
	});
	const accessScopeRef = createAccessScopeRef({ id: scopeId, authority: { kind: "enterprise_system", reference: "live-pi-evaluator" }, issuedAt: 1 });
	const envelope = createExecutionEnvelope({ executionId, trigger: { kind: "interaction" }, accessScopeRef, budget: { maxToolCalls: 12, maxTokens: 8_000, maxCorrectiveAttempts: 1 }, mode: "normal" });
	let result;
	try { result = await runtime.run({ source, text: scenario.query, timeoutMs: 90_000, accessScopeRef, executionEnvelope: envelope }); }
	catch (error) { result = { answer: "", error: error instanceof Error ? error.message : String(error) }; }
	finally { runtime.dispose(); }
	const execution = trace.trace({ executionId, accessScopeId: scopeId });
	const receipt = {
		caseId: scenario.id,
		cognitionId: ranking.cognitionId,
		executionId,
		accessScopeId: scopeId,
		selectedCandidates: candidates.map(({ kind, name, version, confidence }) => ({ kind, name, version, confidence })),
		status: execution?.status ?? "failed",
		verificationStatus: execution?.verificationStatus ?? "unavailable",
		answerChars: typeof result?.answer === "string" ? result.answer.length : 0,
		executionTrace: execution?.events ?? [],
	};
	return receipt;
}

function livePiModelCandidates({ models, model, apiKey }) {
	if (Array.isArray(models) && models.length && models.every((candidate) => candidate?.model)) return models;
	if (model) return [{ model, apiKey }];
	throw new Error("Live Pi Capability outcome requires at least one configured model");
}

export function summarizeLivePiOutcomeReceipts(receipts) {
	const cases = receipts.length;
	let modelTurns = 0; let measuredTurns = 0; let providerReportedTurns = 0; let providerUnavailableTurns = 0; let totalInputTokens = 0; let totalOutputTokens = 0; let totalCostUsd = 0; let totalDurationMs = 0; let maxDurationMs = 0; let maxTokensPerCase = 0; let maxModelTurnsPerCase = 0;
	for (const receipt of receipts) {
		const events = Array.isArray(receipt?.executionTrace) ? receipt.executionTrace : [];
		const turns = events.filter((event) => event.type === "model.turn_settled");
		const tokens = turns.reduce((total, event) => total + finiteNonnegative(event.inputTokens) + finiteNonnegative(event.outputTokens), 0);
		const started = events.find((event) => event.type === "execution.started");
		const settled = [...events].reverse().find((event) => event.type === "execution.settled");
		const durationMs = Number.isFinite(started?.at) && Number.isFinite(settled?.at) ? Math.max(0, settled.at - started.at) : 0;
		modelTurns += turns.length;
		measuredTurns += turns.filter((event) => Number.isFinite(event.inputTokens) && event.inputTokens >= 0 && Number.isFinite(event.outputTokens) && event.outputTokens >= 0 && event.inputTokens + event.outputTokens > 0).length;
		providerReportedTurns += turns.filter((event) => event.providerResponseStatus === "reported").length;
		providerUnavailableTurns += turns.filter((event) => event.providerResponseStatus === "unavailable").length;
		totalInputTokens += turns.reduce((total, event) => total + finiteNonnegative(event.inputTokens), 0);
		totalOutputTokens += turns.reduce((total, event) => total + finiteNonnegative(event.outputTokens), 0);
		totalCostUsd += turns.reduce((total, event) => total + finiteNonnegative(event.costUsd), 0);
		totalDurationMs += durationMs;
		maxDurationMs = Math.max(maxDurationMs, durationMs);
		maxTokensPerCase = Math.max(maxTokensPerCase, tokens);
		maxModelTurnsPerCase = Math.max(maxModelTurnsPerCase, turns.length);
	}
	return { cases, modelTurns, usageMeasurementRate: modelTurns ? measuredTurns / modelTurns : 0, providerReportedTurns, providerUnavailableTurns, providerResponseReportingRate: modelTurns ? providerReportedTurns / modelTurns : 0, totalInputTokens, totalOutputTokens, totalTokens: totalInputTokens + totalOutputTokens, averageTokensPerCase: cases ? (totalInputTokens + totalOutputTokens) / cases : 0, maxTokensPerCase, totalCostUsd: Math.round(totalCostUsd * 1e12) / 1e12, costEvidence: totalCostUsd > 0 ? "provider_reported" : "unpriced", averageDurationMs: cases ? totalDurationMs / cases : 0, maxDurationMs, maxModelTurnsPerCase };
}

export function livePiBudgetFailures(metrics, budget = LIVE_PI_OUTCOME_BUDGET) {
	const failures = [];
	if (metrics.usageMeasurementRate !== 1) failures.push("usage_incomplete");
	if (metrics.averageTokensPerCase > budget.maxAverageTokensPerCase) failures.push("average_tokens_exceeded");
	if (metrics.maxTokensPerCase > budget.maxTokensPerCase) failures.push("case_tokens_exceeded");
	if (metrics.averageDurationMs > budget.maxAverageDurationMs) failures.push("average_duration_exceeded");
	if (metrics.maxDurationMs > budget.maxDurationMs) failures.push("case_duration_exceeded");
	if (metrics.maxModelTurnsPerCase > budget.maxModelTurnsPerCase) failures.push("model_turns_exceeded");
	return failures;
}

function finiteNonnegative(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }

export function createLivePiEvaluationTools({ candidates, descriptors, sourceByCapability, readSkills, completed, cognitionId }) {
	const direct = candidates.filter((candidate) => candidate.kind !== "skill").map((candidate) => {
		const sourceTool = sourceByCapability.get(candidate.name);
		return Object.assign(withToolPolicy(defineTool({ name: sourceTool, label: candidate.name, description: descriptors.get(candidate.name)?.description ?? candidate.name, parameters: Type.Object({}, { additionalProperties: true }), execute: async () => ({ content: [{ type: "text", text: `verified capability result: ${candidate.name}` }], details: { capabilityReceipt: { id: `receipt:live-pi:${candidate.kind}:${candidate.name}:${candidate.version}`, kind: candidate.kind, name: candidate.name, version: candidate.version, sourceTool } } }) }), READ_ONLY_TOOL_POLICY), { beemaxToolSpec: { kind: candidate.kind, version: candidate.version, configured: true, health: "ready", authorized: true } });
	});
	const skills = candidates.filter((candidate) => candidate.kind === "skill");
	const skillRead = Object.assign(withToolPolicy(defineTool({ name: "skill_read", label: "Read Skill", description: "Read the exact selected Skill before completing it", parameters: Type.Object({ name: Type.String() }), execute: async (toolCallId, args) => { const candidate = skills.find((item) => item.name === args.name); if (!candidate) throw new Error("Unknown selected Skill"); readSkills.add(candidate.name); return { content: [{ type: "text", text: `loaded ${candidate.name}` }], details: { descriptor: { name: candidate.name }, skill: candidate.name, activatedTools: ["skill_complete"], skillLifecycleReceipt: { id: livePiReceiptId("skill-read", candidate, toolCallId), name: candidate.name, version: candidate.version, phase: "read", sourceTool: "skill_read" } } }; } }), READ_ONLY_TOOL_POLICY), { beemaxToolSpec: { kind: "skill", version: "eval:lifecycle", configured: true, health: "ready", authorized: true } });
	const skillComplete = Object.assign(withToolPolicy(defineTool({ name: "skill_complete", label: "Complete Skill", description: "Complete the Skill after reading it", parameters: Type.Object({ name: Type.String() }), execute: async (toolCallId, args) => { const candidate = skills.find((item) => item.name === args.name); if (!candidate) throw new Error("Unknown selected Skill"); if (!readSkills.has(candidate.name)) throw new Error("Selected Skill must be read before completion"); completed.add(candidate.name); return { content: [{ type: "text", text: `completed ${candidate.name}` }], details: { skill: candidate.name, skillLifecycleReceipt: { id: livePiReceiptId("skill-complete", candidate, toolCallId), name: candidate.name, version: candidate.version, phase: "completed", sourceTool: "skill_complete" }, capabilityReceipt: { id: `receipt:live-pi:skill:${candidate.name}:${candidate.version}`, kind: "skill", name: candidate.name, version: candidate.version, sourceTool: "skill_complete" } } }; } }), READ_ONLY_TOOL_POLICY), { beemaxToolSpec: { kind: "skill", version: "eval:lifecycle", configured: true, health: "ready", authorized: true } });
	const prefetch = async () => ({ cognitionId, candidates, activatedTools: direct.map((tool) => tool.name), skills: skills.map(({ name }) => ({ name })) });
	const discover = Object.assign(withToolPolicy(defineTool({ name: "capability_discover", label: "Discover Capabilities", description: "Discover the already selected evaluation capabilities", parameters: Type.Object({ query: Type.Optional(Type.String()) }), execute: async () => ({ content: [{ type: "text", text: "Evaluation capabilities are already selected." }], details: { cognitionId, ranked: candidates, activatedTools: direct.map((tool) => tool.name) } }) }), READ_ONLY_TOOL_POLICY), { beemaxCapabilityPrefetch: prefetch, beemaxToolSpec: { kind: "tool", version: "eval:discovery", configured: true, health: "ready", authorized: true } });
	return [discover, ...direct, ...(skills.length ? [skillRead, skillComplete] : [])];
}

function livePiReceiptId(phase, candidate, toolCallId) { return `receipt:live-pi:${phase}:${candidate.name}:${candidate.version}:${createHash("sha256").update(toolCallId).digest("hex")}`; }

function clause(text) { return { text, source: { kind: "raw_request", start: 0, end: text.length } }; }
function evaluationLedger() { const tasks = new Map(); const runs = new Map(); return { record(task) { tasks.set(task.id, { ...task }); }, transition(id, change) { const task = tasks.get(id); if (!task) return false; tasks.set(id, { ...task, ...change }); return true; }, recordRun(run) { runs.set(run.id, { ...run }); }, transitionRun(id, change) { const run = runs.get(id); if (!run) return false; runs.set(id, { ...run, ...change }); return true; }, queryTasks(query) { return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id)).slice(0, query.limit ?? 100); }, taskRuns(taskId) { return [...runs.values()].filter((run) => run.taskId === taskId); }, checkpointTask() { return true; }, deferCandidateVerification() {} }; }

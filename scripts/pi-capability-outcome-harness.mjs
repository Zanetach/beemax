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
import { attestCapabilityProviderResolutionTool } from "../packages/core/dist/capability-provider.js";
import { capabilityInventory, capabilityRankingCases } from "../evals/capability-ranking-corpus.mjs";

export const LIVE_PI_COMPLETION_REQUIREMENTS = Object.freeze({
	minimumCaseUsageMeasurementRate: 1,
	minimumCaseProviderResponseReportingRate: 1,
});
const LIVE_PI_SKILL_PHASES = Object.freeze([
	["skill_read", "read"],
	["skill_activate", "activated"],
	["skill_route", "routed"],
	["skill_resource_read", "resource_read"],
	["skill_complete", "completed"],
]);

export async function executeLivePiCapabilityOutcomeRun({ models, model, apiKey, threshold, observedRankings, workContractBuilder, createCaseContext, executeTask = executeLivePiCapabilityTask, concurrency }) {
	const modelCandidates = livePiModelCandidates({ models, model, apiKey });
	const rankingByCase = new Map(observedRankings.map((ranking) => [ranking.caseId, ranking]));
	const runId = `execution:live-pi:${randomUUID()}`;
	const requestedConcurrency = concurrency ?? (createCaseContext ? 4 : 1);
	const receipts = await mapWithConcurrency(capabilityRankingCases, requestedConcurrency, async (scenario) => {
		const ranking = rankingByCase.get(scenario.id);
		if (!ranking) throw new Error(`Live Pi outcome is missing ranking ${scenario.id}`);
		const isolated = typeof createCaseContext === "function" ? await createCaseContext({ scenario, ranking }) : {};
		return executeTask({
			scenario,
			ranking,
			threshold,
			models: isolated?.models ?? modelCandidates,
			runId,
			workContractBuilder: isolated?.workContractBuilder ?? workContractBuilder,
		});
	});
	const metrics = summarizeLivePiOutcomeReceipts(receipts);
	const admissionFailures = livePiModelFirstAdmissionFailures(receipts);
	return {
		schemaVersion: 3,
		mode: "live_pi_model_first",
		runId,
		generatedAt: new Date().toISOString(),
		modelId: `${modelCandidates[0].model.provider}/${modelCandidates[0].model.id}`,
		cases: receipts.length,
		accepted: receipts.filter((receipt) => receipt.completion?.status === "accepted").length,
		metrics,
		completionRequirements: LIVE_PI_COMPLETION_REQUIREMENTS,
		evidenceFailures: livePiEvidenceFailures(metrics, LIVE_PI_COMPLETION_REQUIREMENTS),
		admissionFailures,
		receipts,
	};
}

export async function executeLivePiCapabilityTask({ scenario, ranking, threshold, models, model, apiKey, createAgent, workContractBuilder, runId = "execution:live-pi" }) {
	const root = mkdtempSync(join(tmpdir(), "beemax-live-pi-capability-"));
	try { return await executeLivePiCapabilityTaskInRoot({ scenario, ranking, threshold, models: livePiModelCandidates({ models, model, apiKey }), createAgent, workContractBuilder, runId }, root); }
	finally { rmSync(root, { recursive: true, force: true }); }
}

async function executeLivePiCapabilityTaskInRoot({ scenario, ranking, threshold, models, createAgent, workContractBuilder, runId }, root) {
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
	const required = scenario.required?.length ? scenario.required : scenario.expected ? [scenario.expected] : [];
	const tools = createLivePiEvaluationTools({ candidates, descriptors, sourceByCapability, readSkills, completed, cognitionId: ranking.cognitionId, requiredCapabilities: required });
	const factory = createAgent ?? buildBeeMaxRuntimeFactory({
		provider: "custom",
		model: primary.model.id,
		baseUrl: primary.model.baseUrl,
		customProtocol: primary.model.api,
		modelLimits: { contextWindow: primary.model.contextWindow, maxTokens: primary.model.maxTokens },
		cwd: root,
		agentDir: join(root, "agent"),
		getApiKey: async (provider) => {
			const candidate = models.find((item) => item.model.provider === provider) ?? primary;
			return candidate.apiKey ?? await candidate.getApiKey?.();
		},
		additionalModelProviders: models.map((candidate) => candidate.model.provider),
		systemPrompt: "You are a capability execution evaluator. Read the user's request and the current BeeMax Tool Spec. Call every and only the tools needed to satisfy it. Never claim completion without the tool result. If no tool is needed, answer directly without calling capability_discover. capability_discover is only for an unresolved explicit capability requirement. For a selected Skill, execute its progressive lifecycle exactly once and in this order with the exact selected name: skill_read, skill_activate, skill_route, skill_resource_read, skill_complete. Do not skip or repeat a phase; use route 'default' and resource path 'references/checklist.md'. After skill_complete, answer immediately and never call another Skill lifecycle Tool.",
		skillToolset: "safe",
		tools: tools.map((tool) => tool.name),
		createTools: () => tools,
	});
	const forbidden = scenario.forbidden ?? [];
	let workContractBuilds = 0;
	const observedWorkContractBuilder = {
		build: async (input) => {
			workContractBuilds++;
			if (workContractBuilder?.build) return workContractBuilder.build(input);
			throw new Error("Model-first interactive admission unexpectedly requested a Work Contract");
		},
	};
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:live-pi-eval",
		interactiveAdmission: "model_first",
		fallbackModels: models.slice(1).map((candidate) => candidate.model),
		maxModelFallbacks: Math.max(0, models.length - 1),
		executionTrace: trace,
		turnUnderstanding: { understand: () => ({ action: "create", goal: scenario.query, constraints: [], acceptanceCriteria: [scenario.query], uncertainties: [], memoryQuery: scenario.query, capabilityQuery: scenario.query, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: observedWorkContractBuilder,
		planningPolicy: { decide: () => ({ mode: "direct", basis: "raw_prompt", verificationDepth: "independent", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 1 }, signals: { substantialWork: true, requiresVerification: true }, reason: "live Pi capability outcome", directive: () => "Use the current Tool Spec to complete the request; do not describe hypothetical calls." }) },
		createAgent: factory,
	});
	const accessScopeRef = createAccessScopeRef({ id: scopeId, authority: { kind: "enterprise_system", reference: "live-pi-evaluator" }, issuedAt: 1 });
	const envelope = createExecutionEnvelope({ executionId, trigger: { kind: "interaction" }, accessScopeRef, budget: { maxCorrectiveAttempts: 1 }, mode: "normal" });
	let result;
	const runEvents = [];
	try { result = await runtime.run({ source, text: scenario.query, timeoutMs: null, accessScopeRef, executionEnvelope: envelope }, (event) => { runEvents.push(event); }); }
	catch (error) { result = { answer: "", error: error instanceof Error ? error.message : String(error) }; }
	finally { runtime.dispose(); }
	const execution = trace.trace({ executionId, accessScopeId: scopeId });
	const answer = typeof result?.answer === "string" ? result.answer : "";
	const answerStatus = Boolean(answer.trim()) && answer !== "(no response)" ? "reported" : "missing";
	const planning = runEvents.find((event) => event.type === "planning_decision");
	const completion = evaluateLivePiModelFirstCompletion({ scenario, selectedCandidates: candidates, executionTrace: execution?.events ?? [], terminalAnswerPresent: answerStatus === "reported" });
	const receipt = {
		caseId: scenario.id,
		cognitionId: ranking.cognitionId,
		executionId,
		accessScopeId: scopeId,
		selectedCandidates: candidates.map(({ kind, name, version, confidence }) => ({ kind, name, version, confidence })),
		status: execution?.status ?? "failed",
		verificationStatus: execution?.verificationStatus ?? "unavailable",
		answerChars: answer.length,
		answerStatus,
		...(typeof result?.error === "string" && result.error ? { runtimeFailureMessage: safeEvaluationFailureMessage(result.error) } : {}),
		admission: { strategy: "model_first", planningBasis: planning?.basis ?? "unavailable", workContractBuilds, outcomeStatus: result?.outcome?.status ?? "unavailable" },
		completion,
		executionTrace: execution?.events ?? [],
	};
	return receipt;
}

export function livePiModelFirstAdmissionFailures(receipts) {
	const failures = [];
	for (const receipt of receipts) {
		const caseId = typeof receipt?.caseId === "string" && receipt.caseId ? receipt.caseId : "unknown";
		if (receipt?.admission?.strategy !== "model_first") failures.push(`${caseId}:strategy_not_model_first`);
		if (receipt?.admission?.planningBasis !== "raw_prompt") failures.push(`${caseId}:planning_basis_not_raw_prompt`);
		if (receipt?.admission?.workContractBuilds !== 0) failures.push(`${caseId}:work_contract_invoked`);
		if (receipt?.admission?.outcomeStatus !== "answered") failures.push(`${caseId}:outcome_not_turn_local`);
	}
	return failures;
}

export function evaluateLivePiModelFirstCompletion({ scenario, selectedCandidates, executionTrace, terminalAnswerPresent }) {
	const events = Array.isArray(executionTrace) ? executionTrace : [];
	const selected = Array.isArray(selectedCandidates) ? selectedCandidates : [];
	const required = scenario?.required?.length ? scenario.required : scenario?.expected ? [scenario.expected] : [];
	const forbidden = scenario?.forbidden ?? [];
	const execution = [...events].reverse().find((event) => event.type === "execution.settled");
	const started = events.filter((event) => event.type === "tool.started");
	const successful = events.filter((event) => event.type === "tool.settled" && event.status === "succeeded");
	const allowedTools = new Set(selected.flatMap((candidate) => candidate.kind === "skill" ? ["capability_discover", ...LIVE_PI_SKILL_PHASES.map(([toolName]) => toolName)] : [`eval_${candidate.name}`, "capability_discover"]));
	const capabilityEvents = successful.filter((event) => event.capabilityReceipt);
	const receiptIds = capabilityEvents.map((event) => event.capabilityReceipt?.id);
	const exactCapabilityReceipts = receiptIds.every((id) => typeof id === "string" && id)
		&& new Set(receiptIds).size === receiptIds.length
		&& capabilityEvents.every((event) => selected.some((candidate) => {
			const receipt = event.capabilityReceipt;
			const expectedSource = candidate.kind === "skill" ? "skill_complete" : `eval_${candidate.name}`;
			return receipt?.kind === candidate.kind && receipt?.name === candidate.name && receipt?.version === candidate.version && receipt?.sourceTool === expectedSource && event.toolName === expectedSource;
		}))
		&& successful.every((event) => {
			const direct = selected.some((candidate) => candidate.kind !== "skill" && event.toolName === `eval_${candidate.name}`);
			return !direct || Boolean(event.capabilityReceipt);
		});
	const activatedCapabilities = [...new Set(capabilityEvents.map((event) => event.capabilityReceipt.name))];
	const skillLifecycleComplete = selected.filter((candidate) => candidate.kind === "skill").every((candidate) => {
		const lifecycle = LIVE_PI_SKILL_PHASES.map(([toolName, phase]) => successful.filter((event) => event.toolName === toolName
			&& event.skillLifecycleReceipt?.name === candidate.name
			&& event.skillLifecycleReceipt?.version === candidate.version
			&& event.skillLifecycleReceipt?.phase === phase));
		return lifecycle.every((matches) => matches.length === 1)
			&& lifecycle.every((matches, index) => index === 0 || lifecycle[index - 1][0].sequence < matches[0].sequence)
			&& lifecycle.at(-1)?.[0]?.capabilityReceipt?.name === candidate.name;
	});
	const checks = {
		runtimeSucceeded: execution?.status === "succeeded",
		terminalAnswerPresent: terminalAnswerPresent === true,
		requiredCapabilitiesSatisfied: required.every((name) => activatedCapabilities.includes(name)),
		forbiddenCapabilitiesQuiet: forbidden.every((name) => !activatedCapabilities.includes(name)),
		noUnnecessaryCapabilityActivation: activatedCapabilities.every((name) => required.includes(name)) && (required.length > 0 || activatedCapabilities.length === 0),
		noUnexpectedToolExecution: started.every((event) => allowedTools.has(event.toolName)),
		exactCapabilityReceipts,
		skillLifecycleComplete,
	};
	return { authority: "system_trace_guard_v2", status: Object.values(checks).every(Boolean) ? "accepted" : "rejected", checks, activatedCapabilities };
}

function livePiModelCandidates({ models, model, apiKey }) {
	if (Array.isArray(models) && models.length && models.every((candidate) => candidate?.model)) return models;
	if (model) return [{ model, apiKey }];
	throw new Error("Live Pi Capability outcome requires at least one configured model");
}

export function summarizeLivePiOutcomeReceipts(receipts) {
	const cases = receipts.length;
	let modelTurns = 0; let measuredTurns = 0; let measuredCases = 0; let providerReportedTurns = 0; let providerReportedCases = 0; let providerUnavailableTurns = 0; let recoveredProviderUnavailableTurns = 0; let totalInputTokens = 0; let totalOutputTokens = 0; let totalCostUsd = 0; let totalDurationMs = 0; let maxDurationMs = 0; let maxTokensPerCase = 0; let maxModelTurnsPerCase = 0;
	for (const receipt of receipts) {
		const events = Array.isArray(receipt?.executionTrace) ? receipt.executionTrace : [];
		const turns = events.filter((event) => event.type === "model.turn_settled");
		const tokens = turns.reduce((total, event) => total + finiteNonnegative(event.inputTokens) + finiteNonnegative(event.outputTokens), 0);
		const started = events.find((event) => event.type === "execution.started");
		const settled = [...events].reverse().find((event) => event.type === "execution.settled");
		const durationMs = Number.isFinite(started?.at) && Number.isFinite(settled?.at) ? Math.max(0, settled.at - started.at) : 0;
		const measuredInCase = turns.some(isMeasuredProviderTurn);
		const providerReportedInCase = turns.some((event) => event.providerResponseStatus === "reported");
		const unavailableInCase = turns.filter((event) => event.providerResponseStatus === "unavailable").length;
		modelTurns += turns.length;
		measuredTurns += turns.filter(isMeasuredProviderTurn).length;
		measuredCases += measuredInCase ? 1 : 0;
		providerReportedTurns += turns.filter((event) => event.providerResponseStatus === "reported").length;
		providerReportedCases += providerReportedInCase ? 1 : 0;
		providerUnavailableTurns += unavailableInCase;
		recoveredProviderUnavailableTurns += receipt?.completion?.status === "accepted" ? unavailableInCase : 0;
		totalInputTokens += turns.reduce((total, event) => total + finiteNonnegative(event.inputTokens), 0);
		totalOutputTokens += turns.reduce((total, event) => total + finiteNonnegative(event.outputTokens), 0);
		totalCostUsd += turns.reduce((total, event) => total + finiteNonnegative(event.costUsd), 0);
		totalDurationMs += durationMs;
		maxDurationMs = Math.max(maxDurationMs, durationMs);
		maxTokensPerCase = Math.max(maxTokensPerCase, tokens);
		maxModelTurnsPerCase = Math.max(maxModelTurnsPerCase, turns.length);
	}
	return { cases, modelTurns, usageMeasurementRate: modelTurns ? measuredTurns / modelTurns : 0, measuredCases, caseUsageMeasurementRate: cases ? measuredCases / cases : 0, providerReportedTurns, providerReportedCases, providerUnavailableTurns, recoveredProviderUnavailableTurns, providerResponseReportingRate: modelTurns ? providerReportedTurns / modelTurns : 0, caseProviderResponseReportingRate: cases ? providerReportedCases / cases : 0, totalInputTokens, totalOutputTokens, totalTokens: totalInputTokens + totalOutputTokens, averageTokensPerCase: cases ? (totalInputTokens + totalOutputTokens) / cases : 0, maxTokensPerCase, totalCostUsd: Math.round(totalCostUsd * 1e12) / 1e12, costEvidence: totalCostUsd > 0 ? "provider_reported" : "unpriced", averageDurationMs: cases ? totalDurationMs / cases : 0, maxDurationMs, maxModelTurnsPerCase };
}

export function livePiEvidenceFailures(metrics, requirements = LIVE_PI_COMPLETION_REQUIREMENTS) {
	const failures = [];
	if (!Number.isFinite(metrics.caseUsageMeasurementRate) || metrics.caseUsageMeasurementRate < requirements.minimumCaseUsageMeasurementRate) failures.push("case_usage_incomplete");
	if (!Number.isFinite(metrics.caseProviderResponseReportingRate) || metrics.caseProviderResponseReportingRate < requirements.minimumCaseProviderResponseReportingRate) failures.push("case_provider_response_unreported");
	return failures;
}

async function mapWithConcurrency(items, concurrency, mapper) {
	const width = Math.max(1, Math.min(items.length || 1, Number.isSafeInteger(concurrency) ? concurrency : 1));
	const results = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: width }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await mapper(items[index], index);
		}
	}));
	return results;
}

function finiteNonnegative(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }
function isMeasuredProviderTurn(event) { return event?.providerResponseStatus === "reported" && Number.isFinite(event.inputTokens) && event.inputTokens >= 0 && Number.isFinite(event.outputTokens) && event.outputTokens >= 0 && event.inputTokens + event.outputTokens > 0; }
function safeEvaluationFailureMessage(error) {
	return (error instanceof Error ? error.message : String(error))
		.replace(/(?:bearer\s+|api[_-]?key[=:]\s*)[^\s,;]+/giu, "$1[redacted]")
		.slice(0, 1_000);
}

export function createLivePiEvaluationTools({ candidates, descriptors, sourceByCapability, readSkills, completed, cognitionId, requiredCapabilities = [] }) {
	const direct = candidates.filter((candidate) => candidate.kind !== "skill").map((candidate) => {
		const sourceTool = sourceByCapability.get(candidate.name);
		return Object.assign(withToolPolicy(defineTool({ name: sourceTool, label: candidate.name, description: descriptors.get(candidate.name)?.description ?? candidate.name, parameters: Type.Object({}, { additionalProperties: true }), execute: async (toolCallId) => ({ content: [{ type: "text", text: `verified capability result: ${candidate.name}` }], details: { capabilityReceipt: { id: livePiCapabilityReceiptId(candidate, toolCallId), kind: candidate.kind, name: candidate.name, version: candidate.version, sourceTool } } }) }), READ_ONLY_TOOL_POLICY), { beemaxToolSpec: { kind: candidate.kind, version: candidate.version, capabilityIdentity: { kind: candidate.kind, name: candidate.name, version: candidate.version }, configured: true, health: "ready", authorized: true } });
	});
	const skills = candidates.filter((candidate) => candidate.kind === "skill");
	const activatedSkills = new Set();
	const routedSkills = new Set();
	const resourceReadSkills = new Set();
	const selectedSkill = (name) => {
		const candidate = skills.find((item) => item.name === name);
		if (!candidate) throw new Error("Unknown selected Skill");
		return candidate;
	};
	const skillTool = (definition) => Object.assign(withToolPolicy(defineTool(definition), READ_ONLY_TOOL_POLICY), { beemaxToolSpec: { kind: "skill", version: "eval:lifecycle", configured: true, health: "ready", authorized: true } });
	const skillRead = skillTool({
		name: "skill_read", label: "Read Skill", description: "Read the exact selected Skill metadata once, then call skill_activate with the same name.",
		parameters: Type.Object({ name: Type.String() }),
		execute: async (toolCallId, args) => {
			const candidate = selectedSkill(args.name); readSkills.add(candidate.name);
			return { content: [{ type: "text", text: `Read Skill ${candidate.name}. Next call skill_activate with the same name.` }], details: { descriptor: { name: candidate.name }, skill: candidate.name, activatedTools: ["skill_activate"], skillLifecycleReceipt: { id: livePiReceiptId("skill-read", candidate, toolCallId), name: candidate.name, version: candidate.version, phase: "read", sourceTool: "skill_read" } } };
		},
	});
	const skillActivate = skillTool({
		name: "skill_activate", label: "Activate Skill", description: "Activate the selected Skill after skill_read, then call skill_route.",
		parameters: Type.Object({ name: Type.String() }),
		execute: async (toolCallId, args) => {
			const candidate = selectedSkill(args.name); if (!readSkills.has(candidate.name)) throw new Error("Selected Skill must be read before activation"); activatedSkills.add(candidate.name);
			return { content: [{ type: "text", text: `Activated Skill ${candidate.name}. Next call skill_route with route default.` }], details: { descriptor: { name: candidate.name }, skill: candidate.name, activatedTools: ["skill_route"], skillLifecycleReceipt: { id: livePiReceiptId("skill-activate", candidate, toolCallId), name: candidate.name, version: candidate.version, phase: "activated", sourceTool: "skill_activate" } } };
		},
	});
	const skillRoute = skillTool({
		name: "skill_route", label: "Route Skill", description: "Select route default for the activated Skill, then call skill_resource_read.",
		parameters: Type.Object({ name: Type.String(), route: Type.Optional(Type.String()) }),
		execute: async (toolCallId, args) => {
			const candidate = selectedSkill(args.name); if (!activatedSkills.has(candidate.name)) throw new Error("Selected Skill must be activated before routing"); routedSkills.add(candidate.name);
			return { content: [{ type: "text", text: `Routed Skill ${candidate.name} through ${args.route ?? "default"}. Next call skill_resource_read with path references/checklist.md.` }], details: { descriptor: { name: candidate.name }, skill: candidate.name, route: args.route ?? "default", activatedTools: ["skill_resource_read", "skill_complete"], skillLifecycleReceipt: { id: livePiReceiptId("skill-route", candidate, toolCallId), name: candidate.name, version: candidate.version, phase: "routed", sourceTool: "skill_route" } } };
		},
	});
	const skillResourceRead = skillTool({
		name: "skill_resource_read", label: "Read Skill Resource", description: "Read the routed Skill checklist before completion.",
		parameters: Type.Object({ name: Type.String(), path: Type.Optional(Type.String()) }),
		execute: async (toolCallId, args) => {
			const candidate = selectedSkill(args.name); if (!routedSkills.has(candidate.name)) throw new Error("Selected Skill must be routed before reading its resource"); resourceReadSkills.add(candidate.name);
			return { content: [{ type: "text", text: `Read ${args.path ?? "references/checklist.md"} for Skill ${candidate.name}. Next call skill_complete.` }], details: { descriptor: { name: candidate.name }, skill: candidate.name, path: args.path ?? "references/checklist.md", activatedTools: ["skill_complete"], skillLifecycleReceipt: { id: livePiReceiptId("skill-resource-read", candidate, toolCallId), name: candidate.name, version: candidate.version, phase: "resource_read", sourceTool: "skill_resource_read" } } };
		},
	});
	const skillComplete = skillTool({
		name: "skill_complete", label: "Complete Skill", description: "Complete the Skill only after its selected resource was read.",
		parameters: Type.Object({ name: Type.String() }),
		execute: async (toolCallId, args) => {
			const candidate = selectedSkill(args.name); if (!resourceReadSkills.has(candidate.name)) throw new Error("Selected Skill resource must be read before completion"); completed.add(candidate.name);
			return { content: [{ type: "text", text: `completed ${candidate.name}` }], details: { skill: candidate.name, skillLifecycleReceipt: { id: livePiReceiptId("skill-complete", candidate, toolCallId), name: candidate.name, version: candidate.version, phase: "completed", sourceTool: "skill_complete" }, capabilityReceipt: { id: livePiCapabilityReceiptId(candidate, toolCallId), kind: "skill", name: candidate.name, version: candidate.version, sourceTool: "skill_complete" } } };
		},
	});
	let boundCandidates = candidates;
	const prefetch = async (_query, _signal, options = {}) => {
		const requirements = Array.isArray(options.requirements) ? options.requirements : [];
		const requiredOrder = [
			...requiredCapabilities.flatMap((name) => candidates.find((candidate) => candidate.name === name) ?? []),
			...candidates.filter((candidate) => !requiredCapabilities.includes(candidate.name)),
		];
		boundCandidates = requirements.length && candidates.length
			? requirements.map((requirement, index) => ({ ...requiredOrder[Math.min(index, requiredOrder.length - 1)], requirementId: requirement.id, outcomeIndex: 0, necessity: "required" }))
			: candidates;
		return { cognitionId, candidates: boundCandidates, activatedTools: direct.map((tool) => tool.name), skills: skills.map(({ name }) => ({ name })) };
	};
	const discover = attestCapabilityProviderResolutionTool(Object.assign(withToolPolicy(defineTool({ name: "capability_discover", label: "Discover Capabilities", description: "Discover the already selected evaluation capabilities", parameters: Type.Object({ query: Type.Optional(Type.String()) }), execute: async () => ({ content: [{ type: "text", text: "Evaluation capabilities are already selected." }], details: { cognitionId, ranked: boundCandidates, activatedTools: direct.map((tool) => tool.name) } }) }), READ_ONLY_TOOL_POLICY), { beemaxCapabilityPrefetch: prefetch, beemaxToolSpec: { kind: "tool", version: "eval:discovery", configured: true, health: "ready", authorized: true } }));
	return [discover, ...direct, ...(skills.length ? [skillRead, skillActivate, skillRoute, skillResourceRead, skillComplete] : [])];
}

function livePiReceiptId(phase, candidate, toolCallId) { return `receipt:live-pi:${phase}:${candidate.name}:${candidate.version}:${createHash("sha256").update(toolCallId).digest("hex")}`; }
function livePiCapabilityReceiptId(candidate, toolCallId) { return `receipt:live-pi:capability:${candidate.kind}:${candidate.name}:${candidate.version}:${createHash("sha256").update(toolCallId).digest("hex")}`; }

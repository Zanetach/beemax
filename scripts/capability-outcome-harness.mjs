import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BeeMaxAgentRuntime,
	FileExecutionTraceStore,
	compareCapabilityCalibrations,
	createAccessScopeRef,
	createExecutionEnvelope,
	evaluateCapabilityCalibration,
} from "../packages/core/dist/index.js";
import { attestCapabilityProviderResolutionTool } from "../packages/core/dist/capability-provider.js";

const semanticReview = Object.freeze({
	schemaVersion: "beemax.work-contract-adjudication.v1",
	inventorySchemaVersion: "beemax.semantic-inventory.v1",
	primaryModelIdentity: "eval/primary/capability-outcome",
	reviewerModelIdentity: "eval/reviewer/capability-outcome",
	reviewMode: "different_models",
	independentSamples: true,
	cognitionUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: ["eval/primary/capability-outcome", "eval/reviewer/capability-outcome"] },
	cognitionBudgetChargeTokens: 1,
});
import { capabilityInventory, capabilityRankingCases } from "../evals/capability-ranking-corpus.mjs";

export async function executeOutcomeBoundCapabilityRun({ mode, threshold, observedRankings, cognitionAttempts = [] }) {
	const rankingByCase = new Map(observedRankings.map((ranking) => [ranking.caseId, ranking]));
	const attemptsByCognition = new Map();
	for (const attempt of cognitionAttempts) {
		const bucket = attemptsByCognition.get(attempt.cognitionId) ?? [];
		bucket.push(attempt); attemptsByCognition.set(attempt.cognitionId, bucket);
	}
	const receipts = [];
	const observations = [];
	for (const scenario of capabilityRankingCases) {
		const ranking = rankingByCase.get(scenario.id);
		if (!ranking) throw new Error(`Capability outcome harness is missing ranking ${scenario.id}`);
		const candidates = ranking.candidates.filter((candidate) => candidate.confidence >= threshold);
		let receipt;
		try { receipt = await executeOutcomeBoundCapabilityTask({ scenario, cognitionId: ranking.cognitionId, candidates, inventory: capabilityInventory, threshold }); }
		catch (error) { throw new Error(`Capability outcome harness failed for case ${scenario.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
		receipts.push(receipt);
		const attempts = attemptsByCognition.get(ranking.cognitionId) ?? [];
		if (mode === "live_provider") {
			if (ranking.strategy === "semantic" && (!attempts.length || attempts.filter((attempt) => attempt.status === "succeeded").some((attempt) => attempt.usageStatus !== "measured") || !attempts.some((attempt) => attempt.status === "succeeded" && attempt.usageStatus === "measured"))) throw new Error(`Live Capability outcome ${scenario.id} lacks measured successful semantic usage or cost`);
			if (ranking.strategy === "lexical" && attempts.length) throw new Error(`Live Capability outcome ${scenario.id} claims a deterministic routing lane with Provider attempts`);
			if (ranking.strategy !== "semantic" && ranking.strategy !== "lexical") throw new Error(`Live Capability outcome ${scenario.id} lacks a valid production routing lane`);
		}
		const measuredAttempts = attempts.filter((attempt) => attempt.usageStatus === "measured");
		observations.push({
			caseId: scenario.id, cognitionId: ranking.cognitionId,
			routingLane: ranking.strategy,
			ranked: ranking.candidates.map(({ name, version, confidence, kind }) => ({ name, version, confidence, kind })),
			activatedCapabilities: receipt.activatedCapabilities,
			outcome: receipt.downstreamOutcome,
			latencyMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0) + receipt.durationMs,
			inputTokens: measuredAttempts.reduce((sum, attempt) => sum + attempt.actualInputTokens, 0),
			outputTokens: measuredAttempts.reduce((sum, attempt) => sum + attempt.actualOutputTokens, 0),
			costUsd: measuredAttempts.reduce((sum, attempt) => sum + attempt.costUsd, 0),
			usageMeasurement: { measuredAttempts: measuredAttempts.length, totalAttempts: attempts.length },
		});
	}
	const report = evaluateCapabilityCalibration({
		mode, corpusVersion: "unknown-enterprise-multilingual:v1", threshold,
		cases: capabilityRankingCases.map((scenario) => ({ id: scenario.id, requiredCapabilities: requiredCapabilities(scenario), forbiddenCapabilities: scenario.forbidden ?? [] })),
		observations,
	});
	return { report, receipts };
}

export async function executeCalibrationThresholdTrials({ baselineVersion, baseline, thresholds, observedRankings, cognitionAttempts = [] }) {
	const trials = [];
	for (const threshold of thresholds) {
		const execution = await executeOutcomeBoundCapabilityRun({ mode: baseline.mode, threshold, observedRankings, cognitionAttempts });
		const version = `${baselineVersion}:threshold-${threshold}`;
		trials.push({ version, threshold, ...execution, promotion: compareCapabilityCalibrations({ baseline: { version: baselineVersion, report: baseline }, candidate: { version, report: execution.report } }) });
	}
	return trials;
}

export async function executeCapabilityAuthorityProbe() {
	const scenario = { id: "authority-probe", query: "attempt a scoped mutation", expected: "authority_probe_mutation", forbidden: [] };
	const inventory = [{ kind: "tool", name: "authority_probe_mutation", description: "A mutation denied by the trusted evaluation scope", version: "probe:1", activeTools: ["authority_probe_mutation"], signals: { effect: "external", health: "ready" }, authorized: false }];
	return executeOutcomeBoundCapabilityTask({ scenario, cognitionId: "eval:authority-probe", candidates: [{ kind: "tool", name: "authority_probe_mutation", version: "probe:1", confidence: 1, strategy: "semantic" }], inventory, threshold: 0.75 });
}

export async function executeOutcomeBoundCapabilityTask({ scenario, cognitionId, candidates, inventory, threshold }) {
	const root = mkdtempSync(join(tmpdir(), "beemax-capability-task-"));
	const executionId = `execution:capability-eval:${scenario.id}:${String(threshold).replace(".", "-")}`;
	const scopeId = `scope:capability-eval:${scenario.id}`;
	const traceStore = new FileExecutionTraceStore(join(root, "execution-trace.jsonl"), 1_000);
	const tasks = new Map(); const runs = new Map(); const activeToolSnapshots = []; const toolSpecPlans = [];
	const ledger = evaluationLedger(tasks, runs);
	const required = requiredCapabilities(scenario); const forbidden = scenario.forbidden ?? [];
	const descriptorByName = new Map(inventory.map((descriptor) => [descriptor.name, descriptor]));
	const toolDefinitions = createEvaluationTools(inventory, candidates, cognitionId);
	let listener = () => undefined; let activeTools = toolDefinitions.map((tool) => tool.name); let modelTurnOpen = true; const executed = new Set(); const completedCapabilities = new Set();
	const agent = { state: { model: { id: "capability-task-sandbox", input: ["text"], contextWindow: 32_000 }, messages: [] } };
	const piSession = {
		agent,
		getAllTools: () => toolDefinitions,
		getToolDefinition: (name) => toolDefinitions.find((tool) => tool.name === name),
		getActiveToolNames: () => [...activeTools],
		setActiveToolsByName: (names) => { activeTools = [...names]; if (modelTurnOpen) activeToolSnapshots.push([...names]); },
		sendCustomMessage: async (message) => { const visiblePlan = modelVisibleToolSpecPlan(message?.content); if (visiblePlan && !toolSpecPlans.some((plan) => plan.planId === visiblePlan.planId)) toolSpecPlans.push(visiblePlan); },
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (promptText) => {
			const visiblePlan = modelVisibleToolSpecPlan(promptText);
			if (visiblePlan && !toolSpecPlans.some((plan) => plan.planId === visiblePlan.planId)) toolSpecPlans.push(visiblePlan);
			const selectedSkills = candidates.filter((candidate) => candidate.kind === "skill").map((candidate) => candidate.name);
			const requestedTools = [...candidates.filter((candidate) => candidate.kind !== "skill").flatMap((candidate) => (descriptorByName.get(candidate.name)?.activeTools ?? [candidate.name]).map((name) => ({ name, capability: candidate.name }))), ...selectedSkills.flatMap((skill) => [{ name: "skill_read", capability: skill }, { name: "skill_complete", capability: skill }])];
			const calls = requestedTools.flatMap(({ name, capability }) => {
				const executionKey = `${name}:${capability}`;
				if (executed.has(executionKey) || !activeTools.includes(name) || !toolDefinitions.some((tool) => tool.name === name)) return [];
				return [{ name, capability, executionKey, callId: `call:${scenario.id}:${name}:${capability}`, args: name.startsWith("skill_") ? { name: capability } : {} }];
			});
			const assistantMessage = sandboxAssistantMessage(scenario.id, executed.size, calls);
			listener({ type: "message_start", message: assistantMessage });
			listener({ type: "message_end", message: assistantMessage });
			const toolResults = [];
			for (const { name, capability, executionKey, callId, args } of calls) {
				const tool = toolDefinitions.find((candidate) => candidate.name === name);
				if (!tool) continue;
				listener({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
				const boundary = await agent.beforeToolCall?.({ toolCall: { id: callId, name, arguments: args }, args, context: {} }, new AbortController().signal);
				if (boundary?.block) {
					const result = { content: [{ type: "text", text: boundary.reason ?? `Tool ${name} was blocked` }], details: { blocked: true, dispatchError: { stage: "authorization", code: "blocked", retryable: false } } };
					listener({ type: "tool_execution_end", toolCallId: callId, toolName: name, result, isError: true });
					const message = sandboxToolResultMessage(callId, name, result, true); toolResults.push(message); listener({ type: "message_start", message }); listener({ type: "message_end", message });
					continue;
				}
				executed.add(executionKey);
				try {
					const result = await tool.execute(callId, args, new AbortController().signal); const receipt = result?.details?.capabilityReceipt;
					if (receipt?.name) completedCapabilities.add(receipt.name);
					listener({ type: "tool_execution_end", toolCallId: callId, toolName: name, result, isError: false });
					const message = sandboxToolResultMessage(callId, name, result, false); toolResults.push(message); listener({ type: "message_start", message }); listener({ type: "message_end", message });
				} catch (error) {
					const result = { content: [{ type: "text", text: String(error) }], details: { failure: true } };
					listener({ type: "tool_execution_end", toolCallId: callId, toolName: name, result, isError: true });
					const message = sandboxToolResultMessage(callId, name, result, true); toolResults.push(message); listener({ type: "message_start", message }); listener({ type: "message_end", message });
				}
			}
			listener({ type: "turn_end", message: assistantMessage, toolResults });
			agent.state.messages = [...agent.state.messages, assistantMessage, ...toolResults];
			modelTurnOpen = false;
		},
		abort: async () => undefined,
		dispose: () => undefined,
	};
	const rawRequest = scenario.query;
	const contractClauses = evaluationContractClauses(rawRequest);
	const clause = contractClauses.acceptance[0];
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:capability-eval", interactiveAdmission: "contract_first", taskLedger: ledger, executionTrace: traceStore,
		turnUnderstanding: { understand: () => ({ action: "create", goal: clause.text, constraints: contractClauses.prohibitions.map(({ text }) => text), acceptanceCriteria: contractClauses.acceptance.map(({ text }) => text), uncertainties: [], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: contractClauses.prohibitions, acceptanceCriteria: contractClauses.acceptance, capabilityRequirements: required.length ? contractClauses.acceptance.slice(0, required.length) : [], uncertainties: [], executionMode: "direct", confidence: 1 } }) },
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: 20, maxTokens: 2_000, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true, requiresVerification: true }, reason: "outcome calibration", directive: () => "[calibration task]" }) },
		verifyObjectiveCandidate: async (_task, _result, _signal, context) => {
			const successful = new Set(context?.successfulToolNames ?? []);
			const requiredExecuted = required.every((name) => descriptorByName.get(name)?.kind === "skill" ? completedCapabilities.has(name) : (descriptorByName.get(name)?.activeTools ?? [name]).some((tool) => successful.has(tool)));
			const forbiddenExecuted = forbidden.some((name) => descriptorByName.get(name)?.kind === "skill" ? completedCapabilities.has(name) : (descriptorByName.get(name)?.activeTools ?? [name]).some((tool) => successful.has(tool)));
			return { accepted: requiredExecuted && !forbiddenExecuted, feedback: requiredExecuted ? undefined : "required Capability did not produce a successful Tool receipt" };
		},
		createAgent: async () => piSession,
	});
	const accessScopeRef = createAccessScopeRef({ id: scopeId, authority: { kind: "enterprise_system", reference: "capability-eval-authority" }, issuedAt: 1 });
	const executionEnvelope = createExecutionEnvelope({ executionId, trigger: { kind: "interaction" }, accessScopeRef, budget: { maxToolCalls: 20, maxTokens: 2_000, maxCorrectiveAttempts: 0 }, mode: "normal" });
	let runtimeError;
	try { await runtime.run({ source: { platform: "cli", chatId: scenario.id, chatType: "dm", userId: "evaluator" }, text: rawRequest, timeoutMs: 5_000, accessScopeRef, executionEnvelope }); }
	catch (error) { runtimeError = error instanceof Error ? error.message : String(error); }
	finally { runtime.dispose(); }
	const trace = traceStore.trace({ executionId, accessScopeId: scopeId });
	if (!trace) { rmSync(root, { recursive: true, force: true }); throw new Error(`Capability outcome task ${scenario.id} produced no Execution Trace${runtimeError ? `: ${runtimeError}` : ""}`); }
	const activatedCapabilities = activatedCapabilitiesFromTrace(candidates, trace.events);
	const receipt = {
		caseId: scenario.id, cognitionId, executionId, accessScopeId: scopeId, threshold,
		selectedCandidates: candidates.map(({ kind, name, version, confidence }) => ({ kind, name, version, confidence })),
		activeToolSnapshots, toolSpecPlans, activatedCapabilities,
		status: trace.status, verificationStatus: trace.verificationStatus,
		downstreamOutcome: trace.capabilityDownstreamOutcomeStatus ?? "unverified",
		durationMs: trace.durationMs ?? 0,
		...(runtimeError ? { runtimeError } : {}),
		executionTrace: trace.events,
	};
	rmSync(root, { recursive: true, force: true });
	return receipt;
}

function evaluationContractClauses(rawRequest) {
	const acceptance = [];
	const prohibitions = [];
	for (const match of rawRequest.matchAll(/[^，,。；;\n]+/gu)) {
		const rawSegment = match[0];
		const leading = rawSegment.length - rawSegment.trimStart().length;
		const text = rawSegment.trim();
		if (!text) continue;
		const start = (match.index ?? 0) + leading;
		const clause = { text, source: { kind: "raw_request", start, end: start + text.length } };
		if (/^(?:不要|不得|禁止|不可|(?:do not|must not|without)\b)/iu.test(text)) prohibitions.push(clause);
		else acceptance.push(clause);
	}
	if (!acceptance.length) throw new Error("Capability outcome scenario requires a positive source-bound outcome in addition to prohibitions");
	return { acceptance, prohibitions };
}

export function activatedCapabilitiesFromTrace(candidates, events) {
	const settled = events.filter((event) => event.type === "tool.settled" && event.status === "succeeded");
	return candidates.flatMap((candidate) => settled.some((event) => event.capabilityReceipt?.kind === candidate.kind && event.capabilityReceipt?.name === candidate.name && event.capabilityReceipt?.version === candidate.version && event.capabilityReceipt?.sourceTool === event.toolName) ? [candidate.name] : []);
}

function modelVisibleToolSpecPlan(promptText) {
	if (typeof promptText !== "string") return undefined;
	const match = promptText.match(/<beemax-tool-spec-plan>\s*([\s\S]*?)\s*<\/beemax-tool-spec-plan>/u);
	if (!match) return undefined;
	try {
		const plan = JSON.parse(match[1]);
		if (typeof plan.planId !== "string" || !Array.isArray(plan.direct)) return undefined;
		return { planId: plan.planId, directTools: plan.direct.map((entry) => entry.toolName).filter((name) => typeof name === "string") };
	} catch { return undefined; }
}

function sandboxAssistantMessage(scenarioId, attempt, calls) {
	return {
		role: "assistant",
		content: calls.length ? calls.map((call) => ({ type: "toolCall", id: call.callId, name: call.name, arguments: call.args })) : [{ type: "text", text: `sandbox outcome ${scenarioId}` }],
		api: "openai-completions", provider: "custom", model: "capability-task-sandbox",
		responseId: `provider-response:${scenarioId}:${attempt}`,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: calls.length ? "toolUse" : "stop", timestamp: Date.now(),
	};
}

function sandboxToolResultMessage(toolCallId, toolName, result, isError) {
	return { role: "toolResult", toolCallId, toolName, content: result?.content ?? [], details: result?.details, isError, timestamp: Date.now() };
}

function createEvaluationTools(inventory, candidates, cognitionId) {
	let obligationCandidates = candidates;
	const selectedSkills = candidates.filter((candidate) => candidate.kind === "skill").map((candidate) => candidate.name);
	const readSkills = new Set();
	const tools = inventory.filter((descriptor) => descriptor.kind !== "skill").flatMap((descriptor) => (descriptor.activeTools ?? [descriptor.name]).map((sourceTool) => ({
		name: sourceTool, description: descriptor.description,
		beemaxPolicy: { sideEffect: descriptor.signals?.effect === "external" ? "external" : descriptor.signals?.effect === "local" ? "local" : "none" },
		beemaxToolSpec: { kind: descriptor.kind, version: descriptor.version, capabilityIdentity: { kind: descriptor.kind, name: descriptor.name, version: descriptor.version }, configured: true, health: descriptor.signals?.health ?? "ready", authorized: descriptor.authorized !== false },
		execute: async () => ({ content: [{ type: "text", text: `sandbox receipt ${descriptor.name}` }], details: { capabilityReceipt: { id: `receipt:${descriptor.kind}:${descriptor.name}:${descriptor.version}:${sourceTool}`, kind: descriptor.kind, name: descriptor.name, version: descriptor.version, sourceTool } } }),
	})));
	const lifecycle = [
		{ name: "skill_read", description: "Read selected Skill", execute: async (id, args) => {
			const descriptor = inventory.find((item) => item.kind === "skill" && item.name === args.name);
			if (!descriptor) throw new Error(`Unknown evaluation Skill ${args.name}`);
			readSkills.add(args.name);
			return { content: [{ type: "text", text: "skill loaded" }], details: { descriptor: { name: args.name }, skill: args.name, activatedTools: ["skill_complete"], declaredTools: [], skillLifecycleReceipt: { id: `receipt:skill-read:${args.name}:${id}`, name: args.name, version: descriptor.version, phase: "read", sourceTool: "skill_read" } } };
		} },
		{ name: "skill_activate", description: "Activate selected Skill", execute: async (_id, args) => ({ content: [{ type: "text", text: "skill active" }], details: { descriptor: { name: args.name }, skill: args.name, activatedTools: ["skill_complete"] } }) },
		{ name: "skill_route", description: "Route selected Skill", execute: async (_id, args) => ({ content: [{ type: "text", text: "skill routed" }], details: { skill: args.name, activatedTools: ["skill_complete"] } }) },
		{ name: "skill_resource_read", description: "Read Skill resource", execute: async () => ({ content: [{ type: "text", text: "resource read" }], details: {} }) },
		{ name: "skill_complete", description: "Complete selected Skill", execute: async (id, args) => {
			const descriptor = inventory.find((item) => item.kind === "skill" && item.name === args.name);
			if (!descriptor) throw new Error(`Unknown evaluation Skill ${args.name}`);
			if (!readSkills.has(args.name)) throw new Error(`Evaluation Skill ${args.name} must be read before completion`);
			return { content: [{ type: "text", text: "skill complete" }], details: { skill: args.name, skillLifecycleReceipt: { id: `receipt:skill-complete:${args.name}:${id}`, name: args.name, version: descriptor.version, phase: "completed", sourceTool: "skill_complete" }, capabilityReceipt: { id: `receipt:skill:${args.name}:${descriptor.version}:${id}`, kind: "skill", name: args.name, version: descriptor.version, sourceTool: "skill_complete" } } };
		} },
	].map((tool) => ({ ...tool, beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { kind: "skill", version: "eval:skill-lifecycle", configured: true, health: "ready", authorized: true } }));
	const prefetch = async (_query, _signal, options) => {
		obligationCandidates = candidates.map((candidate, index) => {
			const requirement = options?.requirements?.[index] ?? options?.requirements?.[0];
			return { ...candidate, ...(requirement ? { requirementId: requirement.id, outcomeIndex: 0, necessity: "required" } : {}) };
		});
		return { cognitionId, candidates: obligationCandidates, activatedTools: candidates.filter((candidate) => candidate.kind !== "skill").flatMap((candidate) => inventory.find((item) => item.name === candidate.name)?.activeTools ?? [candidate.name]), skills: selectedSkills.map((name) => ({ name })) };
	};
	const discovery = attestCapabilityProviderResolutionTool({ name: "capability_discover", description: "Discover evaluation capabilities", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { kind: "tool", version: "eval:discovery", configured: true, health: "ready", authorized: true }, beemaxCapabilityPrefetch: prefetch, execute: async () => ({ content: [{ type: "text", text: "discovered" }], details: { cognitionId, ranked: obligationCandidates, activatedTools: [] } }) });
	return [discovery, ...tools, ...lifecycle];
}

function evaluationLedger(tasks, runs) {
	return {
		record(task) { tasks.set(task.id, { ...task }); }, transition(id, change) { const task = tasks.get(id); if (!task) return false; tasks.set(id, { ...task, ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); }, transitionRun(id, change) { const run = runs.get(id); if (!run) return false; runs.set(id, { ...run, ...change }); return true; },
		isTaskRunExecutionActive(ownerKey, objectiveId, taskId, taskRunId) {
			const objective = tasks.get(objectiveId); const task = tasks.get(taskId); const run = runs.get(taskRunId);
			return objective?.ownerKey === ownerKey && objective.status === "running"
				&& task?.ownerKey === ownerKey && task.status === "running"
				&& run?.taskId === taskId && run.status === "running";
		},
		queryTasks(query) { return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id) && (!query.kinds || query.kinds.includes(task.kind)) && (!query.statuses || query.statuses.includes(task.status))).slice(0, query.limit ?? 100); },
		taskRuns(taskId) { return [...runs.values()].filter((run) => run.taskId === taskId); },
		checkpointTask() { return true; }, deferCandidateVerification() {},
		settleDirectObjectiveCompletion(settlement) {
			const task = tasks.get(settlement.objectiveId); const run = runs.get(settlement.taskRunId);
			if (!task || task.ownerKey !== settlement.ownerKey || task.kind !== "objective" || task.status !== "running" || !run || run.taskId !== task.id || run.status !== "running") return false;
			tasks.set(task.id, { ...task, candidateResult: settlement.candidateResult, evidence: settlement.evidence, verificationStatus: "accepted", criterionVerifications: settlement.criterionVerifications, correctiveAttempts: settlement.correctiveAttempts });
			runs.set(run.id, { ...run, status: "succeeded", finishedAt: Date.now(), output: settlement.candidateResult });
			return true;
		},
	};
}

function requiredCapabilities(scenario) { return scenario.required?.length ? [...scenario.required] : scenario.expected ? [scenario.expected] : []; }

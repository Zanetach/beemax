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
		const receipt = await executeOneTask({ scenario, cognitionId: ranking.cognitionId, candidates, inventory: capabilityInventory, threshold });
		receipts.push(receipt);
		const attempts = attemptsByCognition.get(ranking.cognitionId) ?? [];
		if (mode === "live_provider" && (!attempts.length || attempts.filter((attempt) => attempt.status === "succeeded").some((attempt) => attempt.usageStatus !== "measured") || !attempts.some((attempt) => attempt.status === "succeeded" && attempt.usageStatus === "measured"))) throw new Error(`Live Capability outcome ${scenario.id} lacks measured successful usage or cost`);
		const measuredAttempts = attempts.filter((attempt) => attempt.usageStatus === "measured");
		observations.push({
			caseId: scenario.id, cognitionId: ranking.cognitionId,
			ranked: ranking.candidates.map(({ name, confidence, kind }) => ({ name, confidence, kind })),
			activatedCapabilities: receipt.activatedCapabilities,
			outcome: receipt.downstreamOutcome,
			latencyMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0) + receipt.durationMs,
			inputTokens: measuredAttempts.reduce((sum, attempt) => sum + attempt.actualInputTokens, 0),
			outputTokens: measuredAttempts.reduce((sum, attempt) => sum + attempt.actualOutputTokens, 0),
			costUsd: measuredAttempts.reduce((sum, attempt) => sum + attempt.costUsd, 0),
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
	return executeOneTask({ scenario, cognitionId: "eval:authority-probe", candidates: [{ kind: "tool", name: "authority_probe_mutation", confidence: 1, strategy: "semantic" }], inventory, threshold: 0.75 });
}

async function executeOneTask({ scenario, cognitionId, candidates, inventory, threshold }) {
	const root = mkdtempSync(join(tmpdir(), "beemax-capability-task-"));
	const executionId = `execution:capability-eval:${scenario.id}:${String(threshold).replace(".", "-")}`;
	const scopeId = `scope:capability-eval:${scenario.id}`;
	const traceStore = new FileExecutionTraceStore(join(root, "execution-trace.jsonl"), 1_000);
	const tasks = new Map(); const runs = new Map(); const activeToolSnapshots = [];
	const ledger = evaluationLedger(tasks, runs);
	const required = requiredCapabilities(scenario); const forbidden = scenario.forbidden ?? [];
	const descriptorByName = new Map(inventory.map((descriptor) => [descriptor.name, descriptor]));
	const toolDefinitions = createEvaluationTools(inventory, candidates, cognitionId);
	let listener = () => undefined; let activeTools = toolDefinitions.map((tool) => tool.name); let modelTurnOpen = true; const executed = new Set();
	const agent = { state: { model: { id: "capability-task-sandbox", input: ["text"], contextWindow: 32_000 }, messages: [] } };
	const piSession = {
		agent,
		getAllTools: () => toolDefinitions,
		getToolDefinition: (name) => toolDefinitions.find((tool) => tool.name === name),
		getActiveToolNames: () => [...activeTools],
		setActiveToolsByName: (names) => { activeTools = [...names]; if (modelTurnOpen) activeToolSnapshots.push([...names]); },
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			const selectedSkills = candidates.filter((candidate) => candidate.kind === "skill").map((candidate) => candidate.name);
			const requestedTools = [...candidates.filter((candidate) => candidate.kind !== "skill").map((candidate) => candidate.name), ...selectedSkills.flatMap(() => ["skill_read", "skill_complete"])];
			for (const name of requestedTools) {
				if (executed.has(name) || !activeTools.includes(name)) continue;
				const tool = toolDefinitions.find((candidate) => candidate.name === name); if (!tool) continue;
				const callId = `call:${scenario.id}:${name}`; const args = name === "skill_read" ? { name: selectedSkills[0] } : {};
				const boundary = await agent.beforeToolCall?.({ toolCall: { name, arguments: args } }, new AbortController().signal);
				if (boundary?.block) continue;
				executed.add(name); listener({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
				try { const result = await tool.execute(callId, args, new AbortController().signal); listener({ type: "tool_execution_end", toolCallId: callId, toolName: name, result, isError: false }); }
				catch (error) { listener({ type: "tool_execution_end", toolCallId: callId, toolName: name, result: { error: String(error) }, isError: true }); }
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: `sandbox outcome ${scenario.id}` }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }];
			modelTurnOpen = false;
		},
		abort: async () => undefined,
		dispose: () => undefined,
	};
	const rawRequest = scenario.query; const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:capability-eval", taskLedger: ledger, executionTrace: traceStore,
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => ({ source: "model", contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [clause], uncertainties: [], executionMode: "direct", confidence: 1 } }) },
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: 20, maxTokens: 2_000, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true, requiresVerification: true }, reason: "outcome calibration", directive: () => "[calibration task]" }) },
		verifyObjectiveCandidate: async (_task, _result, _signal, context) => {
			const successful = new Set(context?.successfulToolNames ?? []);
			const requiredExecuted = required.every((name) => descriptorByName.get(name)?.kind === "skill" ? successful.has("skill_complete") : successful.has(name));
			const forbiddenExecuted = forbidden.some((name) => descriptorByName.get(name)?.kind === "skill" ? successful.has("skill_complete") : successful.has(name));
			return { accepted: requiredExecuted && !forbiddenExecuted, feedback: requiredExecuted ? undefined : "required Capability did not produce a successful Tool receipt" };
		},
		createAgent: async () => piSession,
	});
	const accessScopeRef = createAccessScopeRef({ id: scopeId, authority: { kind: "enterprise_system", reference: "capability-eval-authority" }, issuedAt: 1 });
	const executionEnvelope = createExecutionEnvelope({ executionId, trigger: { kind: "interaction" }, accessScopeRef, budget: { maxToolCalls: 20, maxTokens: 2_000, maxCorrectiveAttempts: 0 }, mode: "normal" });
	try { await runtime.run({ source: { platform: "cli", chatId: scenario.id, chatType: "dm", userId: "evaluator" }, text: rawRequest, timeoutMs: 5_000, accessScopeRef, executionEnvelope }); }
	finally { runtime.dispose(); }
	const trace = traceStore.trace({ executionId, accessScopeId: scopeId });
	if (!trace) { rmSync(root, { recursive: true, force: true }); throw new Error(`Capability outcome task ${scenario.id} produced no Execution Trace`); }
	const succeededTools = trace.events.filter((event) => event.type === "tool.settled" && event.status === "succeeded").map((event) => event.toolName);
	const activatedCapabilities = candidates.flatMap((candidate) => candidate.kind === "skill" ? succeededTools.includes("skill_complete") ? [candidate.name] : [] : succeededTools.includes(candidate.name) ? [candidate.name] : []);
	const receipt = {
		caseId: scenario.id, cognitionId, executionId, accessScopeId: scopeId, threshold,
		selectedCandidates: candidates.map(({ kind, name, confidence }) => ({ kind, name, confidence })),
		activeToolSnapshots, activatedCapabilities,
		status: trace.status, verificationStatus: trace.verificationStatus,
		downstreamOutcome: trace.capabilityDownstreamOutcomeStatus ?? "unverified",
		durationMs: trace.durationMs ?? 0,
		executionTrace: trace.events,
	};
	rmSync(root, { recursive: true, force: true });
	return receipt;
}

function createEvaluationTools(inventory, candidates, cognitionId) {
	const selectedSkill = candidates.find((candidate) => candidate.kind === "skill")?.name;
	const tools = inventory.filter((descriptor) => descriptor.kind !== "skill").map((descriptor) => ({
		name: descriptor.name, description: descriptor.description,
		beemaxPolicy: { sideEffect: descriptor.signals?.effect === "external" ? "external" : descriptor.signals?.effect === "local" ? "local" : "none" },
		beemaxToolSpec: { kind: descriptor.kind, version: descriptor.version, configured: true, health: descriptor.signals?.health ?? "ready", authorized: descriptor.authorized !== false },
		execute: async () => ({ content: [{ type: "text", text: `sandbox receipt ${descriptor.name}` }], details: { receiptId: `receipt:${descriptor.name}`, capability: descriptor.name } }),
	}));
	const lifecycle = [
		{ name: "skill_read", description: "Read selected Skill", execute: async () => ({ content: [{ type: "text", text: "skill loaded" }], details: { descriptor: { name: selectedSkill }, activatedTools: ["skill_complete"] } }) },
		{ name: "skill_activate", description: "Activate selected Skill", execute: async () => ({ content: [{ type: "text", text: "skill active" }], details: { descriptor: { name: selectedSkill }, activatedTools: ["skill_complete"] } }) },
		{ name: "skill_route", description: "Route selected Skill", execute: async () => ({ content: [{ type: "text", text: "skill routed" }], details: { activatedTools: ["skill_complete"] } }) },
		{ name: "skill_resource_read", description: "Read Skill resource", execute: async () => ({ content: [{ type: "text", text: "resource read" }], details: {} }) },
		{ name: "skill_complete", description: "Complete selected Skill", execute: async () => ({ content: [{ type: "text", text: "skill complete" }], details: { skill: selectedSkill } }) },
	].map((tool) => ({ ...tool, beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { kind: "skill", version: "eval:skill-lifecycle", configured: true, health: "ready", authorized: true } }));
	const prefetch = async () => ({ cognitionId, candidates, skills: selectedSkill ? [{ name: selectedSkill }] : [] });
	const discovery = { name: "capability_discover", description: "Discover evaluation capabilities", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { kind: "tool", version: "eval:discovery", configured: true, health: "ready", authorized: true }, beemaxCapabilityPrefetch: prefetch, execute: async () => ({ content: [{ type: "text", text: "discovered" }], details: { cognitionId, ranked: candidates, activatedTools: [] } }) };
	return [discovery, ...tools, ...lifecycle];
}

function evaluationLedger(tasks, runs) {
	return {
		record(task) { tasks.set(task.id, { ...task }); }, transition(id, change) { const task = tasks.get(id); if (!task) return false; tasks.set(id, { ...task, ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); }, transitionRun(id, change) { const run = runs.get(id); if (!run) return false; runs.set(id, { ...run, ...change }); return true; },
		queryTasks(query) { return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id) && (!query.kinds || query.kinds.includes(task.kind)) && (!query.statuses || query.statuses.includes(task.status))).slice(0, query.limit ?? 100); },
		taskRuns(taskId) { return [...runs.values()].filter((run) => run.taskId === taskId); },
		checkpointTask() { return true; }, deferCandidateVerification() {},
	};
}

function requiredCapabilities(scenario) { return scenario.required?.length ? [...scenario.required] : scenario.expected ? [scenario.expected] : []; }

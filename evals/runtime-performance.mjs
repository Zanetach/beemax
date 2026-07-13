import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AutonomousPlanningPolicy,
	ConversationContext,
	DeterministicSituationBuilder,
	InitiativeRuntime,
	TurnUnderstandingEngine,
	assessRuntimePerformance,
	selectTurnTools,
} from "../packages/core/dist/index.js";
import { MemoryStore } from "../packages/memory/dist/index.js";

const INVENTORY = [
	{ name: "web_search", description: "Search public sources and verify evidence", aliases: ["调查", "查证"] },
	{ name: "document_write", description: "Write a verified report", aliases: ["报告", "文档"] },
	{ name: "data_analyze", description: "Analyze structured evidence", aliases: ["分析", "指标"] },
	{ name: "memory_recall", description: "Recall organizational knowledge", aliases: ["历史", "惯例"] },
	{ name: "task_plan_execute", description: "Execute a durable parallel Task Plan", aliases: ["并行", "任务计划"] },
	{ name: "task_spawn", description: "Delegate one isolated task", aliases: ["委派"] },
];

const FAST_PROMPT = "核验当前公开状态，并给出简短结论。";
const DEEP_PROMPT = "深度审查整个项目：并行调查三类独立证据，分析冲突，形成完整报告并验证每项结论。";
const BACKGROUND_PROMPT = "可信企业事件表明已验证状态发生变化，请评估是否值得进行一次只读调查。";

export async function runRuntimePerformanceBenchmark(profile) {
	validateProfile(profile);
	const root = mkdtempSync(join(tmpdir(), "beemax-performance-"));
	const store = new MemoryStore(join(root, "memory.db"), "performance-profile");
	try {
		const scope = { profileId: "performance-profile", platform: "eval", chatId: "performance", userId: "evaluator" };
		seedOrganizationMemory(store, scope);
		const understanding = new TurnUnderstandingEngine();
		const situationBuilder = new DeterministicSituationBuilder();
		const context = new ConversationContext(store, { maxContextChars: 12_000, memoryScope: { profileId: scope.profileId } });
		const fastPlanning = new AutonomousPlanningPolicy({ maxConcurrent: 1, maxSubagents: 0, maxToolCalls: 8, maxTokens: 12_000 });
		const deepPlanning = new AutonomousPlanningPolicy({ maxConcurrent: 3, maxSubagents: 5, maxToolCalls: 40, maxTokens: 80_000 });
		const probes = {
			fast: () => fastProbe({ understanding, situationBuilder, planning: fastPlanning }),
			deep: () => deepProbe({ understanding, situationBuilder, planning: deepPlanning, context, store, scope }),
			background: () => backgroundProbe({ situationBuilder, store, scope }),
		};
		for (const probe of Object.values(probes)) for (let index = 0; index < profile.warmupIterations; index++) await probe();
		const observations = {};
		for (const [path, probe] of Object.entries(probes)) observations[path] = await sampleProbe(probe, profile.sampleIterations);
		return {
			schemaVersion: 1,
			profile: { id: profile.id, description: profile.description },
			assessment: assessRuntimePerformance({ machineProfileId: profile.id, budgets: profile.budgets, observations }),
		};
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
}

async function fastProbe({ understanding, situationBuilder, planning }) {
	const started = performance.now();
	const interpreted = understanding.understand(FAST_PROMPT);
	const situationStarted = performance.now();
	await situationBuilder.build({ text: FAST_PROMPT, fallback: interpreted });
	const situationMs = performance.now() - situationStarted;
	const selected = selectTurnTools(interpreted.capabilityQuery, INVENTORY, 5);
	const decision = planning.decide(FAST_PROMPT);
	return {
		durationMs: performance.now() - started,
		contextChars: FAST_PROMPT.length,
		tokens: decision.budget.maxTokens ?? 0,
		toolCalls: decision.budget.maxToolCalls ?? 0,
		subagents: decision.budget.maxSubagents,
		recallMs: 0,
		situationMs,
		initiativeMs: 0,
		cacheWriteTokens: 0,
		concurrency: decision.suggestedConcurrency,
		backpressureEvents: selected.length > 5 ? 1 : 0,
	};
}

async function deepProbe({ understanding, situationBuilder, planning, context, store, scope }) {
	const started = performance.now();
	const interpreted = understanding.understand(DEEP_PROMPT);
	const situationStarted = performance.now();
	const built = await situationBuilder.build({ text: DEEP_PROMPT, fallback: interpreted });
	const situationMs = performance.now() - situationStarted;
	const recall = store.recallOrganizationKnowledge(built.situation, scope, 10);
	const assembly = context.assemble({ platform: scope.platform, chatId: scope.chatId, chatType: "dm", userId: scope.userId }, DEEP_PROMPT, { memoryQuery: interpreted.memoryQuery, situation: built.situation });
	const decision = planning.decide(DEEP_PROMPT);
	selectTurnTools(interpreted.capabilityQuery, INVENTORY, 5);
	return {
		durationMs: performance.now() - started,
		contextChars: assembly.contextChars,
		tokens: decision.budget.maxTokens ?? 0,
		toolCalls: decision.budget.maxToolCalls ?? 0,
		subagents: decision.budget.maxSubagents,
		recallMs: recall.metrics.elapsedMs,
		situationMs,
		initiativeMs: 0,
		cacheWriteTokens: 0,
		concurrency: decision.suggestedConcurrency,
		backpressureEvents: 0,
	};
}

async function backgroundProbe({ situationBuilder, store, scope }) {
	let observation;
	const initiative = new InitiativeRuntime({
		situationBuilder,
		decide: async ({ situation }) => ({ kind: "propose", action: situation.possibleActions[0]?.description ?? "Investigate verified state", expectedValue: 0.8, risk: "none", rationale: situation.summary, intendedVerification: "Current state is verified", evidenceRefs: ["event:performance"], confidence: 0.8 }),
		observations: { upsertInitiativeObservation: (input) => ({ observation: { ...input, id: "observation:performance", repeatCount: 1, feedback: "unreviewed", createdAt: 1, lastObservedAt: 1 }, created: observation === undefined }) },
		taskLedger: { queryTasks: () => [] },
	});
	const started = performance.now();
	const initiativeStarted = performance.now();
	observation = await initiative.observe({
		kind: "enterprise_event",
		id: "event:performance",
		occurredAt: 1,
		scope,
		prompt: BACKGROUND_PROMPT,
		evidence: [{ statement: "Authoritative state changed", source: { kind: "enterprise_system", reference: "event:performance" }, evidenceRef: "event:performance", confidence: 0.9, trust: "observed" }],
	});
	const initiativeMs = performance.now() - initiativeStarted;
	return {
		durationMs: performance.now() - started,
		contextChars: BACKGROUND_PROMPT.length,
		tokens: 8_000,
		toolCalls: 6,
		subagents: 1,
		recallMs: 0,
		situationMs: initiativeMs,
		initiativeMs,
		cacheWriteTokens: 0,
		concurrency: 4,
		backpressureEvents: observation.kind === "observed" || observation.kind === "ignored" ? 0 : 1,
	};
}

async function sampleProbe(probe, iterations) {
	const samples = [];
	for (let index = 0; index < iterations; index++) samples.push(await probe());
	const max = (key) => Math.max(...samples.map((sample) => sample[key]));
	return {
		durationsMs: samples.map((sample) => sample.durationMs),
		contextChars: max("contextChars"),
		tokens: max("tokens"),
		toolCalls: max("toolCalls"),
		subagents: max("subagents"),
		recallMs: max("recallMs"),
		situationMs: max("situationMs"),
		initiativeMs: max("initiativeMs"),
		cacheWriteTokens: max("cacheWriteTokens"),
		concurrency: max("concurrency"),
		backpressureEvents: samples.reduce((sum, sample) => sum + sample.backpressureEvents, 0),
	};
}

function seedOrganizationMemory(store, scope) {
	for (let index = 0; index < 20; index++) store.upsertClaim({ ...scope, kind: "fact", statement: `项目深度审查惯例 ${String(index).padStart(2, "0")}：并行调查独立证据，分析冲突，并验证每项结论。`, confidence: 0.9, stability: "medium" });
}

function validateProfile(profile) {
	if (profile?.schemaVersion !== 1 || !profile.id || !profile.description || !profile.budgets) throw new Error("Runtime performance Profile is invalid");
	if (!Number.isInteger(profile.warmupIterations) || profile.warmupIterations < 0) throw new Error("Runtime performance warmup count is invalid");
	if (!Number.isInteger(profile.sampleIterations) || profile.sampleIterations < 3) throw new Error("Runtime performance sample count is invalid");
}

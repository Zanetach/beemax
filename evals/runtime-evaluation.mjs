import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AutonomousPlanningPolicy,
	ActionGovernance,
	DeterministicSituationBuilder,
	InitiativeRuntime,
	ModelBackedSituationBuilder,
	ProactiveInvestigationRuntime,
	ProactiveReversibleActionRuntime,
	READ_ONLY_TOOL_POLICY,
	ReversibleActionAdmission,
	TaskGraph,
	TaskRecoveryRunner,
	TurnUnderstandingEngine,
	createTaskCheckpoint,
	createSituation,
	createAccessScopeRef,
	createEnterprisePolicyPublisher,
	decideInitiativeFromSituation,
	selectTurnTools,
} from "../packages/core/dist/index.js";
import { MemoryStore } from "../packages/memory/dist/index.js";

const REQUIRED_COVERAGE = ["random_vocabulary", "correction", "conflict", "long_running", "crash", "side_effect"];

export async function runUnknownBusinessEvaluation(corpus) {
	validateCorpus(corpus);
	const started = performance.now();
	const root = mkdtempSync(join(tmpdir(), "beemax-unknown-business-eval-"));
	const store = new MemoryStore(join(root, "runtime.db"), "eval-profile");
	try {
		const understanding = new TurnUnderstandingEngine();
		const situationBuilder = new DeterministicSituationBuilder();
		const planning = new AutonomousPlanningPolicy({ maxConcurrent: 4, maxSubagents: 5 });
		let correctActions = 0;
		let retainedTerms = 0;
		let situationRetainedTerms = 0;
		let capabilityHits = 0;
		let forbiddenScopeRetrievals = 0;
		let inputTokenEstimate = 0;
		let toolSelections = 0;
		let plannedSubagents = 0;
		let conflictCases = 0;
		let organizationExpected = 0;
		let organizationRetrieved = 0;
		let organizationReturned = 0;
		let organizationRelevantReturned = 0;
		let correctionExpected = 0;
		let correctionsRetained = 0;
		let conflictsExpected = 0;
		let conflictsVisible = 0;
		let organizationRecallMaxMs = 0;

		for (let index = 0; index < corpus.cases.length; index++) {
			const scenario = corpus.cases[index];
			const interpreted = understanding.understand(scenario.prompt);
			const builtSituation = await situationBuilder.build({ text: scenario.prompt, fallback: interpreted });
			if (interpreted.action === scenario.expectedAction) correctActions++;
			if (interpreted.goal.includes(scenario.term) && interpreted.capabilityQuery.includes(scenario.term)) retainedTerms++;
			if (builtSituation.situation.summary.includes(scenario.term)) situationRetainedTerms++;
			inputTokenEstimate += Math.ceil(Buffer.byteLength(scenario.prompt, "utf8") / 4);
			const inventory = capabilityInventory();
			const selected = selectTurnTools(interpreted.capabilityQuery, inventory, 5);
			toolSelections += selected.length;
			if (selected.includes(scenario.expectedCapability)) capabilityHits++;
			plannedSubagents += planning.decide(scenario.prompt).budget.maxSubagents;

			const scope = { platform: "eval", chatId: `scope-${index}`, userId: "evaluator", threadId: "primary" };
			const memoryId = store.remember({ ...scope, role: "memory", content: `${scenario.term} verified observation` });
			if (!store.recall(scenario.term, { ...scope, limit: 5 }).some((item) => item.id === memoryId)) throw new Error(`Expected scoped recall failed for ${scenario.id}`);
			if (store.recall(scenario.term, { ...scope, chatId: `forbidden-${index}`, limit: 5 }).some((item) => item.id === memoryId)) forbiddenScopeRetrievals++;

			if (scenario.facets.includes("conflict")) {
				conflictCases++;
				const first = store.upsertClaim({ profileId: "eval-profile", ...scope, kind: "fact", statement: `${scenario.term} uses phase alpha`, confidence: 0.9, stability: "medium" });
				const second = store.upsertClaim({ profileId: "eval-profile", ...scope, kind: "fact", statement: `${scenario.term} uses phase beta`, confidence: 0.9, stability: "medium" });
				if (!store.markClaimsConflicted(first.id, second.id, { profileId: "eval-profile", ...scope })) throw new Error(`Conflict preservation failed for ${scenario.id}`);
				const recalled = store.recallOrganizationKnowledge(createSituation({ summary: `resolve ${scenario.term} conflict`, confidence: 0.8 }), { profileId: "eval-profile", ...scope }, 10);
				const expected = new Set([first.id, second.id]);
				organizationExpected += expected.size; organizationRetrieved += recalled.hits.filter((hit) => expected.has(hit.id)).length; organizationReturned += recalled.hits.length; organizationRelevantReturned += recalled.hits.filter((hit) => hit.content.includes(scenario.term)).length;
				conflictsExpected += expected.size; conflictsVisible += recalled.hits.filter((hit) => expected.has(hit.id) && hit.kind === "conflict").length;
				organizationRecallMaxMs = Math.max(organizationRecallMaxMs, recalled.metrics.elapsedMs);
			}
			if (scenario.facets.includes("correction")) {
				const old = store.upsertClaim({ profileId: "eval-profile", ...scope, kind: "fact", statement: `${scenario.term} uses legacy phase`, confidence: 0.8, stability: "medium" });
				const current = store.correctClaim(old.id, { statement: `${scenario.term} uses corrected phase`, evidence: { kind: "correction", excerpt: `correction:${scenario.id}` } }, { profileId: "eval-profile", ...scope });
				if (!current) throw new Error(`Correction setup failed for ${scenario.id}`);
				const recalled = store.recallOrganizationKnowledge(createSituation({ summary: `verify ${scenario.term} corrected phase`, confidence: 0.8 }), { profileId: "eval-profile", ...scope }, 10);
				const expected = new Set([old.id, current.id]);
				organizationExpected += expected.size; organizationRetrieved += recalled.hits.filter((hit) => expected.has(hit.id)).length; organizationReturned += recalled.hits.length; organizationRelevantReturned += recalled.hits.filter((hit) => hit.content.includes(scenario.term)).length;
				correctionExpected++; correctionsRetained += recalled.hits.some((hit) => hit.id === old.id && hit.kind === "correction") ? 1 : 0;
				organizationRecallMaxMs = Math.max(organizationRecallMaxMs, recalled.metrics.elapsedMs);
			}
		}

		const verifiedCompletionRate = await verifiedCompletionProbe(store, corpus.cases);
		const recovery = await recoveryProbe(store, corpus.cases);
		const initiative = await initiativeProbe(store, corpus.cases);
		const proactive = await proactiveInvestigationProbe(store);
		const reversible = await proactiveReversibleActionProbe();
		const coverage = REQUIRED_COVERAGE.filter((facet) => corpus.cases.some((scenario) => scenario.facets.includes(facet)));
		const report = {
			schemaVersion: 1,
			corpus: { version: corpus.version, seed: corpus.seed, cases: corpus.cases.length, coverage },
			quality: {
				situationActionAccuracy: correctActions / corpus.cases.length,
				vocabularyRetention: retainedTerms / corpus.cases.length,
				situationVocabularyRetention: situationRetainedTerms / corpus.cases.length,
				capabilityTop5HitRate: capabilityHits / corpus.cases.length,
				conflictCases,
				organizationRecallPrecision: organizationReturned ? organizationRelevantReturned / organizationReturned : 1,
				organizationRecallAtK: organizationExpected ? organizationRetrieved / organizationExpected : 1,
				correctionRetentionRate: correctionExpected ? correctionsRetained / correctionExpected : 1,
				conflictVisibilityRate: conflictsExpected ? conflictsVisible / conflictsExpected : 1,
				initiativeProposalPrecision: initiative.precision,
				initiativeAverageExpectedValue: initiative.averageExpectedValue,
				proactiveInvestigationPrecision: proactive.precision,
				proactiveInvestigationAdoptionRate: proactive.adoptionRate,
			},
			reliability: { forbiddenScopeRetrievals, verifiedCompletionRate, ...recovery, duplicateInitiativeObservations: initiative.duplicateObservations, initiativeInterruptionRate: initiative.interruptionRate, duplicateProactiveObjectives: proactive.duplicateObjectives, proactiveInterruptionRate: proactive.interruptionRate, ...reversible },
			cost: { inputTokenEstimate, toolSelections, plannedSubagents, initiativeObservations: initiative.observations, proactiveMaxToolCalls: proactive.maxToolCalls, proactiveMaxTokens: proactive.maxTokens },
			performance: { elapsedMs: Math.max(0, performance.now() - started), organizationRecallMaxMs },
		};
		return { ...report, gate: releaseGate(report) };
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
}

async function proactiveReversibleActionProbe() {
	const at = 500;
	const accessScopeRef = createAccessScopeRef({ id: "scope:evaluation", authority: { kind: "enterprise_system", reference: "iam:evaluation" }, issuedAt: 100 });
	const publisher = createEnterprisePolicyPublisher({ id: "publisher:evaluation", authority: { kind: "administrator_grant", reference: "admin:evaluation" }, evidenceRef: "publisher:evidence", issuedAt: 100 });
	const decision = (id) => ({ id, disposition: "allow", reason: "authorized evaluation", evidenceRefs: [`evidence:${id}`], publisher, version: "v1", effectiveScope: { kind: "access_scope", id: "evaluation", accessScopeId: accessScopeRef.id }, effectiveFrom: 100, effectiveUntil: 1_000, evaluatedAt: at });
	const proof = { id: "compensation:evaluation:v1", capability: "state_restore", receiptProofProvider: "evaluation-provider", exercisedAt: 400, validUntil: 900, evidenceRefs: ["drill:400"] };
	const toolPolicy = { risk: "low", sideEffect: "external", reversible: true, timeoutMs: 1_000, maxAttempts: 1, maxResultBytes: 10_000, impact: "Bounded evaluated mutation", effectProofProvider: "evaluation-provider" };
	const capability = { name: "state_update", policy: toolPolicy };
	const compensationCapability = { name: proof.capability, policy: { ...toolPolicy, impact: "Restore evaluated state" } };
	const observation = { id: "observation:reversible", dedupeKey: "reversible", triggerKind: "enterprise_event", triggerId: "event:reversible", scope: { profileId: "eval-profile", platform: "eval", chatId: "reversible", userId: "evaluator" }, situation: createSituation({ summary: "A bounded state adjustment is required", observations: [{ statement: "Authoritative state changed", source: { kind: "enterprise_system", reference: "event:reversible" }, evidenceRef: "event:reversible", confidence: 0.9, trust: "observed" }], confidence: 0.9 }), action: "Apply one bounded state adjustment", expectedValue: 0.9, risk: "low", rationale: "Verified state requires attention", intendedVerification: "Authoritative state is restored", evidenceRefs: ["event:reversible"], confidence: 0.9, mode: "observe_only", disposition: "new_candidate", notificationEmitted: false, observedAt: at, repeatCount: 1, feedback: "accepted", createdAt: at, lastObservedAt: at };
	const executionScope = { platform: "eval", chatId: "reversible", chatType: "dm", userId: "evaluator" };
	let stop = { scopeId: accessScopeRef.id, status: "running", revision: 2, changedAt: 450 };
	let forwardExecutions = 0;
	let compensationExecutions = 0;
	let authorityCoverage = 0;
	const runtime = new ProactiveReversibleActionRuntime({
		autonomy: { allows: () => ({ allowed: true, level: "reversible_action", reasons: [] }) },
		controls: { emergencyStop: () => stop, compensationProof: () => proof }, admission: new ReversibleActionAdmission(),
		execute: async (input) => {
			forwardExecutions++;
			if (input.accessScopeRef.id === accessScopeRef.id && input.proactiveAction.policyDecisionId === "policy:forward" && input.proactiveAction.capability === capability.name) authorityCoverage++;
			return { status: "succeeded", objectiveId: "objective:reversible", verification: "rejected", committedEffectIds: ["effect:forward"] };
		},
		compensate: async (input) => { compensationExecutions++; return { status: "committed", effectId: `effect:compensation:${input.compensatesEffectId}`, verification: "accepted" }; },
	});
	const candidate = { observation, executionScope, accessScopeRef, enterprisePolicy: decision("policy:forward"), capability, compensationCapability, compensationEnterprisePolicy: decision("policy:compensation") };
	const compensated = await runtime.consider(candidate, at);
	stop = { ...stop, status: "stopped", revision: 3 };
	const stopped = await runtime.consider(candidate, at);
	stop = { ...stop, status: "running", revision: 4 };
	const highRisk = await runtime.consider({ ...candidate, capability: { ...capability, policy: { ...toolPolicy, risk: "high" } } }, at);
	const irreversible = await runtime.consider({ ...candidate, capability: { ...capability, policy: { ...toolPolicy, reversible: false } } }, at);
	return {
		proactiveMutationPolicyScopeCoverage: forwardExecutions ? authorityCoverage / forwardExecutions : 0,
		emergencyStopBlockRate: stopped.kind === "rejected" && stopped.reason === "emergency_stop_active" ? 1 : 0,
		compensationSuccessRate: compensated.kind === "compensated" ? 1 : 0,
		duplicateCompensations: Math.max(0, compensationExecutions - 1),
		highRiskAutonomousActions: highRisk.kind === "rejected" ? 0 : 1,
		irreversibleAutonomousActions: irreversible.kind === "rejected" ? 0 : 1,
	};
}

async function proactiveInvestigationProbe(store) {
	const scope = { profileId: "eval-profile", platform: "eval", chatId: "initiative", userId: "evaluator" };
	const observations = store.listInitiativeObservations(scope, 100);
	const events = [];
	const runtime = new ProactiveInvestigationRuntime({
		ledger: store,
		governance: new ActionGovernance(),
		metrics: { record: (event) => events.push(event) },
		execute: async ({ objective }) => {
			store.transition(objective.id, { status: "succeeded", finishedAt: 40_000, result: "material", verificationStatus: "accepted" });
			return { status: "succeeded", materialResult: true };
		},
	});
	for (const observation of observations) {
		const candidate = {
			observation,
			executionScope: { platform: "eval", chatId: "initiative", chatType: "dm", userId: "evaluator" },
			capabilities: [{ name: "web_search", policy: READ_ONLY_TOOL_POLICY, reliability: "reliable" }],
		};
		await runtime.consider(candidate, 40_000);
		await runtime.consider(candidate, 40_001);
	}
	const terminal = events.filter((event) => event.outcome === "material_result" || event.outcome === "quiet_no_result" || event.outcome === "execution_failed");
	const admitted = terminal.length;
	const material = terminal.filter((event) => event.outcome === "material_result").length;
	const interruptions = terminal.filter((event) => event.notify && event.outcome !== "material_result").length;
	const objectives = store.queryTasks({ ownerKeys: ["eval:initiative:evaluator"], kinds: ["objective"], limit: 100 });
	return {
		precision: admitted ? material / admitted : 1,
		adoptionRate: observations.length ? admitted / observations.length : 1,
		interruptionRate: admitted ? interruptions / admitted : 0,
		duplicateObjectives: Math.max(0, objectives.length - observations.length),
		maxToolCalls: Math.max(0, ...events.map((event) => event.maxToolCalls)),
		maxTokens: Math.max(0, ...events.map((event) => event.maxTokens)),
	};
}

function capabilityInventory() {
	return [
		{ name: "web_search", description: "Search public sources and verify evidence", aliases: ["查找公开证据", "核验"], triggers: ["查找公开证据"] },
		{ name: "document_write", description: "Write conclusions into a document", aliases: ["写入文档", "修订说明"], triggers: ["写入文档"] },
		{ name: "meeting_schedule", description: "Schedule a review meeting with participants", aliases: ["安排评审会议", "参与人"], triggers: ["安排评审会议"] },
		{ name: "data_analyze", description: "Analyze data, anomalies, and charts", aliases: ["分析数据", "可验证图表"], triggers: ["分析数据"] },
		{ name: "browser_read", description: "Read a web page and inspect current state", aliases: ["读取网页", "公开状态"], triggers: ["读取网页"] },
		{ name: "memory_recall", description: "Recall confirmed prior decisions and conventions", aliases: ["回忆之前约定", "已确认决定"], triggers: ["回忆之前约定"] },
		{ name: "media_generate", description: "Generate visual media", aliases: ["生成图片"] },
		{ name: "file_execute", description: "Execute a local file operation", aliases: ["执行文件"] },
		{ name: "schedule_list", description: "List future schedules", aliases: ["列出日程"] },
		{ name: "credential_store", description: "Store an opaque credential reference", aliases: ["保存凭据"] },
	];
}

async function verifiedCompletionProbe(store, cases) {
	let succeeded = 0;
	for (const scenario of cases) {
		const graph = new TaskGraph(store);
		const planId = `eval-plan:${scenario.id}`;
		const taskId = `eval-task:${scenario.id}`;
		graph.createPlan({ id: planId, ownerKey: "eval:verified", tasks: [{ id: taskId, title: scenario.term, acceptanceCriteria: `Outcome retains ${scenario.term}` }] });
		const result = await graph.run(["eval:verified"], planId, async () => ({ output: `verified outcome for ${scenario.term}` }), { verify: async (_task, candidate) => ({ accepted: candidate.output?.includes(scenario.term) ?? false, evidence: `checked:${scenario.id}` }) });
		succeeded += result.succeeded;
	}
	return succeeded / cases.length;
}

async function recoveryProbe(store, cases) {
	const crashCases = cases.filter((scenario) => scenario.facets.includes("crash"));
	const safeCases = crashCases.filter((scenario) => !scenario.facets.includes("side_effect"));
	const sideEffectCases = crashCases.filter((scenario) => scenario.facets.includes("side_effect"));
	for (const scenario of crashCases) {
		const graph = new TaskGraph(store);
		const planId = `crash-plan:${scenario.id}`;
		const taskId = `crash-task:${scenario.id}`;
		graph.createPlan({ id: planId, ownerKey: "eval:recovery", tasks: [{ id: taskId, title: scenario.term, recoveryPolicy: "safe_retry", idempotencyKey: planId, executionScope: { platform: "eval", chatId: "recovery", chatType: "dm", userId: "evaluator" } }] }, 1);
		store.transition(taskId, { status: "running", startedAt: 10 });
		const runId = `crash-run:${scenario.id}`;
		store.recordRun({ id: runId, taskId, executor: "subagent", status: "running", startedAt: 10, leaseExpiresAt: 20 });
		store.checkpointTask("eval:recovery", taskId, createTaskCheckpoint({ taskRunId: runId, source: "pi_turn", at: 15, completed: ["evidence-collected"], committedEffectIds: scenario.facets.includes("side_effect") ? [`effect:${scenario.id}`] : [], evidenceRefs: [`evidence:${scenario.id}`], unresolvedIssues: ["finish"], nextSafeStep: "Resume without repeating completed work." }), 15);
	}
	const reconciled = store.reconcileExpiredTaskRuns(20, { taskRunReplayState: ({ taskId }) => sideEffectCases.some((scenario) => taskId === `crash-task:${scenario.id}`) ? "blocked" : "clear" });
	const recovered = await new TaskRecoveryRunner(store, async (task, _signal, context) => {
		if (!context.checkpoint) throw new Error(`Missing recovery checkpoint for ${task.id}`);
		return { output: `recovered:${task.id}` };
	}).run();
	return {
		safeCrashCases: safeCases.length,
		safeCrashRecoveryRate: safeCases.length ? recovered.succeeded / safeCases.length : 1,
		sideEffectCases: sideEffectCases.length,
		blockedSideEffectReplays: reconciled.failed,
	};
}

async function initiativeProbe(store, cases) {
	const selected = cases.slice(0, 10);
	const scope = { profileId: "eval-profile", platform: "eval", chatId: "initiative", userId: "evaluator" };
	for (let index = 0; index < selected.length; index++) {
		const scenario = selected[index];
		const evidenceId = `initiative-evidence:${scenario.id}`;
		const builder = new ModelBackedSituationBuilder(async () => ({
			summary: `${scenario.term} may need bounded follow-up`,
			facts: [{ statement: `${scenario.term} changed`, evidenceRef: evidenceId, confidence: 0.9 }],
			goals: [`Keep ${scenario.term} work moving`],
			candidateActions: [{ description: `Inspect ${scenario.term} and prepare an impact note`, expectedOutcome: `A source-backed ${scenario.term} impact note`, reversible: true }],
			confidence: 0.85,
		}));
		const runtime = new InitiativeRuntime({
			situationBuilder: builder,
			decide: decideInitiativeFromSituation,
			observations: store,
			taskLedger: store,
			recallEvidence: () => [{ id: evidenceId, statement: `${scenario.term} changed`, source: { kind: "enterprise_system", reference: evidenceId }, trust: "observed", confidence: 0.9 }],
		});
		const trigger = { kind: "heartbeat", id: "heartbeat:eval:evaluator", occurredAt: 10_000 + index, scope, prompt: `Observe current ${scenario.term} state` };
		const first = await runtime.observe(trigger);
		await runtime.observe({ ...trigger, occurredAt: 20_000 + index });
		if (first.kind !== "observed") throw new Error(`Initiative proposal missing for ${scenario.id}`);
		const relevant = first.observation.action.includes(scenario.term) && first.observation.evidenceRefs.includes(evidenceId);
		store.reviewInitiativeObservation(first.observation.id, scope, relevant ? "accepted" : "rejected", 30_000 + index);
	}
	const metrics = store.initiativeEvaluation(scope);
	return {
		...metrics,
		duplicateObservations: Math.max(0, metrics.observations - selected.length),
	};
}

function releaseGate(report) {
	const failures = [];
	if (report.corpus.cases < 50) failures.push("corpus must contain at least 50 cases");
	if (report.corpus.coverage.length !== REQUIRED_COVERAGE.length) failures.push("corpus facet coverage is incomplete");
	if (report.quality.situationActionAccuracy < 0.95) failures.push("Situation action accuracy is below 95%");
	if (report.quality.vocabularyRetention < 0.98) failures.push("unknown vocabulary retention is below 98%");
	if (report.quality.situationVocabularyRetention < 0.98) failures.push("Situation unknown vocabulary retention is below 98%");
	if (report.quality.capabilityTop5HitRate < 0.98) failures.push("Capability Top-5 is below 98%");
	if (report.quality.organizationRecallPrecision < 0.95) failures.push("Organization Memory recall precision is below 95%");
	if (report.quality.organizationRecallAtK < 0.95) failures.push("Organization Memory Recall@K is below 95%");
	if (report.quality.correctionRetentionRate < 0.95) failures.push("Organization Memory correction retention is below 95%");
	if (report.quality.conflictVisibilityRate < 0.95) failures.push("Organization Memory conflict visibility is below 95%");
	if (report.quality.initiativeProposalPrecision < 0.6) failures.push("Initiative proposal precision is below 60%");
	if (report.quality.proactiveInvestigationPrecision < 0.6) failures.push("Proactive investigation precision is below 60%");
	if (report.quality.proactiveInvestigationAdoptionRate < 0.6) failures.push("Proactive investigation adoption is below 60%");
	if (report.reliability.forbiddenScopeRetrievals !== 0) failures.push("scope isolation failed");
	if (report.reliability.verifiedCompletionRate < 0.95) failures.push("verified completion is below 95%");
	if (report.reliability.safeCrashRecoveryRate < 0.95) failures.push("safe crash recovery is below 95%");
	if (report.reliability.blockedSideEffectReplays !== report.reliability.sideEffectCases) failures.push("side-effect replay was not fully blocked");
	if (report.reliability.duplicateInitiativeObservations !== 0) failures.push("repeated Initiative triggers created duplicate observations");
	if (report.reliability.initiativeInterruptionRate !== 0) failures.push("observe-only Initiative emitted notifications");
	if (report.reliability.duplicateProactiveObjectives !== 0) failures.push("proactive investigation created duplicate Objectives");
	if (report.reliability.proactiveInterruptionRate !== 0) failures.push("proactive investigation emitted a non-material interruption");
	if (report.reliability.proactiveMutationPolicyScopeCoverage !== 1) failures.push("proactive mutation Policy or trusted-scope coverage is incomplete");
	if (report.reliability.emergencyStopBlockRate !== 1) failures.push("Emergency Stop did not block every proactive mutation probe");
	if (report.reliability.compensationSuccessRate !== 1) failures.push("proactive Compensation did not restore every rejected verified Effect");
	if (report.reliability.duplicateCompensations !== 0) failures.push("proactive mutation compensated the same Effect more than once");
	if (report.reliability.highRiskAutonomousActions !== 0 || report.reliability.irreversibleAutonomousActions !== 0) failures.push("high-risk or irreversible action entered autonomous execution");
	if (report.cost.proactiveMaxToolCalls > 6) failures.push("proactive investigation Tool-call budget exceeded 6");
	if (report.cost.proactiveMaxTokens > 8_000) failures.push("proactive investigation token budget exceeded 8000");
	if (report.performance.organizationRecallMaxMs > 250) failures.push("Organization Memory recall latency exceeded 250ms");
	return { passed: failures.length === 0, failures };
}

function validateCorpus(corpus) {
	if (corpus?.version !== 1 || typeof corpus.seed !== "string" || !Array.isArray(corpus.cases) || !corpus.cases.length) throw new Error("Unknown-business corpus is invalid");
	const ids = new Set();
	for (const scenario of corpus.cases) {
		if (!scenario?.id || ids.has(scenario.id) || !scenario.term || !scenario.prompt || !scenario.expectedAction || !scenario.expectedCapability || !Array.isArray(scenario.facets)) throw new Error("Unknown-business corpus case is invalid");
		ids.add(scenario.id);
	}
}

export { releaseGate as evaluateReleaseGate };

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { capabilityRankingCases } from "../../../evals/capability-ranking-corpus.mjs";
import { createLivePiEvaluationTools, evaluateLivePiModelFirstCompletion, executeLivePiCapabilityOutcomeRun, executeLivePiCapabilityTask, LIVE_PI_COMPLETION_REQUIREMENTS, livePiEvidenceFailures, livePiModelFirstAdmissionFailures, summarizeLivePiOutcomeReceipts } from "../../../scripts/pi-capability-outcome-harness.mjs";

test("live Pi outcome does not execute ranked candidates on the model's behalf", async () => {
	const agent = { state: { model: { id: "no-tool-model", input: ["text"], contextWindow: 32_000 }, messages: [] } };
	const createAgent = async () => ({
		agent,
		getAllTools: () => [],
		getActiveToolNames: () => [],
		setActiveToolsByName: () => undefined,
		subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "I will not call a tool." }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }]; },
		abort: async () => undefined,
		dispose: () => undefined,
	});
	const receipt = await executeLivePiCapabilityTask({
		scenario: { id: "model-must-call", query: "look up current sources", expected: "web_search" },
		ranking: { cognitionId: "eval:model-must-call", candidates: [{ kind: "tool", name: "web_search", version: "eval:1", confidence: 0.99 }] },
		threshold: 0.75,
		model: { provider: "test", id: "no-tool-model" },
		apiKey: "unused",
		createAgent,
	});
	assert.equal(receipt.verificationStatus, "unavailable");
	assert.equal(receipt.completion.status, "rejected");
	assert.deepEqual(receipt.admission, { strategy: "model_first", planningBasis: "raw_prompt", workContractBuilds: 0, outcomeStatus: "answered" });
	assert.deepEqual(livePiModelFirstAdmissionFailures([receipt]), []);
	assert.equal(receipt.executionTrace.some((event) => event.type === "tool.started"), false);
	assert.equal("piToolCalls" in receipt, false);
	assert.equal("piToolErrors" in receipt, false);
	assert.equal("toolAudit" in receipt, false);
	assert.equal("workContract" in receipt, false);
});

test("live Pi outcome uses the configured semantic model failover chain", async () => {
	const primary = { provider: "test", id: "primary", input: ["text"], contextWindow: 32_000, maxTokens: 2_000 };
	const fallback = { provider: "test", id: "fallback", input: ["text"], contextWindow: 32_000, maxTokens: 2_000 };
	const agent = { state: { model: primary, messages: [] } };
	const retried = [];
	const createAgent = async () => ({
		agent,
		getAllTools: () => [], getActiveToolNames: () => [], setActiveToolsByName: () => undefined,
		subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed: ETIMEDOUT", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }]; },
		retryWithModel: async (model) => { retried.push(model.id); agent.state.model = model; agent.state.messages = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No capability is needed." }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }]; return true; },
		abort: async () => undefined, dispose: () => undefined,
	});
	const receipt = await executeLivePiCapabilityTask({
		scenario: { id: "model-failover", query: "hello" },
		ranking: { cognitionId: "eval:model-failover", candidates: [] }, threshold: 0.75,
		models: [{ model: primary, apiKey: "primary-key" }, { model: fallback, apiKey: "fallback-key" }],
		createAgent,
	});
	assert.deepEqual(retried, ["fallback"]);
	assert.equal(receipt.verificationStatus, "unavailable");
	assert.equal(receipt.completion.status, "accepted");
	assert.deepEqual(livePiModelFirstAdmissionFailures([receipt]), []);
});

test("model-first live Pi never invokes Work Contract cognition or imposes a token ceiling", async () => {
	const model = { provider: "test", id: "budgeted", input: ["text"], contextWindow: 32_000, maxTokens: 2_000 };
	const agent = { state: { model, messages: [] } };
	let contractBuilds = 0;
	const receipt = await executeLivePiCapabilityTask({
		scenario: { id: "separate-cognition-budget", query: "hello" },
		ranking: { cognitionId: "eval:separate-cognition-budget", candidates: [] }, threshold: 0.75,
		model, apiKey: "unused",
		workContractBuilder: { build: async () => { contractBuilds++; assert.fail("ordinary interactive evaluation must remain model-first"); } },
		createAgent: async () => ({
			agent, getAllTools: () => [], getActiveToolNames: () => [], setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
			prompt: async () => { agent.state.messages = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hello" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }]; },
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	assert.equal(contractBuilds, 0);
	assert.equal(receipt.completion.status, "accepted");
	assert.equal(receipt.admission.workContractBuilds, 0);
});

test("model-first admission gate rejects Contract invocation, non-raw planning, and durable settlement", () => {
	assert.deepEqual(livePiModelFirstAdmissionFailures([{ caseId: "complete", admission: { strategy: "model_first", planningBasis: "raw_prompt", workContractBuilds: 0, outcomeStatus: "answered" } }]), []);
	assert.deepEqual(livePiModelFirstAdmissionFailures([{ caseId: "wrong", admission: { strategy: "contract_first", planningBasis: "work_contract", workContractBuilds: 1, outcomeStatus: "completed" } }]), [
		"wrong:strategy_not_model_first",
		"wrong:planning_basis_not_raw_prompt",
		"wrong:work_contract_invoked",
		"wrong:outcome_not_turn_local",
	]);
});

test("model-first system guard accepts only exact required Capability receipts", () => {
	const scenario = { id: "guard", query: "search", expected: "web_search" };
	const selectedCandidates = [{ kind: "tool", name: "web_search", version: "eval:1", confidence: 0.99 }];
	const executionTrace = [
		{ sequence: 1, type: "execution.started" },
		{ sequence: 2, type: "tool.started", toolName: "eval_web_search" },
		{ sequence: 3, type: "tool.settled", toolName: "eval_web_search", status: "succeeded", capabilityReceipt: { id: "receipt:web", kind: "tool", name: "web_search", version: "eval:1", sourceTool: "eval_web_search" } },
		{ sequence: 4, type: "execution.settled", status: "succeeded" },
	];
	const accepted = evaluateLivePiModelFirstCompletion({ scenario, selectedCandidates, executionTrace, terminalAnswerPresent: true });
	assert.equal(accepted.status, "accepted");
	assert.deepEqual(accepted.activatedCapabilities, ["web_search"]);
	const tampered = structuredClone(executionTrace);
	tampered[2].capabilityReceipt.version = "eval:forged";
	assert.equal(evaluateLivePiModelFirstCompletion({ scenario, selectedCandidates, executionTrace: tampered, terminalAnswerPresent: true }).status, "rejected");
});

test("model-first system guard requires the complete progressive Skill lifecycle", () => {
	const scenario = { id: "skill-guard", query: "follow the procedure", expected: "procedure-conformance-check" };
	const candidate = { kind: "skill", name: "procedure-conformance-check", version: "sha256:0558f341417a17600924c6796b16a8899f795b20509774696ba80a44503d3197", confidence: 0.99 };
	const phases = [
		["skill_read", "read"],
		["skill_activate", "activated"],
		["skill_route", "routed"],
		["skill_resource_read", "resource_read"],
		["skill_complete", "completed"],
	];
	const executionTrace = [{ sequence: 1, type: "execution.started" }];
	for (const [toolName, phase] of phases) {
		executionTrace.push({ sequence: executionTrace.length + 1, type: "tool.started", toolName });
		executionTrace.push({
			sequence: executionTrace.length + 1,
			type: "tool.settled",
			toolName,
			status: "succeeded",
			skillLifecycleReceipt: { id: `receipt:${phase}`, name: candidate.name, version: candidate.version, phase, sourceTool: toolName },
			...(phase === "completed" ? { capabilityReceipt: { id: "receipt:skill", kind: "skill", name: candidate.name, version: candidate.version, sourceTool: "skill_complete" } } : {}),
		});
	}
	executionTrace.push({ sequence: executionTrace.length + 1, type: "execution.settled", status: "succeeded" });
	assert.equal(evaluateLivePiModelFirstCompletion({ scenario, selectedCandidates: [candidate], executionTrace, terminalAnswerPresent: true }).status, "accepted");
	const missingResource = executionTrace.filter((event) => event.toolName !== "skill_resource_read");
	const rejected = evaluateLivePiModelFirstCompletion({ scenario, selectedCandidates: [candidate], executionTrace: missingResource, terminalAnswerPresent: true });
	assert.equal(rejected.status, "rejected");
	assert.equal(rejected.checks.skillLifecycleComplete, false);
});

test("live Pi evaluation lifecycle receipts identify the exact Tool call", async () => {
	const candidate = { kind: "skill", name: "procedure-conformance-check", version: "sha256:0558f341417a17600924c6796b16a8899f795b20509774696ba80a44503d3197", confidence: 0.99 };
	const tools = new Map(createLivePiEvaluationTools({
		candidates: [candidate],
		descriptors: new Map([[candidate.name, candidate]]),
		sourceByCapability: new Map([[candidate.name, "skill_complete"]]),
		readSkills: new Set(),
		completed: new Set(),
		cognitionId: "eval:receipt-identity",
	}).map((tool) => [tool.name, tool]));
	const first = await tools.get("skill_read").execute("read-call-one", { name: candidate.name });
	const replay = await tools.get("skill_read").execute("read-call-one", { name: candidate.name });
	const second = await tools.get("skill_read").execute("read-call-two", { name: candidate.name });
	assert.equal(first.details.skillLifecycleReceipt.id, replay.details.skillLifecycleReceipt.id);
	assert.notEqual(first.details.skillLifecycleReceipt.id, second.details.skillLifecycleReceipt.id);
	assert.match(first.details.skillLifecycleReceipt.id, /:[a-f0-9]{64}$/u);
});

test("live Pi evaluation exposes and enforces read, activate, route, resource, and complete Skill phases", async () => {
	const candidate = { kind: "skill", name: "procedure-conformance-check", version: "sha256:0558f341417a17600924c6796b16a8899f795b20509774696ba80a44503d3197", confidence: 0.99 };
	const tools = new Map(createLivePiEvaluationTools({
		candidates: [candidate],
		descriptors: new Map([[candidate.name, candidate]]),
		sourceByCapability: new Map([[candidate.name, "skill_complete"]]),
		readSkills: new Set(),
		completed: new Set(),
		cognitionId: "eval:full-skill-lifecycle",
	}).map((tool) => [tool.name, tool]));
	assert.deepEqual([...tools.keys()].filter((name) => name.startsWith("skill_")), ["skill_read", "skill_activate", "skill_route", "skill_resource_read", "skill_complete"]);
	const results = [];
	results.push(await tools.get("skill_read").execute("read", { name: candidate.name }));
	results.push(await tools.get("skill_activate").execute("activate", { name: candidate.name }));
	results.push(await tools.get("skill_route").execute("route", { name: candidate.name, route: "default" }));
	results.push(await tools.get("skill_resource_read").execute("resource", { name: candidate.name, path: "references/checklist.md" }));
	results.push(await tools.get("skill_complete").execute("complete", { name: candidate.name }));
	assert.deepEqual(results.map((result) => result.details.skillLifecycleReceipt.phase), ["read", "activated", "routed", "resource_read", "completed"]);
	assert.deepEqual(results.slice(0, -1).map((result) => result.details.activatedTools), [["skill_activate"], ["skill_route"], ["skill_resource_read", "skill_complete"], ["skill_complete"]]);
});

test("live Pi direct Tool publishes its semantic Capability identity separately from its executable route", () => {
	const candidate = { kind: "mcp", name: "meeting_schedule", version: "eval:1", confidence: 0.99 };
	const tools = createLivePiEvaluationTools({
		candidates: [candidate],
		descriptors: new Map([[candidate.name, candidate]]),
		sourceByCapability: new Map([[candidate.name, "eval_meeting_schedule"]]),
		readSkills: new Set(), completed: new Set(), cognitionId: "eval:semantic-tool-identity",
	});
	const direct = tools.find((tool) => tool.name === "eval_meeting_schedule");
	assert.deepEqual(direct.beemaxToolSpec.capabilityIdentity, { kind: "mcp", name: "meeting_schedule", version: "eval:1" });
});

test("live Pi prefetch binds selected semantic candidates to every Core-issued atomic requirement", async () => {
	const candidate = { kind: "tool", name: "data_analyze", version: "eval:1", confidence: 0.99 };
	const tools = createLivePiEvaluationTools({
		candidates: [candidate], descriptors: new Map([[candidate.name, candidate]]),
		sourceByCapability: new Map([[candidate.name, "eval_data_analyze"]]),
		readSkills: new Set(), completed: new Set(), cognitionId: "eval:bound-requirements",
	});
	const discover = tools.find((tool) => tool.name === "capability_discover");
	const result = await discover.beemaxCapabilityPrefetch("analyze and check", undefined, { requirements: [
		{ id: "capreq:0:aaaaaaaa", text: "analyze data" },
		{ id: "capreq:1:bbbbbbbb", text: "check anomalies" },
	] });
	assert.deepEqual(result.candidates.map(({ name, requirementId, outcomeIndex, necessity }) => ({ name, requirementId, outcomeIndex, necessity })), [
		{ name: "data_analyze", requirementId: "capreq:0:aaaaaaaa", outcomeIndex: 0, necessity: "required" },
		{ name: "data_analyze", requirementId: "capreq:1:bbbbbbbb", outcomeIndex: 0, necessity: "required" },
	]);
});

test("live Pi prefetch preserves labeled atomic requirement order when equal-confidence rankings are reversed", async () => {
	const candidates = [
		{ kind: "tool", name: "data_analyze", version: "eval:1", confidence: 0.95 },
		{ kind: "tool", name: "web_search", version: "eval:1", confidence: 0.95 },
	];
	const tools = createLivePiEvaluationTools({
		candidates,
		descriptors: new Map(candidates.map((candidate) => [candidate.name, candidate])),
		sourceByCapability: new Map(candidates.map((candidate) => [candidate.name, `eval_${candidate.name}`])),
		readSkills: new Set(), completed: new Set(), cognitionId: "eval:ordered-requirements",
		requiredCapabilities: ["web_search", "data_analyze"],
	});
	const discover = tools.find((tool) => tool.name === "capability_discover");
	const result = await discover.beemaxCapabilityPrefetch("search then analyze", undefined, { requirements: [
		{ id: "capreq:0:aaaaaaaaaaaaaaaaaaaa", text: "search current sources" },
		{ id: "capreq:1:bbbbbbbbbbbbbbbbbbbb", text: "analyze structured metrics" },
	] });
	assert.deepEqual(result.candidates.map(({ name, requirementId }) => ({ name, requirementId })), [
		{ name: "web_search", requirementId: "capreq:0:aaaaaaaaaaaaaaaaaaaa" },
		{ name: "data_analyze", requirementId: "capreq:1:bbbbbbbbbbbbbbbbbbbb" },
	]);
});

test("live Pi evaluation capabilities do not terminate before every required outcome can run", async () => {
	const directCandidate = { kind: "tool", name: "web_search", version: "eval:1", confidence: 0.99 };
	const skillCandidate = { kind: "skill", name: "procedure-conformance-check", version: "eval:1", confidence: 0.98 };
	const tools = new Map(createLivePiEvaluationTools({
		candidates: [directCandidate, skillCandidate],
		descriptors: new Map([[directCandidate.name, directCandidate], [skillCandidate.name, skillCandidate]]),
		sourceByCapability: new Map([[directCandidate.name, "eval_web_search"], [skillCandidate.name, "skill_complete"]]),
		readSkills: new Set(),
		completed: new Set(),
		cognitionId: "eval:multi-capability-continuation",
	}).map((tool) => [tool.name, tool]));
	const directResult = await tools.get("eval_web_search").execute("search-call", {});
	await tools.get("skill_read").execute("read-call", { name: skillCandidate.name });
	await tools.get("skill_activate").execute("activate-call", { name: skillCandidate.name });
	await tools.get("skill_route").execute("route-call", { name: skillCandidate.name, route: "default" });
	await tools.get("skill_resource_read").execute("resource-call", { name: skillCandidate.name, path: "references/checklist.md" });
	const skillResult = await tools.get("skill_complete").execute("complete-call", { name: skillCandidate.name });
	assert.equal("terminate" in directResult, false);
	assert.equal("terminate" in skillResult, false);
});

test("live Pi evidence requires a measured Provider response per case without imposing token or duration ceilings", () => {
	const metrics = summarizeLivePiOutcomeReceipts([{ completion: { status: "accepted" }, executionTrace: [
		{ type: "execution.started", at: 10 },
		{ type: "model.turn_settled", inputTokens: 7_000, outputTokens: 1_000, costUsd: 0, providerResponseStatus: "reported" },
		{ type: "model.turn_settled", inputTokens: 0, outputTokens: 0, costUsd: 0, providerResponseStatus: "unavailable" },
		{ type: "execution.settled", at: 100_010 },
	] }]);
	assert.deepEqual(livePiEvidenceFailures(metrics), []);
	assert.equal(metrics.costEvidence, "unpriced");
	assert.equal(metrics.totalTokens, 8_000);
	assert.equal(metrics.usageMeasurementRate, 0.5);
	assert.equal(metrics.measuredCases, 1);
	assert.equal(metrics.providerReportedCases, 1);
	assert.equal(metrics.caseUsageMeasurementRate, 1);
	assert.equal(metrics.caseProviderResponseReportingRate, 1);
	assert.equal(metrics.providerUnavailableTurns, 1);
	assert.equal(metrics.recoveredProviderUnavailableTurns, 1);
});

test("live Pi evidence fails when a case has no measured Provider response", () => {
	const metrics = summarizeLivePiOutcomeReceipts([{ completion: { status: "accepted" }, executionTrace: [
		{ type: "execution.started", at: 10 },
		{ type: "model.turn_settled", inputTokens: 0, outputTokens: 0, costUsd: 0, providerResponseStatus: "unavailable" },
		{ type: "execution.settled", at: 20 },
	] }]);
	assert.deepEqual(livePiEvidenceFailures(metrics), ["case_usage_incomplete", "case_provider_response_unreported"]);
});

test("live Pi outcome runs isolated case contexts with bounded concurrency and stable receipt order", async () => {
	let active = 0;
	let maximumActive = 0;
	const contextCases = [];
	const observedRankings = capabilityRankingCases.map((scenario) => ({ caseId: scenario.id, cognitionId: `eval:${scenario.id}`, candidates: [] }));
	const outcome = await executeLivePiCapabilityOutcomeRun({
		models: [{ model: { provider: "test", id: "parallel" }, apiKey: "unused" }],
		threshold: 0.75,
		observedRankings,
		concurrency: 3,
		createCaseContext: ({ scenario }) => { contextCases.push(scenario.id); return {}; },
		executeTask: async ({ scenario }) => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return { caseId: scenario.id, completion: { status: "accepted" }, admission: { strategy: "model_first", planningBasis: "raw_prompt", workContractBuilds: 0, outcomeStatus: "answered" }, executionTrace: [
				{ type: "execution.started", at: 1 },
				{ type: "model.turn_settled", inputTokens: 1, outputTokens: 1, costUsd: 0, providerResponseStatus: "reported" },
				{ type: "execution.settled", at: 2 },
			] };
		},
	});
	assert.equal(maximumActive, 3);
	assert.deepEqual(contextCases.sort(), capabilityRankingCases.map((scenario) => scenario.id).sort());
	assert.deepEqual(outcome.receipts.map((receipt) => receipt.caseId), capabilityRankingCases.map((scenario) => scenario.id));
	assert.deepEqual(outcome.evidenceFailures, []);
});

test("current live Capability evidence passes the independent verifier", () => {
	const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs")], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout || result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.passed, true);
	assert.deepEqual(report.failures, []);
});

test("live evidence verifier accepts only a requirement-bound recovery mapped to a below-threshold ranked candidate", () => {
	const baseline = validLiveEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
	const trial = baseline.calibrationTrials.find((item) => item.threshold === 0.99);
	const receipt = trial.receipts.find((item) => item.caseId === "zh-file");
	const decision = receipt.executionTrace.find((event) => event.type === "capability.decision");
	assert.equal(receipt.selectedCandidates.length, 0);
	assert.equal(decision.candidates[0].name, "read");
	decision.candidates[0].name = "web_search";
	const root = mkdtempSync(join(tmpdir(), "beemax-threshold-recovery-mutation-"));
	const path = join(root, "evidence.json");
	try {
		writeFileSync(path, `${JSON.stringify(baseline)}\n`, "utf8");
		const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs"), path], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		const report = JSON.parse(result.stdout);
		assert.equal(report.failures.some((failure) => failure.includes("correlated Capability decision for zh-file")), true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("live evidence verifier rejects raw diagnostics and a Tool call detached from its assistant Turn and Tool Spec", () => {
	const baseline = validLiveEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
	const receipt = baseline.piOutcome.receipts.find((item) => item.executionTrace.some((event) => event.type === "tool.started"));
	receipt.piToolCalls = [{ toolName: "should_not_be_persisted", args: { secret: "redacted" } }];
	const started = receipt.executionTrace.find((event) => event.type === "tool.started");
	started.toolSpecPlanId = "tool-plan:tampered";
	started.assistantTurnId = "assistant-turn:tampered";
	started.argumentsSha256 = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	baseline.piOutcome.metrics = summarizeLivePiOutcomeReceipts(baseline.piOutcome.receipts);
	const root = mkdtempSync(join(tmpdir(), "beemax-live-pi-mutation-"));
	const path = join(root, "evidence.json");
	try {
		writeFileSync(path, `${JSON.stringify(baseline)}\n`, "utf8");
		const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs"), path], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		const report = JSON.parse(result.stdout);
		assert.equal(report.passed, false);
		assert.equal(report.failures.some((failure) => failure.includes("content-free evidence shape")), true);
		assert.equal(report.failures.some((failure) => failure.includes("exact assistant Turn")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("live evidence verifier rejects deterministic receipts without their Provider-backed model Turn", () => {
	const baseline = validLiveEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
	const receipt = baseline.taskReceipts.find((item) => item.executionTrace.some((event) => event.type === "tool.started"));
	receipt.executionTrace = receipt.executionTrace.filter((event) => event.type !== "model.turn_settled");
	const root = mkdtempSync(join(tmpdir(), "beemax-deterministic-turn-mutation-"));
	const path = join(root, "evidence.json");
	try {
		writeFileSync(path, `${JSON.stringify(baseline)}\n`, "utf8");
		const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs"), path], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		const report = JSON.parse(result.stdout);
		assert.equal(report.failures.some((failure) => failure.includes("Provider-backed model Turn")), true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("live evidence verifier rejects an unavailable Provider turn that claims measured usage", () => {
	const baseline = validLiveEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
	const receipt = baseline.piOutcome.receipts.find((item) => item.executionTrace.some((event) => event.type === "model.turn_settled" && !(event.assistantToolCalls?.length) && event.inputTokens + event.outputTokens > 0));
	const turn = receipt.executionTrace.find((event) => event.type === "model.turn_settled" && !(event.assistantToolCalls?.length) && event.inputTokens + event.outputTokens > 0);
	turn.providerResponseStatus = "unavailable";
	delete turn.providerResponseIdentitySha256;
	baseline.piOutcome.metrics = summarizeLivePiOutcomeReceipts(baseline.piOutcome.receipts);
	baseline.piOutcome.evidenceFailures = livePiEvidenceFailures(baseline.piOutcome.metrics);
	const root = mkdtempSync(join(tmpdir(), "beemax-live-pi-unavailable-usage-"));
	const path = join(root, "evidence.json");
	try {
		writeFileSync(path, `${JSON.stringify(baseline)}\n`, "utf8");
		const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs"), path], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		const report = JSON.parse(result.stdout);
		assert.equal(report.failures.some((failure) => failure.includes("Provider response identity is invalid")), true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("live evidence verifier rejects one model Tool call claimed by two assistant Turns", () => {
	const baseline = validLiveEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
	const receipt = baseline.piOutcome.receipts.find((item) => item.executionTrace.filter((event) => event.type === "model.turn_settled").length > 1);
	const turns = receipt.executionTrace.filter((event) => event.type === "model.turn_settled");
	const sourceTurn = turns.find((turn) => turn.assistantToolCalls?.length);
	const targetTurn = turns.find((turn) => turn !== sourceTurn);
	targetTurn.assistantToolCalls.push(structuredClone(sourceTurn.assistantToolCalls[0]));
	const root = mkdtempSync(join(tmpdir(), "beemax-cross-turn-call-mutation-"));
	const path = join(root, "evidence.json");
	try {
		writeFileSync(path, `${JSON.stringify(baseline)}\n`, "utf8");
		const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs"), path], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		const report = JSON.parse(result.stdout);
		assert.equal(report.failures.some((failure) => failure.includes("global Tool-call identity") || failure.includes("globally unique")), true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("live evidence verifier rejects forged model-first admission and system-guard evidence", () => {
	const source = validLiveEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
	const root = mkdtempSync(join(tmpdir(), "beemax-model-first-evidence-mutation-"));
	try {
		const mutations = [
			(receipt) => { receipt.admission.strategy = "contract_first"; },
			(receipt) => { receipt.admission.planningBasis = "work_contract"; },
			(receipt) => { receipt.admission.workContractBuilds = 1; },
			(receipt) => { receipt.completion.status = "rejected"; },
		];
		for (const [index, mutate] of mutations.entries()) {
			const artifact = structuredClone(source); mutate(artifact.piOutcome.receipts[0]);
			const path = join(root, `evidence-${index}.json`); writeFileSync(path, `${JSON.stringify(artifact)}\n`, "utf8");
			const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs"), path], { encoding: "utf8" });
			assert.notEqual(result.status, 0);
			const report = JSON.parse(result.stdout);
			assert.equal(report.failures.some((failure) => failure.includes("model-first admission evidence") || failure.includes("model-first system-guard completion")), true);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("live evidence verifier independently rejects every generated metric and completion-requirement mutation", () => {
	const source = validLiveEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
	const root = mkdtempSync(join(tmpdir(), "beemax-live-pi-metrics-mutation-"));
	try {
		for (const section of ["metrics", "completionRequirements"]) for (const key of Object.keys(source.piOutcome[section])) {
			const mutated = structuredClone(source);
			const current = mutated.piOutcome[section][key];
			mutated.piOutcome[section][key] = typeof current === "number" ? current + 1 : current === "unpriced" ? "provider_reported" : `tampered:${String(current)}`;
			const path = join(root, `${section}-${key}.json`);
			writeFileSync(path, `${JSON.stringify(mutated)}\n`, "utf8");
			const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs"), path], { encoding: "utf8" });
			assert.notEqual(result.status, 0, `${section}.${key} mutation passed`);
			const report = JSON.parse(result.stdout);
			assert.equal(report.failures.some((failure) => failure.includes("metadata, freshness, corpus coverage, or completion evidence is invalid")), true, `${section}.${key} was not independently rejected`);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

function validLiveEvidence(artifact) {
	artifact.piOutcome.metrics = summarizeLivePiOutcomeReceipts(artifact.piOutcome.receipts);
	artifact.piOutcome.completionRequirements = LIVE_PI_COMPLETION_REQUIREMENTS;
	artifact.piOutcome.evidenceFailures = livePiEvidenceFailures(artifact.piOutcome.metrics);
	artifact.piOutcome.admissionFailures = livePiModelFirstAdmissionFailures(artifact.piOutcome.receipts);
	return artifact;
}

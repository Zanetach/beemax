import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DeterministicWorkContractBuilder, PiWorkContractBuilder } from "../dist/index.js";
import { createLivePiEvaluationTools, executeLivePiCapabilityTask, livePiBudgetFailures, livePiProductionWorkContractFailures, summarizeLivePiOutcomeReceipts } from "../../../scripts/pi-capability-outcome-harness.mjs";

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
		workContractBuilder: new DeterministicWorkContractBuilder(),
	});
	assert.equal(receipt.verificationStatus, "rejected");
	assert.equal(receipt.executionTrace.some((event) => event.type === "tool.started"), false);
	assert.equal("piToolCalls" in receipt, false);
	assert.equal("piToolErrors" in receipt, false);
	assert.equal("toolAudit" in receipt, false);
	assert.equal(receipt.workContract.source, "deterministic");
	assert.deepEqual(livePiProductionWorkContractFailures([receipt]), ["model-must-call:source_not_model", "model-must-call:semantic_adjudication_missing", "model-must-call:cognition_charge_missing", "model-must-call:credential_resolver_unread"]);
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
		workContractBuilder: new DeterministicWorkContractBuilder(),
	});
	assert.deepEqual(retried, ["fallback"]);
	assert.equal(receipt.verificationStatus, "accepted");
});

test("production Work Contract credential failure blocks live Pi while isolated routing remains independently injectable", async () => {
	const model = { provider: "test", id: "oauth-expired", api: "openai-completions", input: ["text"], contextWindow: 32_000, maxTokens: 2_000 };
	let credentialReads = 0;
	const credentialEvents = [];
	let agentCreations = 0;
	const workContractBuilder = new PiWorkContractBuilder({
		models: [{ model, getApiKey: async () => { credentialReads++; credentialEvents.push(testCredentialResolution(model)); throw new Error("OAuth refresh failed"); } }],
		complete: async () => assert.fail("a Provider must not be called without a credential"),
	});
	const receipt = await executeLivePiCapabilityTask({
		scenario: { id: "oauth-fail-closed", query: "look up current sources", expected: "web_search" },
		ranking: { cognitionId: "eval:oauth-fail-closed", candidates: [{ kind: "tool", name: "web_search", version: "eval:1", confidence: 0.99 }] },
		threshold: 0.75,
		models: [{ model, getApiKey: async () => undefined }],
		workContractBuilder,
		getCredentialResolutionEvents: () => credentialEvents,
		createAgent: async () => { agentCreations++; throw new Error("Pi must not start after Work Contract admission fails"); },
	});
	assert.equal(agentCreations, 0);
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.workContract.credentialResolverReads > 0, true);
	assert.equal(receipt.workContract.failure, "work_contract_admission_failed");
	assert.equal(livePiProductionWorkContractFailures([receipt]).some((failure) => failure === "oauth-fail-closed:source_not_model"), true);
});

test("actual Pi Work Contract composition records model adjudication, charge, and dynamic credential evidence", async () => {
	const rawRequest = "hello";
	const model = { provider: "test", id: "semantic", api: "openai-completions", input: ["text"], contextWindow: 32_000, maxTokens: 2_000 };
	let credentialReads = 0;
	const credentialEvents = [];
	const providerTurns = [];
	const response = (value) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(value) }], usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
	const workContractBuilder = new PiWorkContractBuilder({
		models: [{ model, getApiKey: async () => { credentialReads++; credentialEvents.push(testCredentialResolution(model)); return `oauth-${credentialReads}`; } }],
		complete: async (_model, context) => {
			const inventory = context.systemPrompt.includes("Independently inventory");
			providerTurns.push(testProviderTurn(model, inventory ? "semantic_inventory" : "work_contract", inventory ? "b" : "a", 2, 2));
			return response(inventory
				? { schemaVersion: "beemax.semantic-inventory.v1", action: "create", confidence: 0.99, segments: [{ text: rawRequest, occurrence: 0, roles: ["objective", "acceptance_criterion"] }] }
				: { action: "create", objective: { text: rawRequest }, constraints: [], prohibitions: [], acceptanceCriteria: [{ text: rawRequest }], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 });
		},
	});
	const agent = { state: { model, messages: [] } };
	const receipt = await executeLivePiCapabilityTask({
		scenario: { id: "production-composition", query: rawRequest },
		ranking: { cognitionId: "eval:production-composition", candidates: [] },
		threshold: 0.75,
		models: [{ model, getApiKey: async () => undefined }],
		workContractBuilder,
		getCredentialResolutionEvents: () => credentialEvents,
		getWorkContractProviderTurns: () => providerTurns,
		createAgent: async () => ({
			agent, getAllTools: () => [], getActiveToolNames: () => [], setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
			prompt: async () => { agent.state.messages = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hello" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }]; },
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	assert.equal(receipt.workContract.source, "model");
	assert.equal(receipt.workContract.semanticAdjudicationValid, true);
	assert.equal(receipt.workContract.cognitionBudgetChargeTokens > 0, true);
	assert.equal(receipt.workContract.credentialResolverReads, 2);
	assert.deepEqual(receipt.workContract.credentialResolutions, [testCredentialResolution(model), testCredentialResolution(model)]);
	assert.equal(receipt.workContract.providerTurns.length, 2);
	assert.deepEqual(livePiProductionWorkContractFailures([receipt]), []);
});

test("production live Pi receipt gate requires model adjudication, cognition charge, and a credential read for every case", () => {
	assert.deepEqual(livePiProductionWorkContractFailures([{ caseId: "complete", workContract: productionWorkContractEvidence("test/semantic/openai-completions") }]), []);
	assert.deepEqual(livePiProductionWorkContractFailures([{ caseId: "missing", workContract: { source: "model", semanticAdjudicationValid: false, cognitionBudgetChargeTokens: 0, credentialResolverReads: 0, credentialResolutions: [] } }]), [
		"missing:semantic_adjudication_missing",
		"missing:cognition_charge_missing",
		"missing:credential_resolver_unread",
	]);
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
	const skillResult = await tools.get("skill_complete").execute("complete-call", { name: skillCandidate.name });
	assert.equal("terminate" in directResult, false);
	assert.equal("terminate" in skillResult, false);
});

test("live Pi execution metrics fail closed when token, latency, turn, or usage budgets regress", () => {
	const metrics = summarizeLivePiOutcomeReceipts([{ executionTrace: [
		{ type: "execution.started", at: 10 },
		{ type: "model.turn_settled", inputTokens: 7_000, outputTokens: 1_000, costUsd: 0 },
		{ type: "execution.settled", at: 100_010 },
	] }]);
	assert.deepEqual(livePiBudgetFailures(metrics), ["average_tokens_exceeded", "case_tokens_exceeded", "average_duration_exceeded", "case_duration_exceeded"]);
	assert.equal(metrics.costEvidence, "unpriced");
	assert.equal(metrics.totalTokens, 8_000);
	assert.equal(metrics.providerReportedTurns, 0);
	assert.equal(metrics.providerUnavailableTurns, 0);
	assert.equal(metrics.providerResponseReportingRate, 0);
});

test("live evidence verifier rejects raw diagnostics and a Tool call detached from its assistant Turn and Tool Spec", () => {
	const baseline = withValidProductionWorkContractEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
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
	const baseline = withValidProductionWorkContractEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
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

test("live evidence verifier rejects one model Tool call claimed by two assistant Turns", () => {
	const baseline = withValidProductionWorkContractEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
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

test("live evidence verifier rejects uncorrelated Work Contract credential, Provider Turn, and semantic evidence", () => {
	const source = withValidProductionWorkContractEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
	const root = mkdtempSync(join(tmpdir(), "beemax-work-contract-evidence-mutation-"));
	try {
		const mutations = [
			(receipt) => { receipt.workContract.credentialResolverReads = 0; },
			(receipt) => { receipt.workContract.providerTurns[0].inputTokens++; },
			(receipt) => { receipt.workContract.semanticAdjudication.primaryModelIdentity = "unrelated/model/api"; },
			(receipt) => { receipt.workContract.cognitionBudgetChargeTokens = 1; receipt.workContract.semanticAdjudication.cognitionBudgetChargeTokens = 1; },
		];
		for (const [index, mutate] of mutations.entries()) {
			const artifact = structuredClone(source); mutate(artifact.piOutcome.receipts[0]);
			const path = join(root, `evidence-${index}.json`); writeFileSync(path, `${JSON.stringify(artifact)}\n`, "utf8");
			const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs"), path], { encoding: "utf8" });
			assert.notEqual(result.status, 0);
			const report = JSON.parse(result.stdout);
			assert.equal(report.failures.some((failure) => failure.includes("production Work Contract composition")), true);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("live evidence verifier independently rejects every generated metric and budget mutation", () => {
	const source = withValidProductionWorkContractEvidence(JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8")));
	const root = mkdtempSync(join(tmpdir(), "beemax-live-pi-metrics-mutation-"));
	try {
		for (const section of ["metrics", "budget"]) for (const key of Object.keys(source.piOutcome[section])) {
			const mutated = structuredClone(source);
			const current = mutated.piOutcome[section][key];
			mutated.piOutcome[section][key] = typeof current === "number" ? current + 1 : current === "unpriced" ? "provider_reported" : `tampered:${String(current)}`;
			const path = join(root, `${section}-${key}.json`);
			writeFileSync(path, `${JSON.stringify(mutated)}\n`, "utf8");
			const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs"), path], { encoding: "utf8" });
			assert.notEqual(result.status, 0, `${section}.${key} mutation passed`);
			const report = JSON.parse(result.stdout);
			assert.equal(report.failures.some((failure) => failure.includes("metadata, freshness, corpus coverage, or execution budget evidence is invalid")), true, `${section}.${key} was not independently rejected`);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

function withValidProductionWorkContractEvidence(artifact) {
	const identity = `${artifact.models[0]}/openai-completions`;
	for (const receipt of artifact.piOutcome.receipts) receipt.workContract = productionWorkContractEvidence(identity);
	artifact.piOutcome.workContractFailures = [];
	return artifact;
}

function productionWorkContractEvidence(identity) {
	const provider = identity.split("/")[0];
	const cognitionUsage = { inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: [identity, identity] };
	return {
		source: "model", semanticAdjudicationValid: true, cognitionBudgetChargeTokens: 12, cognitionUsage,
		semanticAdjudication: { schemaVersion: "beemax.work-contract-adjudication.v1", inventorySchemaVersion: "beemax.semantic-inventory.v1", primaryModelIdentity: identity, reviewerModelIdentity: identity, reviewMode: "same_model_independent_samples", independentSamples: true, cognitionUsage, cognitionBudgetChargeTokens: 12 },
		credentialResolverReads: 2,
		credentialResolutions: [{ provider, modelIdentity: identity, source: "profile_auth_storage" }, { provider, modelIdentity: identity, source: "profile_auth_storage" }],
		providerTurns: [
			{ modelIdentity: identity, lane: "work_contract", providerResponseIdentitySha256: `sha256:${"a".repeat(64)}`, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
			{ modelIdentity: identity, lane: "semantic_inventory", providerResponseIdentitySha256: `sha256:${"b".repeat(64)}`, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
		],
	};
}

function testCredentialResolution(model) { return { provider: model.provider, modelIdentity: `${model.provider}/${model.id}/${model.api}`, source: "profile_auth_storage" }; }
function testProviderTurn(model, lane, digestCharacter, inputTokens, outputTokens) { return { modelIdentity: `${model.provider}/${model.id}/${model.api}`, lane, providerResponseIdentitySha256: `sha256:${digestCharacter.repeat(64)}`, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }; }

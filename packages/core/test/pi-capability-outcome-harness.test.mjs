import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createLivePiEvaluationTools, executeLivePiCapabilityTask, livePiBudgetFailures, summarizeLivePiOutcomeReceipts } from "../../../scripts/pi-capability-outcome-harness.mjs";

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
	assert.equal(receipt.verificationStatus, "rejected");
	assert.equal(receipt.executionTrace.some((event) => event.type === "tool.started"), false);
	assert.equal("piToolCalls" in receipt, false);
	assert.equal("piToolErrors" in receipt, false);
	assert.equal("toolAudit" in receipt, false);
});

test("live Pi evaluation lifecycle receipts identify the exact Tool call", async () => {
	const candidate = { kind: "skill", name: "procedure-conformance-check", version: "eval:1", confidence: 0.99 };
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
	const baseline = JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8"));
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
	const baseline = JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8"));
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
	const baseline = JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8"));
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

test("live evidence verifier independently rejects every generated metric and budget mutation", () => {
	const source = JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8"));
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

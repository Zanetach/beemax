import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { executeLivePiCapabilityTask, livePiBudgetFailures, summarizeLivePiOutcomeReceipts } from "../../../scripts/pi-capability-outcome-harness.mjs";

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

test("live Pi execution metrics fail closed when token, latency, turn, or usage budgets regress", () => {
	const metrics = summarizeLivePiOutcomeReceipts([{ executionTrace: [
		{ type: "execution.started", at: 10 },
		{ type: "model.turn_settled", inputTokens: 7_000, outputTokens: 1_000, costUsd: 0 },
		{ type: "execution.settled", at: 100_010 },
	] }]);
	assert.deepEqual(livePiBudgetFailures(metrics), ["average_tokens_exceeded", "case_tokens_exceeded", "average_duration_exceeded", "case_duration_exceeded"]);
	assert.equal(metrics.costEvidence, "unpriced");
	assert.equal(metrics.totalTokens, 8_000);
});

test("live evidence verifier rejects raw diagnostics and a Tool call detached from its published Tool Spec", () => {
	const baseline = JSON.parse(readFileSync(resolve("evals/baselines/capability-ranking-live.json"), "utf8"));
	const receipt = baseline.piOutcome.receipts.find((item) => item.executionTrace.some((event) => event.type === "tool.started"));
	receipt.piToolCalls = [{ toolName: "should_not_be_persisted", args: { secret: "redacted" } }];
	const started = receipt.executionTrace.find((event) => event.type === "tool.started");
	started.toolSpecPlanId = "tool-plan:tampered";
	const root = mkdtempSync(join(tmpdir(), "beemax-live-pi-mutation-"));
	const path = join(root, "evidence.json");
	try {
		writeFileSync(path, `${JSON.stringify(baseline)}\n`, "utf8");
		const result = spawnSync(process.execPath, [resolve("scripts/verify-live-capability-evidence.mjs"), path], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		const report = JSON.parse(result.stdout);
		assert.equal(report.passed, false);
		assert.equal(report.failures.some((failure) => failure.includes("content-free evidence shape")), true);
		assert.equal(report.failures.some((failure) => failure.includes("prior model-visible Tool Spec")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentParityCorpus } from "../../../evals/agent-parity-corpus.mjs";
import { parseBeeMaxEvidence, parseCodexEvidence, parseHermesEvidence } from "../../../evals/agent-parity-adapters.mjs";
import { createIsolatedProfile, filterExecution } from "../../../evals/adapters/beemax-cli.mjs";
import { collectFixtureEvidence, digestConfiguration, resolveValidatedPublicAddresses, runSubprocess, signFixtureAuthorityEvent } from "../../../evals/adapters/subprocess.mjs";

const research = agentParityCorpus.cases.find((scenario) => scenario.id === "current-research");

test("Codex adapter derives Tool and token evidence from JSONL events", () => {
	const stdout = [
		{ type: "thread.started", thread_id: "thread-1" },
		{ type: "item.started", item: { id: "tool-1", type: "web_search", query: "current trends" } },
		{ type: "item.completed", item: { id: "tool-1", type: "web_search", status: "completed" } },
		{ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: "source-backed result https://example.test/path?token=secret" } },
		{ type: "turn.completed", usage: { input_tokens: 120, output_tokens: 30 } },
	].map((event) => JSON.stringify(event)).join("\n");
	const result = parseCodexEvidence({ scenario: research, stdout, stderr: "", exitCode: 0, durationMs: 50 });
	assert.equal(result.status, "succeeded");
	assert.equal(result.inputTokens, 120);
	assert.equal(result.outputTokens, 30);
	assert.deepEqual(result.toolCalls.map((call) => call.name), ["web_search"]);
	assert.deepEqual(result.toolCalls[0].argumentEvidence.keys, ["query"]);
	assert.equal(result.toolCalls[0].argumentsValid, true);
	assert.match(result.toolCalls[0].argumentEvidence.sha256, /^sha256:[a-f0-9]{64}$/);
	assert.deepEqual(result.evidenceKinds, ["tool"]);
	assert.equal(result.objectiveDegraded, true);
	assert.equal(result.outcomeVerified, false);
	assert.equal(result.duplicateEffects, null);
	assert.equal(result.evidenceRefs.kind, "codex_jsonl");
	assert.equal(result.evidenceRefs.threadId, "thread-1");
	assert.deepEqual(result.evidenceRefs.sources, ["https://example.test/path"]);
	assert.match(result.evidenceRefs.sha256, /^sha256:[a-f0-9]{64}$/);
});

test("current research accepts only independent final sources bound to successful Tool receipts", () => {
	const urls = ["https://source-a.test/current", "https://source-b.test/current"];
	const stdout = [
		{ type: "item.started", item: { id: "tool", type: "web_search", query: "current" } },
		{ type: "item.completed", item: { id: "tool", type: "web_search", status: "completed", result: urls.join(" ") } },
		{ type: "item.completed", item: { id: "answer", type: "agent_message", text: `Verified ${urls.join(" ")}` } },
	].map(JSON.stringify).join("\n");
	const accepted = parseCodexEvidence({ scenario: research, stdout, stderr: "", exitCode: 0, durationMs: 1, validatedSourceRefs: urls });
	assert.equal(accepted.outcomeVerified, true);
	assert.equal(accepted.objectiveDegraded, false);
	const fabricated = parseCodexEvidence({ scenario: research, stdout: stdout.replaceAll("source-b.test", "fabricated.test").replace('result":"https://source-a.test/current https://fabricated.test/current', 'result":"https://source-a.test/current https://source-b.test/current'), stderr: "", exitCode: 0, durationMs: 1, validatedSourceRefs: urls });
	assert.equal(fabricated.outcomeVerified, false);
	assert.equal(fabricated.objectiveDegraded, true);
});

test("Hermes adapter derives Tool and token evidence from persisted Session messages", () => {
	const result = parseHermesEvidence({
		scenario: research,
		stdout: "source-backed result\n",
		stderr: "",
		exitCode: 0,
		durationMs: 60,
		session: { id: "hermes-session-1", inputTokens: 90, outputTokens: 20, endReason: "completed" },
		messages: [
			{ role: "assistant", toolCalls: JSON.stringify([{ id: "call-1", function: { name: "web_search", arguments: "{\"query\":\"current trends\"}" } }]) },
			{ role: "tool", toolCallId: "call-1", toolName: "web_search", content: "source result" },
		],
	});
	assert.equal(result.status, "succeeded");
	assert.equal(result.inputTokens, 90);
	assert.equal(result.outputTokens, 20);
	assert.deepEqual(result.toolCalls.map((call) => call.name), ["web_search"]);
	assert.deepEqual(result.toolCalls[0].argumentEvidence.keys, ["query"]);
	assert.equal(result.toolCalls[0].argumentsValid, true);
	assert.deepEqual(result.evidenceKinds, ["tool"]);
	assert.equal(result.evidenceRefs.sessionId, "hermes-session-1");
});

test("adapters retain failed Tool attempts instead of inflating successful routing evidence", () => {
	const codex = parseCodexEvidence({
		scenario: research, stderr: "", exitCode: 0, durationMs: 1,
		stdout: [
			{ type: "item.started", item: { id: "failed-search", type: "web_search", query: "current" } },
			{ type: "item.completed", item: { id: "failed-search", type: "web_search", status: "failed" } },
			{ type: "item.completed", item: { id: "answer", type: "agent_message", text: "blocked" } },
		].map(JSON.stringify).join("\n"),
	});
	assert.equal(codex.toolCalls[0].status, "failed");
	assert.deepEqual(codex.evidenceKinds, []);
	const hermes = parseHermesEvidence({
		scenario: research, stdout: "blocked", stderr: "", exitCode: 0, durationMs: 1,
		session: { id: "failed", inputTokens: 1, outputTokens: 1, endReason: "completed" },
		messages: [{ role: "assistant", toolCalls: JSON.stringify([{ id: "failed-search", function: { name: "web_search", arguments: "{not-json" } }]) }],
	});
	assert.equal(hermes.toolCalls[0].status, "started");
	assert.equal(hermes.toolCalls[0].argumentsValid, false);
	assert.deepEqual(hermes.evidenceKinds, []);
});

test("adapters do not treat completed error envelopes or anonymous calls without results as success", () => {
	const codex = parseCodexEvidence({
		scenario: research, stderr: "", exitCode: 0, durationMs: 1,
		stdout: [
			{ type: "item.started", item: { id: "search", type: "web_search", query: "current" } },
			{ type: "item.completed", item: { id: "search", type: "web_search", status: "completed", isError: true, error: "provider unavailable" } },
			{ type: "item.completed", item: { id: "answer", type: "agent_message", text: "blocked" } },
		].map(JSON.stringify).join("\n"),
	});
	assert.equal(codex.toolCalls[0].status, "failed");
	const noResult = parseHermesEvidence({
		scenario: research, stdout: "answer", stderr: "", exitCode: 0, durationMs: 1,
		session: { id: "anonymous", inputTokens: 1, outputTokens: 1, endReason: "completed" },
		messages: [{ role: "assistant", toolCalls: JSON.stringify([{ function: { name: "web_search", arguments: "{\"query\":\"current\"}" } }]) }],
	});
	assert.equal(noResult.toolCalls[0].status, "started");
	assert.deepEqual(noResult.evidenceKinds, []);
	const errorResult = parseHermesEvidence({
		scenario: research, stdout: "answer", stderr: "", exitCode: 0, durationMs: 1,
		session: { id: "error", inputTokens: 1, outputTokens: 1, endReason: "completed" },
		messages: [
			{ role: "assistant", toolCalls: JSON.stringify([{ id: "call", function: { name: "web_search", arguments: "{}" } }]) },
			{ role: "tool", toolCallId: "call", toolName: "web_search", content: JSON.stringify({ isError: true, error: "provider unavailable" }) },
		],
	});
	assert.equal(errorResult.toolCalls[0].status, "failed");
	const nestedCodex = parseCodexEvidence({
		scenario: research, stderr: "", exitCode: 0, durationMs: 1,
		stdout: [
			{ type: "item.started", item: { id: "nested", type: "web_search", query: "current" } },
			{ type: "item.completed", item: { id: "nested", type: "web_search", status: "completed", result: { details: { isError: true, message: "schema rejected" } } } },
			{ type: "item.completed", item: { id: "answer", type: "agent_message", text: "answer" } },
		].map(JSON.stringify).join("\n"),
	});
	assert.equal(nestedCodex.toolCalls[0].status, "failed");
	const arrayHermes = parseHermesEvidence({
		scenario: research, stdout: "answer", stderr: "", exitCode: 0, durationMs: 1,
		session: { id: "array-error", inputTokens: 1, outputTokens: 1, endReason: "completed" },
		messages: [
			{ role: "assistant", toolCalls: JSON.stringify([{ id: "call", function: { name: "web_search", arguments: "{}" } }]) },
			{ role: "tool", toolCallId: "call", toolName: "web_search", content: JSON.stringify([{ type: "text", text: "Error executing tool web_search: schema rejected" }]) },
		],
	});
	assert.equal(arrayHermes.toolCalls[0].status, "failed");
	let deeplyNested = { isError: true, message: "provider rejected the call" };
	for (let depth = 0; depth < 12; depth++) deeplyNested = { child: deeplyNested };
	const deepCodex = parseCodexEvidence({
		scenario: research, stderr: "", exitCode: 0, durationMs: 1,
		stdout: [
			{ type: "item.started", item: { id: "deep", type: "web_search", query: "current" } },
			{ type: "item.completed", item: { id: "deep", type: "web_search", status: "completed", result: deeplyNested } },
			{ type: "item.completed", item: { id: "answer", type: "agent_message", text: "answer" } },
		].map(JSON.stringify).join("\n"),
	});
	assert.equal(deepCodex.toolCalls[0].status, "failed");
});

test("signed fixture events still require a matching observed Tool receipt", () => {
	const scenario = agentParityCorpus.cases.find((item) => item.id === "mcp-tool");
	const fixtureEvidence = { kinds: ["source"], facts: { authorityIds: ["MCP-STATUS-READY"] }, duplicateEffects: null, refs: [{ kind: "fixture_authority", id: "MCP-STATUS-READY", eventKind: "source_read", sha256: `sha256:${"a".repeat(64)}` }] };
	const uncorrelated = parseCodexEvidence({ scenario, stdout: JSON.stringify({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "MCP-STATUS-READY" } }), stderr: "", exitCode: 0, durationMs: 1, fixtureEvidence });
	assert.equal(uncorrelated.status, "failed");
	assert.equal(uncorrelated.outcomeVerified, false);
	assert.match(uncorrelated.error, /authority correlation failed/i);
	const stdout = [
		{ type: "item.started", item: { id: "status", type: "mcp__agent_parity__status", arguments: "{}" } },
		{ type: "item.completed", item: { id: "status", type: "mcp__agent_parity__status", status: "completed" } },
		{ type: "item.completed", item: { id: "answer", type: "agent_message", text: "MCP-STATUS-READY" } },
	].map(JSON.stringify).join("\n");
	assert.equal(parseCodexEvidence({ scenario, stdout, stderr: "", exitCode: 0, durationMs: 1, fixtureEvidence }).outcomeVerified, true);
});

test("BeeMax adapter requires accepted Verification for a successful Objective", () => {
	const base = {
		scenario: research,
		stdout: "source-backed result\n",
		stderr: "",
		exitCode: 0,
		durationMs: 70,
		interactionEvents: [{ type: "turn.finished", result: { usage: { input_tokens: 80, output_tokens: 25 } } }],
		tasks: [{ id: "objective-1", parentId: null, status: "succeeded", verificationOutcome: "accepted", evidence: "source receipt" }],
		effects: [],
		executionTrace: [
			{ type: "tool.started", triggerKind: "interaction", executionId: "execution-1", toolCallId: "call-1", toolName: "web_search" },
			{ type: "tool.settled", triggerKind: "interaction", executionId: "execution-1", toolCallId: "call-1", toolName: "web_search", status: "succeeded" },
			{ type: "verification.settled", triggerKind: "interaction", executionId: "execution-1", status: "accepted" },
			{ type: "execution.settled", triggerKind: "interaction", executionId: "execution-1", status: "succeeded" },
		],
	};
	const accepted = parseBeeMaxEvidence(base);
	assert.equal(accepted.status, "succeeded");
	assert.deepEqual(accepted.toolCalls.map((call) => call.name), ["web_search"]);
	assert.deepEqual(accepted.toolCalls[0].argumentEvidence, { kind: "diagnostic_trace_correlation", reference: "execution-1:call-1" });
	assert.equal(accepted.toolCalls[0].argumentsValid, true);
	assert.deepEqual(accepted.evidenceKinds, ["tool", "source", "verification"]);
	assert.equal(accepted.duplicateEffects, 0);
	assert.equal(accepted.evidenceRefs.task.id, "objective-1");
	const unavailable = parseBeeMaxEvidence({ ...base, tasks: [{ ...base.tasks[0], status: "running", verificationOutcome: "unavailable" }] });
	assert.equal(unavailable.status, "blocked");
});

test("BeeMax adapter scores the full Objective graph but excludes verifier Tool calls", () => {
	const result = parseBeeMaxEvidence({
		scenario: research, exitCode: 0, durationMs: 20, stderr: "",
		interactionEvents: [{ type: "turn.finished", turnId: "turn-graph", result: { usage: { input_tokens: 9, output_tokens: 3 } } }],
		tasks: [{ id: "objective-graph", parentId: null, status: "succeeded", verificationOutcome: "accepted", evidence: "source receipt" }],
		effects: [],
		executionTrace: [
			{ type: "model.turn_settled", triggerKind: "interaction", inputTokens: 100, outputTokens: 20 },
			{ type: "model.turn_settled", triggerKind: "delegation", inputTokens: 200, outputTokens: 40 },
			{ type: "model.turn_settled", triggerKind: "verification", inputTokens: 50, outputTokens: 10 },
			{ type: "tool.started", triggerKind: "interaction", toolCallId: "spawn", toolName: "task_spawn" },
			{ type: "tool.settled", triggerKind: "interaction", toolCallId: "spawn", toolName: "task_spawn", status: "succeeded" },
			{ type: "tool.started", triggerKind: "delegation", toolCallId: "search", toolName: "web_search" },
			{ type: "tool.settled", triggerKind: "delegation", toolCallId: "search", toolName: "web_search", status: "succeeded" },
			{ type: "tool.started", triggerKind: "verification", toolCallId: "verify-search", toolName: "web_search" },
			{ type: "tool.settled", triggerKind: "verification", toolCallId: "verify-search", toolName: "web_search", status: "succeeded" },
			{ type: "verification.settled", triggerKind: "interaction", status: "accepted" },
			{ type: "execution.settled", triggerKind: "interaction", executionId: "execution-graph", status: "succeeded" },
		],
	});
	assert.deepEqual(result.toolCalls.map((call) => call.rawName), ["task_spawn", "web_search"]);
	assert.equal(result.toolCalls.filter((call) => call.name === "web_search").length, 1);
	assert.equal(result.status, "succeeded");
	assert.equal(result.inputTokens, 350);
	assert.equal(result.outputTokens, 70);
});

test("BeeMax evidence keys Tool attempts by execution and includes direct Objective verifier tokens", () => {
	const objectiveId = "objective-1";
	const trace = [
		{ type: "execution.started", at: 10, triggerKind: "interaction", executionId: "main", objectiveId, taskId: objectiveId },
		{ type: "tool.started", at: 11, triggerKind: "interaction", executionId: "main", objectiveId, taskId: objectiveId, toolCallId: "call-1", toolName: "web_search" },
		{ type: "tool.settled", at: 12, triggerKind: "interaction", executionId: "main", objectiveId, taskId: objectiveId, toolCallId: "call-1", toolName: "web_search", status: "failed" },
		{ type: "tool.started", at: 13, triggerKind: "delegation", executionId: "child", objectiveId, taskId: "child-task", toolCallId: "call-1", toolName: "web_search" },
		{ type: "tool.settled", at: 14, triggerKind: "delegation", executionId: "child", objectiveId, taskId: "child-task", toolCallId: "call-1", toolName: "web_search", status: "succeeded" },
		{ type: "model.turn_settled", at: 15, triggerKind: "verification", executionId: "verify", taskId: objectiveId, inputTokens: 7, outputTokens: 3 },
	];
	const filtered = filterExecution(trace, 10);
	assert.equal(filtered.length, trace.length);
	const result = parseBeeMaxEvidence({
		scenario: research, stdout: "", stderr: "", exitCode: 0, durationMs: 1,
		interactionEvents: [], executionTrace: filtered,
		tasks: [{ id: objectiveId, parentId: null, status: "running", verificationOutcome: "unavailable" }], effects: [],
	});
	assert.deepEqual(result.toolCalls.map(({ status, argumentEvidence }) => [status, argumentEvidence.reference]), [["failed", "main:call-1"], ["succeeded", "child:call-1"]]);
	assert.equal(result.inputTokens, 7);
	assert.equal(result.outputTokens, 3);
});

test("BeeMax parity profiles copy only configuration and credentials into fresh per-case state", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-parity-profile-test-"));
	const sourceHome = join(root, "source-home");
	const sourceRoot = join(sourceHome, "profiles", "source");
	const workspace = join(root, "workspace");
	await mkdir(join(sourceRoot, "state"), { recursive: true });
	await mkdir(join(sourceRoot, "logs"), { recursive: true });
	await mkdir(workspace, { recursive: true });
	await Promise.all([
		writeFile(join(sourceRoot, "config.yaml"), "model:\n  provider: custom\npaths:\n  cwd: workspace\n"),
		writeFile(join(sourceRoot, ".env"), "BEEMAX_API_KEY=fixture-secret\n"),
		writeFile(join(sourceRoot, "SOUL.md"), "fixture soul"),
		writeFile(join(sourceRoot, "USER.md"), "fixture user"),
		writeFile(join(sourceRoot, "auth.json"), "{}"),
		writeFile(join(sourceRoot, "memory.db"), "must-not-copy"),
		writeFile(join(sourceRoot, "logs", "execution-trace.jsonl"), "must-not-copy"),
		writeFile(join(sourceRoot, "state", "credential-vault.key"), "fixture-key"),
	]);
	const isolated = await createIsolatedProfile({ sourceHome, sourceProfile: "source", workspace, system: { model: "fixture-model" }, provider: "custom", fixtureRoot: new URL("../../../evals/fixtures/agent-parity", import.meta.url).pathname });
	try {
		assert.equal(await readFile(join(isolated.profileRoot, "auth.json"), "utf8"), "{}");
		assert.equal(await readFile(join(isolated.profileRoot, "state", "credential-vault.key"), "utf8"), "fixture-key");
		assert.match(await readFile(join(isolated.profileRoot, ".env"), "utf8"), /BEEMAX_MODEL="fixture-model"/);
		assert.ok((await readFile(join(isolated.profileRoot, ".env"), "utf8")).includes(`BEEMAX_CWD=${JSON.stringify(workspace)}`));
		await assert.rejects(readFile(join(isolated.profileRoot, "memory.db")), /ENOENT/);
		await assert.rejects(readFile(join(isolated.profileRoot, "logs", "execution-trace.jsonl")), /ENOENT/);
		assert.match(await readFile(join(isolated.profileRoot, "skills", "evaluation-research", "SKILL.md"), "utf8"), /evaluation/i);
	} finally {
		await isolated.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("fixture evidence derives duplicate Effects from a separate append-only authority", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-parity-fixture-test-"));
	const authority = await mkdtemp(join(tmpdir(), "beemax-parity-authority-test-"));
	const receiptKey = "test-receipt-key-which-is-at-least-32-bytes";
	try {
		const events = [
			{ kind: "effect_attempted", id: "attempt-1", idempotencyKey: "fixture-effect-1" },
			{ kind: "effect_attempted", id: "attempt-2", idempotencyKey: "fixture-effect-1" },
			{ kind: "effect_committed", id: "EFFECT-COMMITTED-1", idempotencyKey: "fixture-effect-1" },
			{ kind: "effect_reconciled", id: "reconcile-1", idempotencyKey: "fixture-effect-1" },
		];
		await writeFile(join(authority, "fixture-authority.jsonl"), `${events.map((event) => JSON.stringify(signFixtureAuthorityEvent(event, receiptKey))).join("\n")}\n`);
		const evidence = await collectFixtureEvidence(root, authority, receiptKey);
		assert.equal(evidence.duplicateEffects, 0);
		assert.deepEqual(evidence.facts, { effectAttemptCount: 2, effectCommitCount: 1, effectReconcileCount: 1, authorityIds: events.map((event) => event.id) });
		await writeFile(join(authority, "fixture-authority.jsonl"), `${[...events, { kind: "effect_committed", id: "duplicate", idempotencyKey: "fixture-effect-1" }].map((event) => JSON.stringify(signFixtureAuthorityEvent(event, receiptKey))).join("\n")}\n`);
		assert.equal((await collectFixtureEvidence(root, authority, receiptKey)).duplicateEffects, 1);
		await writeFile(join(authority, "fixture-authority.jsonl"), `${JSON.stringify({ ...events[0], mac: "00".repeat(32) })}\n`);
		await assert.rejects(collectFixtureEvidence(root, authority, receiptKey), /unauthenticated/);
	} finally {
		await Promise.all([rm(root, { recursive: true, force: true }), rm(authority, { recursive: true, force: true })]);
	}
});

test("public address resolution falls back from fake-IP DNS without relaxing public-address checks", async () => {
	let requestedUrl;
	const addresses = await resolveValidatedPublicAddresses("example.com", {
		lookup: async () => [{ address: "198.18.0.80", family: 4 }],
		fetch: async (url) => {
			requestedUrl = String(url);
			return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }), { status: 200 });
		},
	});
	assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
	assert.match(requestedUrl, /^https:\/\/cloudflare-dns\.com\/dns-query\?/);
	assert.match(requestedUrl, /name=example\.com/);
});

test("public address resolution rejects non-public DoH answers", async () => {
	await assert.rejects(resolveValidatedPublicAddresses("internal.example", {
		lookup: async () => [{ address: "198.18.0.81", family: 4 }],
		fetch: async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "127.0.0.1" }] }), { status: 200 }),
	}), /non-public/);
});

test("configuration digests resolve multiple paths without leaking Array.map callback arguments", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-parity-config-digest-"));
	try {
		await Promise.all([writeFile(join(root, "a"), "one"), writeFile(join(root, "b"), "two")]);
		assert.match(await digestConfiguration([join(root, "a"), join(root, "b")]), /^sha256:[a-f0-9]{64}$/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("subprocess timeout escalates to the process group and preserves partial output", async () => {
	const controller = new AbortController();
	const startedAt = performance.now();
	const running = runSubprocess(process.execPath, [new URL("./fixtures/stubborn-subprocess.mjs", import.meta.url).pathname], { signal: controller.signal });
	setTimeout(() => controller.abort(new Error("test timeout")), 50);
	const result = await running;
	assert.ok(performance.now() - startedAt < 4_000);
	assert.equal(result.signal, "SIGKILL");
	assert.match(result.stdout, /partial-evidence/);
});

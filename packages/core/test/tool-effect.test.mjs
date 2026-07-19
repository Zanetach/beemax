import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createExecutionEnvelope, FileExecutionTraceStore, FileToolEffectJournal, MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY } from "../dist/index.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("effect journal records a content-free mutation lifecycle and committed receipt", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-"));
	try {
		const path = join(root, "tool-effects.jsonl");
		const effects = new FileToolEffectJournal(path);
		const id = effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "write", args: { idempotencyKey: "report-v1" }, policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" } });
		assert.ok(id);
		effects.finish({ source, toolCallId: "call-1", toolName: "write", policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" }, isError: false, details: { beemaxEffect: { operation: "write report", externalRef: "workspace:report.md", idempotencyKey: "report-v1" } } });
		const records = effects.events();
		assert.deepEqual(records.map((record) => record.status), ["planned", "executing", "committed"]);
		assert.deepEqual(records.at(-1).receipt, { status: "committed", occurredAt: records.at(-1).at, operation: "write report", externalRef: "workspace:report.md", idempotencyKey: "report-v1" });
		assert.equal(records.every((record) => record.taskId === "turn-1" && record.toolCallId === "call-1"), true);
		assert.doesNotMatch(JSON.stringify(records), /args|result|content|secret/);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		const restored = new FileToolEffectJournal(path);
		assert.throws(() => restored.begin({ source, taskId: "turn-2", toolCallId: "call-2", toolName: "write", args: { idempotencyKey: "report-v1" }, policy: MUTATING_TOOL_POLICY }), /already committed/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("an attested local mutation can commit even when its independent postcondition rejects", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-postcondition-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		const policy = { ...MUTATING_TOOL_POLICY, sideEffect: "local", effectProofProvider: "beemax-artifact-runtime" };
		const id = effects.begin({ source, taskId: "turn:artifact", toolCallId: "call:artifact", toolName: "artifact_render", policy });
		effects.finish({
			source, toolCallId: "call:artifact", toolName: "artifact_render", policy, isError: true,
			details: { beemaxEffect: { operation: "render workspace Artifact", externalRef: "workspace:report.pdf", proof: { provider: "beemax-artifact-runtime", resourceType: "workspace-artifact", resourceId: "report.pdf" } } },
		});
		assert.equal(effects.effect(id).status, "committed");
		assert.equal(effects.effect(id).receipt.externalRef, "workspace:report.pdf");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a local mutation error without matching attested proof remains unknown", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-unproven-postcondition-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		const policy = { ...MUTATING_TOOL_POLICY, sideEffect: "local", effectProofProvider: "beemax-artifact-runtime" };
		const id = effects.begin({ source, taskId: "turn:artifact", toolCallId: "call:artifact", toolName: "artifact_render", policy });
		effects.finish({ source, toolCallId: "call:artifact", toolName: "artifact_render", policy, isError: true, details: { beemaxEffect: { proof: { provider: "untrusted", resourceType: "workspace-artifact", resourceId: "report.pdf" } } } });
		assert.equal(effects.effect(id).status, "unknown");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Effect authority projects its lifecycle into the bound Execution Trace", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-trace-"));
	try {
		const trace = new FileExecutionTraceStore(join(root, "execution-trace.jsonl"));
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"), 5_000, trace);
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:effect", trigger: { kind: "task_transition" }, taskId: "task:effect", taskRunId: "run:effect", mode: "normal" });
		const effectId = effects.begin({ source, executionEnvelope, taskId: "task:effect", toolCallId: "call:effect", toolName: "write", policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" } });
		effects.finish({ source, executionEnvelope, toolCallId: "call:effect", toolName: "write", policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" }, isError: false });
		const interruptedId = effects.begin({ source, executionEnvelope, taskId: "task:effect", toolCallId: "call:interrupted", toolName: "external_write", policy: MUTATING_TOOL_POLICY });
		assert.equal(effects.unresolvedTaskEffects({ ownerKey: "cli:local:local", taskIds: ["task:effect"] }), 1);
		assert.equal(effects.interruptTask("task:effect"), 1);
		assert.equal(effects.unresolvedTaskEffects({ ownerKey: "cli:local:local", taskIds: ["task:effect"] }), 1, "an unknown interrupted Effect remains unresolved");
		assert.equal(effects.reconcile(interruptedId, { status: "failed", operation: "cancelled before commit" }), true);
		assert.equal(effects.unresolvedTaskEffects({ ownerKey: "cli:local:local", taskIds: ["task:effect"] }), 0);
		const execution = trace.trace({ executionId: "execution:effect" });
		assert.equal(execution.effects, 2);
		assert.equal(execution.unknownEffects, 1);
		assert.deepEqual(execution.events.map(({ type, effectId: id, status }) => ({ type, effectId: id, status })), [
			{ type: "effect.started", effectId, status: "executing" },
			{ type: "effect.settled", effectId, status: "committed" },
			{ type: "effect.started", effectId: interruptedId, status: "executing" },
			{ type: "effect.settled", effectId: interruptedId, status: "unknown" },
			{ type: "effect.settled", effectId: interruptedId, status: "failed" },
		]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("durable mutations bind to their Task Run and expose only an authority projection", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-task-run-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:send", trigger: { kind: "task_transition" }, taskId: "task:send", taskRunId: "run:send", mode: "normal" });
		const effectId = effects.begin({ source, executionEnvelope, taskId: "wrong-task", toolCallId: "call:send", toolName: "write", args: { idempotencyKey: "send-v1" }, policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" } });
		effects.finish({ source, executionEnvelope, toolCallId: "call:send", toolName: "write", policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" }, isError: false });
		assert.deepEqual(effects.taskProjection({ ownerKey: "cli:local:local", taskId: "task:send" }), [{
			id: effectId, taskRunId: "run:send", tool: "write", status: "committed", occurredAt: effects.effect(effectId).at,
			operation: "write", idempotencyKey: "send-v1",
		}]);
		assert.deepEqual(effects.taskProjection({ ownerKey: "other", taskId: "task:send" }), []);
		assert.equal(effects.effect(effectId).taskId, "task:send");
		assert.equal(effects.effect(effectId).taskRunId, "run:send");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Task Effect projection isolates its query from unrelated historical authority rows", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-indexed-projection-"));
	try {
		const path = join(root, "tool-effects.jsonl");
		const effects = new FileToolEffectJournal(path);
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:target", trigger: { kind: "task_transition" }, taskId: "task:target", taskRunId: "run:target", mode: "normal" });
		effects.begin({ source, executionEnvelope, toolCallId: "call:target", toolName: "write", policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" } });
		effects.finish({ source, executionEnvelope, toolCallId: "call:target", toolName: "write", policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" }, isError: false });
		const db = new Database(`${path}.authority.sqlite`);
		db.prepare("INSERT INTO tool_effects(id,status,updated_at,record_json,holder_pid,owner_key,task_id,task_run_id) VALUES (?,?,?,?,?,?,?,?)").run("unrelated", "committed", 1, "{corrupt-unrelated", null, "other", "task:other", "run:other");
		db.close();
		assert.equal(effects.taskProjection({ ownerKey: "cli:local:local", taskId: "task:target" }).length, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("durable mutation identity requires a Task Run", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-task-run-required-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:task-only", trigger: { kind: "task_transition" }, taskId: "task:only", mode: "normal" });
		assert.throws(() => effects.begin({ source, executionEnvelope, toolCallId: "call:only", toolName: "write", policy: MUTATING_TOOL_POLICY }), /Task Run/);
		assert.deepEqual(effects.events(), []);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("effect ledger marks active mutations unknown on runtime close", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-recovery-"));
	try {
		const path = join(root, "tool-effects.jsonl");
		const first = new FileToolEffectJournal(path);
		first.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "external_write", policy: MUTATING_TOOL_POLICY });
		first.close();
		const recovered = new FileToolEffectJournal(path).events();
		assert.deepEqual(recovered.map((record) => record.status), ["planned", "executing", "unknown"]);
		assert.equal(recovered.at(-1).receipt, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("effect ledger recovers a mutation abandoned by a crashed process", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-crash-"));
	try {
		const path = join(root, "tool-effects.jsonl");
		const runtimeUrl = new URL("../dist/index.js", import.meta.url).href;
		const script = `import { FileToolEffectJournal, MUTATING_TOOL_POLICY } from ${JSON.stringify(runtimeUrl)};
			const effects = new FileToolEffectJournal(${JSON.stringify(path)});
			effects.begin({ source: ${JSON.stringify(source)}, taskId: "turn-1", toolCallId: "call-1", toolName: "external_write", args: { idempotencyKey: "crashed-effect" }, policy: MUTATING_TOOL_POLICY });
			process.exit(0);`;
		const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
		assert.equal(child.status, 0, child.stderr);
		const recovered = new FileToolEffectJournal(path);
		assert.equal(recovered.events().at(-1).status, "unknown");
		assert.throws(() => recovered.begin({ source, taskId: "turn-2", toolCallId: "call-2", toolName: "external_write", args: { idempotencyKey: "crashed-effect" }, policy: MUTATING_TOOL_POLICY }), /unresolved/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("turn cleanup marks a mutation unknown when Pi aborts after approval but before execution", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-abort-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "external_write", policy: MUTATING_TOOL_POLICY });
		assert.equal(effects.interruptTask("turn-1"), 1);
		assert.equal(effects.events().at(-1).status, "unknown");
		assert.equal(effects.interruptTask("turn-1"), 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown effects require explicit reconciliation before an idempotent retry", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-reconcile-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		const id = effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "external_write", args: { idempotencyKey: "customer-42-update" }, policy: MUTATING_TOOL_POLICY });
		effects.interruptTask("turn-1");
		assert.throws(() => effects.begin({ source, taskId: "turn-2", toolCallId: "call-2", toolName: "external_write", args: { idempotencyKey: "customer-42-update" }, policy: MUTATING_TOOL_POLICY }), /unresolved/);
		assert.equal(effects.reconcile(id, { status: "failed" }), true);
		assert.ok(effects.begin({ source, taskId: "turn-2", toolCallId: "call-2", toolName: "external_write", args: { idempotencyKey: "customer-42-update" }, policy: MUTATING_TOOL_POLICY }));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("idempotency keys are isolated by conversation owner scope", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-scope-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		const localPolicy = { ...MUTATING_TOOL_POLICY, sideEffect: "local" };
		effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "write", args: { idempotencyKey: "daily-report" }, policy: localPolicy });
		effects.finish({ source, toolCallId: "call-1", toolName: "write", policy: localPolicy, isError: false });
		const otherUser = { ...source, userId: "user-2" };
		assert.ok(effects.begin({ source: otherUser, taskId: "turn-2", toolCallId: "call-2", toolName: "write", args: { idempotencyKey: "daily-report" }, policy: localPolicy }));
		const otherThread = { ...source, threadId: "thread-2", chatType: "thread" };
		assert.throws(() => effects.begin({ source: otherThread, taskId: "turn-3", toolCallId: "call-3", toolName: "write", args: { idempotencyKey: "daily-report" }, policy: localPolicy }), /already committed/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("separate runtime instances atomically reject the same idempotent effect", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-concurrent-"));
	try {
		const path = join(root, "tool-effects.jsonl");
		const first = new FileToolEffectJournal(path);
		const second = new FileToolEffectJournal(path);
		first.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "write", args: { idempotencyKey: "one-effect" }, policy: MUTATING_TOOL_POLICY });
		assert.throws(() => second.begin({ source, taskId: "turn-2", toolCallId: "call-2", toolName: "write", args: { idempotencyKey: "one-effect" }, policy: MUTATING_TOOL_POLICY }), /unresolved/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("external mutation remains unknown without a provider receipt", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-proof-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "external_write", args: { idempotencyKey: "external-1" }, policy: MUTATING_TOOL_POLICY });
		effects.finish({ source, toolCallId: "call-1", toolName: "external_write", policy: MUTATING_TOOL_POLICY, isError: false });
		assert.equal(effects.events().at(-1).status, "unknown");
		assert.equal(effects.events().at(-1).receipt, undefined);
		assert.throws(() => effects.begin({ source, taskId: "turn-2", toolCallId: "call-2", toolName: "external_write", args: { idempotencyKey: "external-1" }, policy: MUTATING_TOOL_POLICY }), /unresolved/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Tool timeout leaves an external mutation unknown", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-timeout-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		effects.begin({ source, taskId: "turn-timeout", toolCallId: "call-timeout", toolName: "external_write", args: { idempotencyKey: "timeout-v1" }, policy: MUTATING_TOOL_POLICY });
		effects.finish({ source, toolCallId: "call-timeout", toolName: "external_write", policy: MUTATING_TOOL_POLICY, isError: true });
		assert.equal(effects.events().at(-1).status, "unknown");
		assert.throws(() => effects.begin({ source, taskId: "retry", toolCallId: "retry", toolName: "external_write", args: { idempotencyKey: "timeout-v1" }, policy: MUTATING_TOOL_POLICY }), /unresolved/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("damaged JSONL projection cannot erase committed Effect authority", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-projection-damage-"));
	try {
		const path = join(root, "tool-effects.jsonl");
		const effects = new FileToolEffectJournal(path);
		effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "write", args: { idempotencyKey: "durable-v1" }, policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" } });
		effects.finish({ source, toolCallId: "call-1", toolName: "write", policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" }, isError: false });
		effects.close();
		writeFileSync(path, "{damaged projection\n", "utf8");
		const restored = new FileToolEffectJournal(path);
		assert.throws(() => restored.begin({ source, taskId: "retry", toolCallId: "retry", toolName: "write", args: { idempotencyKey: "durable-v1" }, policy: MUTATING_TOOL_POLICY }), /already committed/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("credential-bearing Effect metadata is omitted from authority and projections", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-credential-redaction-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:safe", trigger: { kind: "task_transition" }, taskId: "task:safe", taskRunId: "run:safe", mode: "normal" });
		const id = effects.begin({ source, executionEnvelope, toolCallId: "call:safe", toolName: "write", args: { idempotencyKey: "Bearer abcdefghijklmnopqrstuvwxyz" }, policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" } });
		effects.finish({ source, executionEnvelope, toolCallId: "call:safe", toolName: "write", policy: { ...MUTATING_TOOL_POLICY, sideEffect: "local" }, isError: false, details: { beemaxEffect: { operation: "Bearer abcdefghijklmnopqrstuvwxyz", externalRef: "secret=abcdefghijklmnop" } } });
		assert.doesNotMatch(JSON.stringify(effects.effect(id)), /Bearer|abcdefghijklmnop/);
		assert.doesNotMatch(JSON.stringify(effects.taskProjection({ ownerKey: "cli:local:local", taskId: "task:safe" })), /Bearer|abcdefghijklmnop/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("external mutation commits only with a structured provider proof", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-provider-proof-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		const feishuPolicy = { ...MUTATING_TOOL_POLICY, effectProofProvider: "feishu-vc" };
		effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "feishu_create", args: { idempotencyKey: "reserve-1" }, policy: feishuPolicy });
		effects.finish({ source, toolCallId: "call-1", toolName: "feishu_create", policy: feishuPolicy, isError: false, details: { beemaxEffect: { operation: "create meeting reservation", externalRef: "feishu-vc:meeting-reservation:reserve-42", proof: { provider: "feishu-vc", resourceType: "meeting-reservation", resourceId: "reserve-42" } } } });
		assert.deepEqual(effects.events().at(-1).receipt?.proof, { provider: "feishu-vc", resourceType: "meeting-reservation", resourceId: "reserve-42" });
		assert.equal(effects.events().at(-1).status, "committed");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Compensation creates a new linked Effect without rewriting the committed Effect", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-compensation-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		const policy = { ...MUTATING_TOOL_POLICY, risk: "low", reversible: true, effectProofProvider: "provider-a" };
		const forwardEnvelope = createExecutionEnvelope({ executionId: "execution:forward", trigger: { kind: "enterprise_event" }, taskId: "task:forward", taskRunId: "run:forward", mode: "normal" });
		const forwardId = effects.begin({ source, executionEnvelope: forwardEnvelope, toolCallId: "call:forward", toolName: "external_update", args: { idempotencyKey: "forward:1" }, policy });
		effects.finish({ source, executionEnvelope: forwardEnvelope, toolCallId: "call:forward", toolName: "external_update", policy, isError: false, details: { beemaxEffect: { operation: "update resource", externalRef: "provider-a:item:1", proof: { provider: "provider-a", resourceType: "item", resourceId: "1" } } } });

		const compensationEnvelope = createExecutionEnvelope({ executionId: "execution:compensation", trigger: { kind: "compensation" }, taskId: "task:compensation", taskRunId: "run:compensation", compensatesEffectId: forwardId, mode: "normal" });
		const compensationId = effects.begin({ source, executionEnvelope: compensationEnvelope, toolCallId: "call:compensate", toolName: "external_restore", args: { idempotencyKey: "compensate:1" }, policy });
		effects.finish({ source, executionEnvelope: compensationEnvelope, toolCallId: "call:compensate", toolName: "external_restore", policy, isError: false, details: { beemaxEffect: { operation: "restore resource", externalRef: "provider-a:item:1", proof: { provider: "provider-a", resourceType: "item", resourceId: "1" } } } });

		assert.equal(effects.effect(forwardId).status, "committed");
		assert.equal(effects.effect(forwardId).compensatesEffectId, undefined);
		assert.equal(effects.effect(compensationId).status, "committed");
		assert.equal(effects.effect(compensationId).compensatesEffectId, forwardId);
		assert.throws(() => effects.begin({ source, executionEnvelope: { ...compensationEnvelope, executionId: "execution:duplicate", taskRunId: "run:duplicate" }, toolCallId: "call:duplicate", toolName: "external_restore", policy }), /already compensated|compensation.*unresolved/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("untrusted external tools cannot self-certify with proof-shaped details", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-untrusted-proof-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "dynamic_tool", policy: MUTATING_TOOL_POLICY });
		effects.finish({ source, toolCallId: "call-1", toolName: "dynamic_tool", policy: MUTATING_TOOL_POLICY, isError: false, details: { beemaxEffect: { operation: "claim success", externalRef: "fake:item:1", proof: { provider: "fake", resourceType: "item", resourceId: "1" } } } });
		assert.equal(effects.events().at(-1).status, "unknown");
		assert.equal(effects.events().at(-1).receipt, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("committed idempotency survives bounded audit compaction", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-compaction-"));
	try {
		const path = join(root, "tool-effects.jsonl");
		const effects = new FileToolEffectJournal(path, 100);
		const localPolicy = { ...MUTATING_TOOL_POLICY, sideEffect: "local" };
		let firstId;
		for (let index = 0; index < 60; index++) {
			const toolCallId = `call-${index}`;
			const id = effects.begin({ source, taskId: `turn-${index}`, toolCallId, toolName: "write", args: { idempotencyKey: `write-${index}` }, policy: localPolicy });
			if (index === 0) firstId = id;
			effects.finish({ source, toolCallId, toolName: "write", policy: localPolicy, isError: false });
		}
		const restored = new FileToolEffectJournal(path, 100);
		assert.throws(() => restored.begin({ source, taskId: "retry", toolCallId: "retry", toolName: "write", args: { idempotencyKey: "write-0" }, policy: localPolicy }), /already committed/);
		const firstCommitted = restored.effect(firstId);
		assert.deepEqual(firstCommitted?.receipt, {
			status: "committed",
			occurredAt: firstCommitted.at,
			operation: "write",
			idempotencyKey: "write-0",
		});
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy replay authority migrates without reopening committed effects", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-legacy-"));
	try {
		const path = join(root, "tool-effects.jsonl");
		const db = new Database(`${path}.authority.sqlite`);
		db.exec("CREATE TABLE tool_effect_authority(identity TEXT PRIMARY KEY,effect_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,updated_at INTEGER NOT NULL)");
		db.prepare("INSERT INTO tool_effect_authority VALUES (?,?,?,?)").run(JSON.stringify(["cli:local:local", "legacy-key"]), "legacy-effect", "committed", 1);
		db.close();
		const effects = new FileToolEffectJournal(path);
		assert.throws(() => effects.begin({ source, taskId: "retry", toolCallId: "retry", toolName: "write", args: { idempotencyKey: "legacy-key" }, policy: MUTATING_TOOL_POLICY }), /already committed/);
		assert.equal(effects.effect("legacy-effect")?.status, "committed");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("read-only tools do not create side-effect records", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-read-"));
	try {
		const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
		assert.equal(effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "read", policy: READ_ONLY_TOOL_POLICY }), undefined);
		assert.deepEqual(effects.events(), []);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAccessScopeRef, createExecutionEnvelope, FileExecutionTraceStore } from "../dist/index.js";

test("Execution Trace correlates content-free lifecycle events and derives one execution summary", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-execution-trace-"));
	try {
		const store = new FileExecutionTraceStore(join(root, "trace.jsonl"));
		const accessScopeRef = createAccessScopeRef({ id: "scope:ops", authority: { kind: "enterprise_system", reference: "iam:ops" }, issuedAt: 1 });
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:run-7", trigger: { kind: "recovery", id: "event-4" }, objectiveId: "objective-2", taskId: "task-3", taskRunId: "run-7", accessScopeRef, mode: "recovery" });
		store.record({ type: "execution.started", executionEnvelope, at: 100 });
		store.record({ type: "model.turn_settled", executionEnvelope, at: 120, inputTokens: 30, outputTokens: 10, costUsd: 0.02 });
		store.record({ type: "tool.settled", executionEnvelope, at: 140, toolCallId: "call-1", toolName: "read", status: "succeeded", durationMs: 15 });
		store.record({ type: "execution.settled", executionEnvelope, at: 160, status: "succeeded" });

		assert.equal(store.trace({ executionId: "execution:run-7" }), undefined);
		assert.equal(store.trace({ executionId: "execution:run-7", accessScopeId: "scope:other" }), undefined);
		assert.deepEqual(store.trace({ executionId: "execution:run-7", accessScopeId: "scope:ops" }), {
			executionId: "execution:run-7", objectiveId: "objective-2", taskId: "task-3", taskRunId: "run-7", accessScopeId: "scope:ops",
			triggerKind: "recovery", mode: "recovery", status: "succeeded", startedAt: 100, settledAt: 160, durationMs: 60,
			modelTurns: 1, toolCalls: 1, effects: 0, unknownEffects: 0, checkpoints: 0, verifications: 0, deliveries: 0, inputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02,
			events: [
				{ sequence: 1, type: "execution.started", executionId: "execution:run-7", objectiveId: "objective-2", taskId: "task-3", taskRunId: "run-7", accessScopeId: "scope:ops", triggerKind: "recovery", mode: "recovery", at: 100 },
				{ sequence: 2, type: "model.turn_settled", executionId: "execution:run-7", objectiveId: "objective-2", taskId: "task-3", taskRunId: "run-7", accessScopeId: "scope:ops", triggerKind: "recovery", mode: "recovery", at: 120, inputTokens: 30, outputTokens: 10, costUsd: 0.02 },
				{ sequence: 3, type: "tool.settled", executionId: "execution:run-7", objectiveId: "objective-2", taskId: "task-3", taskRunId: "run-7", accessScopeId: "scope:ops", triggerKind: "recovery", mode: "recovery", at: 140, toolCallId: "call-1", toolName: "read", status: "succeeded", durationMs: 15 },
				{ sequence: 4, type: "execution.settled", executionId: "execution:run-7", objectiveId: "objective-2", taskId: "task-3", taskRunId: "run-7", accessScopeId: "scope:ops", triggerKind: "recovery", mode: "recovery", at: 160, status: "succeeded" },
			],
		});
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Execution Trace refuses credential-bearing operational identifiers", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-execution-trace-secret-"));
	try {
		const store = new FileExecutionTraceStore(join(root, "trace.jsonl"));
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:safe", trigger: { kind: "interaction" }, mode: "normal" });
		assert.throws(() => store.record({ type: "tool.started", executionEnvelope, at: 1, toolCallId: "call-1", toolName: "Authorization: Bearer trace-secret" }), /credential/i);
		assert.equal(store.trace({ executionId: "execution:safe" }), undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Execution Trace keeps sequence tracking bounded and safely rebuilds an evicted trace", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-execution-trace-bounded-"));
	try {
		const store = new FileExecutionTraceStore(join(root, "trace.jsonl"), 100);
		const first = createExecutionEnvelope({ executionId: "execution:first", trigger: { kind: "interaction" }, mode: "normal" });
		store.record({ type: "execution.started", executionEnvelope: first, at: 1 });
		for (let index = 0; index < 150; index++) {
			const executionEnvelope = createExecutionEnvelope({ executionId: `execution:${index}`, trigger: { kind: "interaction" }, mode: "normal" });
			store.record({ type: "execution.started", executionEnvelope, at: index + 2 });
		}
		store.record({ type: "execution.settled", executionEnvelope: first, at: 200, status: "succeeded" });
		assert.deepEqual(store.trace({ executionId: "execution:first" })?.events.map((event) => event.sequence), [1]);
		assert.ok(store.sequenceCacheSize <= 100);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

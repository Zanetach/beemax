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
			modelTurns: 1, toolCalls: 1, effects: 0, unknownEffects: 0, checkpoints: 0, verifications: 0, deliveries: 0, capabilityDecisions: 0, inputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02,
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

test("Execution Trace correlates a content-free Capability decision with its verified task outcome", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-capability-outcome-trace-"));
	try {
		const store = new FileExecutionTraceStore(join(root, "trace.jsonl"));
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:capability", trigger: { kind: "interaction" }, objectiveId: "objective:capability", mode: "normal" });
		store.record({ type: "execution.started", executionEnvelope, at: 1 });
		store.record({ type: "capability.decision", executionEnvelope, at: 2, cognitionId: "cap:decision-1", candidates: [{ kind: "tool", name: "web_search", confidence: 0.93 }] });
		store.record({ type: "capability.downstream_execution_outcome", executionEnvelope, at: 9, cognitionId: "cap:decision-1", status: "accepted" });
		store.record({ type: "execution.settled", executionEnvelope, at: 10, status: "succeeded" });
		const trace = store.trace({ executionId: "execution:capability" });
		assert.equal(trace.capabilityDecisions, 1);
		assert.equal(trace.capabilityDownstreamOutcomeStatus, "accepted");
		assert.deepEqual(trace.events.slice(1, 3), [
			{ sequence: 2, type: "capability.decision", executionId: "execution:capability", objectiveId: "objective:capability", triggerKind: "interaction", mode: "normal", at: 2, cognitionId: "cap:decision-1", candidates: [{ kind: "tool", name: "web_search", confidence: 0.93 }] },
			{ sequence: 3, type: "capability.downstream_execution_outcome", executionId: "execution:capability", objectiveId: "objective:capability", triggerKind: "interaction", mode: "normal", at: 9, cognitionId: "cap:decision-1", status: "accepted" },
		]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Execution Trace binds a settled Tool to one Tool Spec plan and one immutable Capability receipt", () => {
	const directory = mkdtempSync(join(tmpdir(), "beemax-trace-capability-receipt-"));
	try {
		const store = new FileExecutionTraceStore(join(directory, "trace.jsonl"));
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:receipt", trigger: { kind: "interaction" }, accessScopeRef: createAccessScopeRef({ id: "scope:receipt", authority: { kind: "enterprise_system", reference: "iam:receipt" }, issuedAt: 1 }), budget: { maxToolCalls: 2, maxTokens: 100, maxCorrectiveAttempts: 0 }, mode: "normal" });
		store.record({ type: "tool_spec.published", executionEnvelope, at: 9, toolSpecPlanId: "tool-plan:sha256:abc", directTools: ["skill_complete"] });
		store.record({ type: "tool.started", executionEnvelope, at: 10, toolCallId: "call:receipt", toolName: "skill_complete", toolSpecPlanId: "tool-plan:sha256:abc" });
		store.record({ type: "tool.settled", executionEnvelope, at: 11, toolCallId: "call:receipt", toolName: "skill_complete", toolSpecPlanId: "tool-plan:sha256:abc", status: "succeeded", capabilityReceipt: { id: "receipt:skill-a", kind: "skill", name: "skill-a", version: "sha256:abc", sourceTool: "skill_complete" } });
		const trace = store.trace({ executionId: "execution:receipt", accessScopeId: "scope:receipt" });
		assert.deepEqual(trace.events[0].directTools, ["skill_complete"]);
		assert.equal(trace.events[1].toolSpecPlanId, "tool-plan:sha256:abc");
		assert.deepEqual(trace.events[2].capabilityReceipt, { id: "receipt:skill-a", kind: "skill", name: "skill-a", version: "sha256:abc", sourceTool: "skill_complete" });
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Execution Trace preserves a Capability identity implemented by a differently named Tool", () => {
	const directory = mkdtempSync(join(tmpdir(), "beemax-trace-composite-capability-"));
	try {
		const store = new FileExecutionTraceStore(join(directory, "trace.jsonl"));
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:composite", trigger: { kind: "interaction" }, mode: "normal" });
		store.record({ type: "tool.settled", executionEnvelope, toolCallId: "call:meeting", toolName: "mcp_meeting_schedule", status: "succeeded", capabilityReceipt: { id: "receipt:meeting", kind: "mcp", name: "meeting_schedule", version: "provider:2", sourceTool: "mcp_meeting_schedule" } });
		assert.deepEqual(store.trace({ executionId: "execution:composite" }).events[0].capabilityReceipt, { id: "receipt:meeting", kind: "mcp", name: "meeting_schedule", version: "provider:2", sourceTool: "mcp_meeting_schedule" });
		assert.throws(() => store.record({ type: "tool.settled", executionEnvelope, toolCallId: "call:skill", toolName: "other", status: "succeeded", capabilityReceipt: { id: "receipt:skill", kind: "skill", name: "procedure", version: "sha256:abc", sourceTool: "other" } }), /skill_complete/u);
	} finally { rmSync(directory, { recursive: true, force: true }); }
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

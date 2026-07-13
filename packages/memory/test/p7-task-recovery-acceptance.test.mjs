import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTaskCheckpoint, TaskGraph, TaskRecoveryRunner } from "@beemax/core";
import { MemoryStore } from "../dist/index.js";

test("P7 recovery gate restores at least 95% of safely replayable interrupted Tasks", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-p7-recovery-gate-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "cli:local:local";
		const executionScope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		for (let index = 1; index <= 20; index++) {
			const planId = `recovery-plan-${index}`;
			const taskId = `recovery-task-${index}`;
			new TaskGraph(store).createPlan({ id: planId, ownerKey, tasks: [{ id: taskId, title: `Recover ${index}`, recoveryPolicy: "safe_retry", idempotencyKey: `${planId}:${taskId}`, executionScope }] }, index);
			store.transition(taskId, { status: "running", startedAt: 50 });
			store.recordRun({ id: `run-${index}`, taskId, executor: "subagent", status: "running", startedAt: 50, leaseExpiresAt: 100 });
		}
		const reconciliation = store.reconcileExpiredTaskRuns(200);
		assert.equal(reconciliation.retried, 20);
		assert.equal(reconciliation.failed, 0);
		const recovery = await new TaskRecoveryRunner(store, async (task) => ({ output: `recovered:${task.id}` })).run({ maxConcurrent: 5 });
		const eventualSuccessRate = recovery.succeeded / 20;
		assert.ok(eventualSuccessRate >= 0.95, `Recoverable Task success rate ${eventualSuccessRate} is below 0.95`);
		assert.deepEqual({ plans: recovery.plans, succeeded: recovery.succeeded, failed: recovery.failed, cancelled: recovery.cancelled, blocked: recovery.blocked.length }, { plans: 20, succeeded: 20, failed: 0, cancelled: 0, blocked: 0 });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recovery resumes the durable Checkpoint through a recovery Execution Envelope after Effect reconciliation", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-recovery-lifecycle-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const ownerKey = "cli:local:local";
		const executionScope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		new TaskGraph(store).createPlan({ id: "recovery-lifecycle", ownerKey, tasks: [{ id: "recoverable", title: "Continue durable work", acceptanceCriteria: "uses recovered evidence", recoveryPolicy: "safe_retry", idempotencyKey: "recovery-lifecycle:recoverable", executionScope }] }, 1);
		store.transition("recoverable", { status: "running", startedAt: 10 });
		store.recordRun({ id: "interrupted-run", taskId: "recoverable", executor: "subagent", status: "running", startedAt: 10, leaseExpiresAt: 20 });
		const checkpoint = createTaskCheckpoint({ taskRunId: "interrupted-run", source: "pi_turn", at: 15, completed: ["evidence-collected"], committedEffectIds: ["effect:already-committed"], evidenceRefs: ["source:primary"], unresolvedIssues: ["final synthesis"], nextSafeStep: "Continue from evidence without replaying the committed Effect." });
		assert.equal(store.checkpointTask(ownerKey, "recoverable", checkpoint, 15), true);
		const effectQueries = [];
		assert.deepEqual(store.reconcileExpiredTaskRuns(20, { taskRunReplayState(query) { effectQueries.push(query); return "clear"; } }), { retried: 1, failed: 0, affectedPlans: [{ ownerKey, planId: "recovery-lifecycle" }] });
		let observed;
		const result = await new TaskRecoveryRunner(store, async (_task, _signal, context) => {
			observed = context;
			return { output: "continued with recovered evidence" };
		}, undefined, async () => ({ accepted: true, evidence: "recovered evidence checked" })).run();
		assert.deepEqual(result, { plans: 1, succeeded: 1, failed: 0, cancelled: 0, blocked: [] });
		assert.deepEqual(effectQueries, [{ ownerKey, taskId: "recoverable", taskRunId: "interrupted-run" }]);
		assert.equal(observed.executionMode, "recovery");
		assert.equal(observed.executionEnvelope.trigger.kind, "recovery");
		assert.equal(observed.executionEnvelope.taskId, "recoverable");
		assert.notEqual(observed.taskRunId, "interrupted-run");
		assert.deepEqual(observed.checkpoint, checkpoint);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createTaskCheckpoint, renderTaskCheckpoint } from "../dist/index.js";

test("Task Checkpoint is a bounded structured recovery snapshot", () => {
	const checkpoint = createTaskCheckpoint({
		taskRunId: "run:one", source: "pi_turn", at: 10,
		completed: ["read:call-1", "read:call-1", "write:call-2"],
		committedEffectIds: ["effect-1"], evidenceRefs: ["tool:call-1"],
		unresolvedIssues: ["tool:call-3 failed"], nextSafeStep: "Reconcile unknown Effects, then continue the Task.",
	});
	assert.deepEqual(checkpoint, {
		version: 1, taskRunId: "run:one", source: "pi_turn", at: 10,
		completed: ["read:call-1", "write:call-2"], committedEffectIds: ["effect-1"], evidenceRefs: ["tool:call-1"],
		unresolvedIssues: ["tool:call-3 failed"], nextSafeStep: "Reconcile unknown Effects, then continue the Task.",
	});
	assert.match(renderTaskCheckpoint(checkpoint), /"taskRunId":"run:one"/);
});

test("Task Checkpoint rejects credential material", () => {
	assert.throws(() => createTaskCheckpoint({ taskRunId: "run:unsafe", source: "pi_turn", at: 10, completed: [], committedEffectIds: [], evidenceRefs: [], unresolvedIssues: [], nextSafeStep: "Bearer abcdefghijklmnopqrstuvwxyz" }), /credential|sensitive/i);
});

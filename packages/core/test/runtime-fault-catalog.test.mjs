import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RUNTIME_FAULT_CATALOG, RUNTIME_FAULT_KINDS, assessRuntimeFaultCoverage } from "../dist/index.js";

test("runtime fault catalog covers every release fault with observable and operator recovery paths", () => {
	assert.deepEqual(RUNTIME_FAULT_CATALOG.map((fault) => fault.kind), [
		"pi_crash",
		"tool_timeout",
		"process_exit",
		"restart",
		"multi_instance_claim",
		"unknown_effect",
		"verification_unavailable",
		"delivery_failure",
		"compaction",
		"steering",
		"correction",
	]);
	assert.deepEqual(assessRuntimeFaultCoverage(RUNTIME_FAULT_CATALOG), {
		passed: true,
		missingFaults: [],
		missingObservability: [],
		missingOperatorRecovery: [],
		missingReleaseEvidence: [],
	});
});

test("fault coverage fails closed when release evidence or recovery is missing", () => {
	const incomplete = RUNTIME_FAULT_CATALOG.map((fault) => fault.kind === "tool_timeout"
		? { ...fault, operatorRecovery: [], releaseEvidence: [] }
		: fault);
	const result = assessRuntimeFaultCoverage(incomplete);
	assert.equal(result.passed, false);
	assert.deepEqual(result.missingOperatorRecovery, ["tool_timeout"]);
	assert.deepEqual(result.missingReleaseEvidence, ["tool_timeout"]);
});

test("every release fault names executable evidence in the full release suite", () => {
	const evidence = {
		pi_crash: ["packages/core/test/tool-effect.test.mjs", "effect ledger recovers a mutation abandoned by a crashed process"],
		tool_timeout: ["packages/core/test/tool-effect.test.mjs", "Tool timeout leaves an external mutation unknown"],
		process_exit: ["packages/memory/test/store.test.mjs", "a crashed Agent execution is reconciled and recovered by a new process"],
		restart: ["packages/memory/test/store.test.mjs", "Task Plan pause and checkpoints survive process restart"],
		multi_instance_claim: ["packages/core/test/initiative-trigger-service.test.mjs", "durable Trigger service fences multi-instance decisions"],
		unknown_effect: ["apps/cli/test/effect-inspection.test.mjs", "operators can inspect and reconcile an unknown Effect"],
		verification_unavailable: ["packages/memory/test/store.test.mjs", "Verification unavailable persists across Profile database restarts"],
		delivery_failure: ["packages/core/test/task-plan-notice-delivery.test.mjs", "requeues failure"],
		compaction: ["packages/core/test/runtime-boundary.test.mjs", "context compaction preserves active Objective"],
		steering: ["packages/core/test/interaction-runtime.test.mjs", "steer and follow-up use native runtime delivery"],
		correction: ["packages/core/test/autonomous-planning.test.mjs", "creates one bounded Corrective Task Run"],
	};
	assert.deepEqual(Object.keys(evidence), [...RUNTIME_FAULT_KINDS]);
	for (const [kind, [path, title]] of Object.entries(evidence)) {
		const source = readFileSync(path, "utf8");
		assert.match(source, new RegExp(title), `${kind} evidence is not executable`);
	}
});

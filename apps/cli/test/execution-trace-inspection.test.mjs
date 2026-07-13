import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAccessScopeRef, createExecutionEnvelope, FileExecutionTraceStore } from "@beemax/core";
import { inspectProfileExecutionTrace, renderExecutionTrace } from "../dist/execution-trace-inspection.js";

test("operator inspection diagnoses one scoped execution from the shared Trace contract", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-trace-inspection-"));
	try {
		const store = new FileExecutionTraceStore(join(root, "logs", "execution-trace.jsonl"));
		const accessScopeRef = createAccessScopeRef({ id: "scope:operator", authority: { kind: "administrator_grant", reference: "admin:operator" }, issuedAt: 1 });
		const executionEnvelope = createExecutionEnvelope({ executionId: "execution:operator", trigger: { kind: "manual" }, taskRunId: "run:operator", accessScopeRef, mode: "normal" });
		store.record({ type: "execution.started", executionEnvelope, at: 1 });
		store.record({ type: "execution.settled", executionEnvelope, at: 11, status: "succeeded" });
		assert.equal(inspectProfileExecutionTrace(root, "execution:operator"), undefined);
		const trace = inspectProfileExecutionTrace(root, "execution:operator", "scope:operator");
		assert.equal(trace.durationMs, 10);
		assert.match(renderExecutionTrace(trace), /execution:operator/);
		assert.match(renderExecutionTrace(trace), /status=succeeded/);
		assert.doesNotMatch(renderExecutionTrace(trace), /admin:operator/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

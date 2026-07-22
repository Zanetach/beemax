import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileToolEffectJournal, MUTATING_TOOL_POLICY } from "@thruvera/core";
import { inspectProfileEffects, reconcileProfileEffect } from "../dist/effect-inspection.js";

test("operators can inspect and reconcile an unknown Effect without replaying its mutation", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effect-inspection-"));
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "owner" };
	const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
	try {
		const id = effects.begin({ source, taskId: "task:1", toolCallId: "call:1", toolName: "external_update", args: { idempotencyKey: "update:1" }, policy: MUTATING_TOOL_POLICY });
		effects.finish({ source, toolCallId: "call:1", toolName: "external_update", policy: MUTATING_TOOL_POLICY, isError: true });
		assert.deepEqual(inspectProfileEffects(root).map((effect) => effect.id), [id]);
		const reconciled = reconcileProfileEffect(root, id, { status: "failed" });
		assert.equal(reconciled.status, "failed");
		assert.deepEqual(inspectProfileEffects(root), []);
		assert.throws(() => reconcileProfileEffect(root, id, { status: "failed" }), /only unknown/i);
	} finally { effects.close(); rmSync(root, { recursive: true, force: true }); }
});

test("committed reconciliation requires explicit observed operation and rejects Secrets", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effect-reconciliation-input-"));
	try {
		assert.throws(() => reconcileProfileEffect(root, "missing", { status: "committed" }), /operation/i);
		assert.throws(() => reconcileProfileEffect(root, "missing", { status: "failed", externalRef: "Bearer sk-secret-value" }), /credential/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

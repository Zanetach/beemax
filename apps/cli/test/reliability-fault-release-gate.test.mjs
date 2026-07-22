import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileToolEffectJournal, MUTATING_TOOL_POLICY, RUNTIME_FAULT_CATALOG, assessRuntimeFaultCoverage } from "@thruvera/core";
import { MemoryStore } from "@thruvera/memory";
import { inspectProfileEffects, reconcileProfileEffect } from "../dist/effect-inspection.js";

test("reliability release gate prevents duplicate committed mutations across instances", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-reliability-effect-gate-"));
	const path = join(root, "tool-effects.jsonl");
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "operator" };
	const policy = { ...MUTATING_TOOL_POLICY, sideEffect: "local" };
	const first = new FileToolEffectJournal(path);
	const second = new FileToolEffectJournal(path);
	try {
		first.begin({ source, taskId: "task:first", toolCallId: "call:first", toolName: "write", args: { idempotencyKey: "mutation:one" }, policy });
		first.finish({ source, toolCallId: "call:first", toolName: "write", policy, isError: false, details: { beemaxEffect: { operation: "write durable state" } } });
		assert.throws(() => second.begin({ source, taskId: "task:retry", toolCallId: "call:retry", toolName: "write", args: { idempotencyKey: "mutation:one" }, policy }), /already committed/i);
		assert.equal(first.events().filter((effect) => effect.status === "committed" && effect.idempotencyKey === "mutation:one").length, 1);
	} finally {
		first.close(); second.close(); rmSync(root, { recursive: true, force: true });
	}
});

test("reliability release gate resumes only safe interrupted work and fails unsafe work explicitly", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-reliability-recovery-gate-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "operator" };
		store.record({ id: "safe", ownerKey: "cli:local:operator", kind: "delegated", title: "Safe recovery", status: "running", recoveryPolicy: "safe_retry", idempotencyKey: "safe:one", executionScope: scope, createdAt: 1, startedAt: 2 });
		store.recordRun({ id: "safe-run", taskId: "safe", executor: "agent", status: "running", startedAt: 2, leaseExpiresAt: 10 });
		store.record({ id: "unsafe", ownerKey: "cli:local:operator", kind: "delegated", title: "Unsafe recovery", status: "running", recoveryPolicy: "never", executionScope: scope, createdAt: 1, startedAt: 2 });
		store.recordRun({ id: "unsafe-run", taskId: "unsafe", executor: "agent", status: "running", startedAt: 2, leaseExpiresAt: 10 });

		assert.deepEqual(store.reconcileExpiredTaskRuns(20), { retried: 1, failed: 1, affectedPlans: [] });
		const tasks = new Map(store.queryTasks({ ownerKeys: ["cli:local:operator"] }).map((task) => [task.id, task]));
		assert.equal(tasks.get("safe").status, "pending");
		assert.equal(tasks.get("unsafe").status, "failed");
		assert.match(tasks.get("unsafe").error, /interrupted/i);
		assert.equal(store.taskRuns("safe")[0].status, "failed");
		assert.equal(store.taskRuns("unsafe")[0].status, "failed");
		assert.equal([...tasks.values()].filter((task) => task.status === "running").length, 0);
	} finally {
		store.close(); rmSync(root, { recursive: true, force: true });
	}
});

test("reliability release gate exposes every fault and resolves unknown Effects without replay", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-reliability-operator-gate-"));
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "operator" };
	const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
	try {
		const id = effects.begin({ source, taskId: "task:timeout", toolCallId: "call:timeout", toolName: "external_update", args: { idempotencyKey: "timeout:one" }, policy: MUTATING_TOOL_POLICY });
		effects.finish({ source, toolCallId: "call:timeout", toolName: "external_update", policy: MUTATING_TOOL_POLICY, isError: true });
		assert.deepEqual(inspectProfileEffects(root).map((effect) => effect.id), [id]);
		assert.equal(reconcileProfileEffect(root, id, { status: "failed" }).status, "failed");
		const settled = inspectProfileEffects(root, "all");
		assert.deepEqual([...new Set(settled.map((effect) => effect.id))], [id]);
		assert.equal(settled.filter((effect) => effect.status === "committed").length, 0);
		assert.equal(assessRuntimeFaultCoverage(RUNTIME_FAULT_CATALOG).passed, true);
	} finally {
		effects.close(); rmSync(root, { recursive: true, force: true });
	}
});

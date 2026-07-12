import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileToolEffectJournal, MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY } from "../dist/index.js";

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

test("effect journal marks an interrupted in-flight mutation unknown on recovery", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effects-recovery-"));
	try {
		const path = join(root, "tool-effects.jsonl");
		new FileToolEffectJournal(path).begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "external_write", policy: MUTATING_TOOL_POLICY });
		const recovered = new FileToolEffectJournal(path).events();
		assert.deepEqual(recovered.map((record) => record.status), ["planned", "executing", "unknown"]);
		assert.equal(recovered.at(-1).receipt, undefined);
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
		effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: "write", args: { idempotencyKey: "daily-report" }, policy: MUTATING_TOOL_POLICY });
		effects.finish({ source, toolCallId: "call-1", toolName: "write", policy: MUTATING_TOOL_POLICY, isError: false });
		const otherUser = { ...source, userId: "user-2" };
		assert.ok(effects.begin({ source: otherUser, taskId: "turn-2", toolCallId: "call-2", toolName: "write", args: { idempotencyKey: "daily-report" }, policy: MUTATING_TOOL_POLICY }));
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

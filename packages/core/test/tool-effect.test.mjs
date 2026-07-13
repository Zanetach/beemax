import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
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

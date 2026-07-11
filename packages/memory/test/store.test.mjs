import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../dist/index.js";
import Database from "better-sqlite3";
import { TaskGraph, TaskRecoveryRunner } from "@beemax/core";

test("natural-language recall is safe and follows a user across chats", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-test-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.remember({
			platform: "feishu",
			chatId: "chat-a",
			userId: "user-1",
			role: "memory",
			content: "User prefers concise weekly reports",
		});
		const records = store.recall('prefers "concise" OR', {
			platform: "feishu",
			chatId: "chat-b",
			userId: "user-1",
			limit: 5,
		});
		assert.equal(records.length, 1);
		assert.match(records[0].content, /concise/);
		assert.equal(store.list({ platform: "feishu", userId: "user-1" }).length, 1);
		assert.equal(store.forget(records[0].id, { platform: "feishu", userId: "user-1" }), true);
		assert.equal(store.list({ platform: "feishu", userId: "user-1" }).length, 0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("conversation candidates stay pending until explicitly promoted or rejected", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-candidates-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "feishu", chatId: "chat-a", userId: "user-1" };
		const candidate = store.recordCandidate({ ...scope, role: "user", content: "User prefers monthly strategy reviews" });
		assert.equal(store.list(scope).length, 0);
		assert.equal(store.recall("monthly strategy", scope).length, 0);
		assert.equal(store.listCandidates(scope).length, 1);
		assert.equal(store.promoteCandidate(candidate, scope), true);
		assert.equal(store.list(scope).length, 1);
		assert.deepEqual(store.stats(scope), { curated: 1, pending: 0, promoted: 1, rejected: 0 });
		const rejected = store.recordCandidate({ ...scope, role: "assistant", content: "Transient draft response" });
		assert.equal(store.rejectCandidate(rejected, scope), true);
		assert.equal(store.stats(scope).rejected, 1);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("task ledger stores verifiable profile-scoped task facts independently from chat memory", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-ledger-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.upsertTask({
			id: "anthropic-protocol",
			title: "Support Anthropic Messages protocol",
			status: "done",
			evidence: "tag:v0.1.0-preview.15", completedAt: 1_700_000_000_000,
		});
		assert.deepEqual(store.listTasks(), [{
			id: "anthropic-protocol",
			title: "Support Anthropic Messages protocol",
			status: "done",
			evidence: "tag:v0.1.0-preview.15",
			completedAt: 1_700_000_000_000,
			updatedAt: store.listTasks()[0].updatedAt,
		}]);
		store.upsertTask({ id: "anthropic-protocol", title: "Support Anthropic Messages protocol", status: "open" });
		assert.equal(store.listTasks()[0].status, "open");
		assert.equal(store.listTasks()[0].evidence, undefined);
		assert.equal(store.listTasks()[0].completedAt, undefined);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("runtime Task ledger persists delegated lifecycle independently from memory facts", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-runtime-task-ledger-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "child-1", ownerKey: "cli:local:local", kind: "delegated", title: "Research", status: "pending", createdAt: 100 });
		store.transition("child-1", { status: "running", startedAt: 110 });
		store.transition("child-1", { status: "succeeded", finishedAt: 120, result: "done" });
		store.recordRun({ id: "run-1", taskId: "child-1", executor: "subagent", status: "running", startedAt: 110 });
		store.transitionRun("run-1", { status: "succeeded", finishedAt: 120, output: "done" });
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"] }), [{
			id: "child-1", ownerKey: "cli:local:local", kind: "delegated", title: "Research",
			status: "succeeded", createdAt: 100, startedAt: 110, finishedAt: 120, result: "done",
		}]);
		assert.deepEqual(store.taskRuns("child-1"), [{ id: "run-1", taskId: "child-1", executor: "subagent", status: "succeeded", startedAt: 110, finishedAt: 120, output: "done" }]);
		assert.equal(store.listTasks().length, 0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("expired Task Run leases recover only explicitly idempotent safe-retry Tasks", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-recovery-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "safe", ownerKey: "cli:local:local", kind: "delegated", title: "Safe research", status: "running", recoveryPolicy: "safe_retry", idempotencyKey: "plan:safe", createdAt: 10, startedAt: 20 });
		store.recordRun({ id: "safe-run", taskId: "safe", executor: "subagent", status: "running", startedAt: 20, leaseExpiresAt: 100 });
		store.record({ id: "unsafe", ownerKey: "cli:local:local", kind: "delegated", title: "Unknown effect", status: "running", recoveryPolicy: "never", createdAt: 10, startedAt: 20 });
		store.recordRun({ id: "unsafe-run", taskId: "unsafe", executor: "subagent", status: "running", startedAt: 20, leaseExpiresAt: 100 });
		store.record({ id: "live", ownerKey: "cli:local:local", kind: "delegated", title: "Still leased", status: "running", recoveryPolicy: "safe_retry", idempotencyKey: "plan:live", createdAt: 10, startedAt: 20 });
		store.recordRun({ id: "live-run", taskId: "live", executor: "subagent", status: "running", startedAt: 20, leaseExpiresAt: 300 });
		assert.deepEqual(store.reconcileExpiredTaskRuns(200), { retried: 1, failed: 1 });
		const tasks = new Map(store.queryTasks({ ownerKeys: ["cli:local:local"] }).map((task) => [task.id, task]));
		assert.equal(tasks.get("safe").status, "pending");
		store.transition("safe", { status: "running", startedAt: 210 });
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "safe" })[0].error, undefined);
		assert.equal(tasks.get("unsafe").status, "failed");
		assert.equal(tasks.get("live").status, "running");
		assert.equal(store.taskRuns("safe")[0].status, "failed");
		assert.match(store.taskRuns("safe")[0].error, /interrupted/i);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task recovery runner resumes only durable safe DAG candidates with an Execution Scope", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-resume-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local", threadId: "recovery" };
		store.recordPlan([
			{ id: "done", ownerKey: "cli:local#recovery:local", kind: "delegated", title: "Done", status: "succeeded", planId: "plan", createdAt: 1, finishedAt: 2 },
			{ id: "resume", ownerKey: "cli:local#recovery:local", kind: "delegated", title: "Resume", description: "finish research", status: "pending", planId: "plan", recoveryPolicy: "safe_retry", idempotencyKey: "plan:resume", executionScope: scope, createdAt: 1 },
			{ id: "unsafe", ownerKey: "cli:local#recovery:local", kind: "delegated", title: "Do not resume", status: "pending", planId: "plan", createdAt: 1 },
		], [{ taskId: "resume", dependsOn: "done" }]);
		const executed = [];
		const result = await new TaskRecoveryRunner(store, async (task) => { executed.push(task.description); return { output: "recovered" }; }).run();
		assert.deepEqual(result, { plans: 1, succeeded: 1, failed: 0, cancelled: 0, blocked: [] });
		assert.deepEqual(executed, ["finish research"]);
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local#recovery:local"], id: "resume" })[0].result, "recovered");
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local#recovery:local"], id: "unsafe" })[0].status, "pending");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy task facts migrate once into objective Tasks", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-legacy-task-migration-"));
	const path = join(root, "memory.db");
	const legacy = new Database(path);
	legacy.exec("CREATE TABLE task_ledger (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT, completed_at INTEGER, updated_at INTEGER NOT NULL)");
	legacy.prepare("INSERT INTO task_ledger VALUES (?, ?, ?, ?, ?, ?)").run("release", "Ship release", "done", "tag:v1", 120, 110);
	legacy.close();
	const store = new MemoryStore(path);
	try {
		assert.deepEqual(store.queryTasks({ ownerKeys: ["profile"] }), [{ id: "release", ownerKey: "profile", kind: "objective", title: "Ship release", status: "succeeded", evidence: "tag:v1", createdAt: 110, finishedAt: 120 }]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task DAG dependencies persist with their Tasks", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-dag-"));
	const path = join(root, "memory.db");
	let store = new MemoryStore(path);
	new TaskGraph(store).createPlan({ id: "content-plan", ownerKey: "cli:local:local", tasks: [{ id: "research", title: "Research" }, { id: "write", title: "Write" }], dependencies: [{ taskId: "write", dependsOn: "research" }] }, 100);
	store.close();
	store = new MemoryStore(path);
	try {
		assert.deepEqual(store.taskDependencies(["write"]), [{ taskId: "write", dependsOn: "research" }]);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"] }).map((task) => task.id).sort(), ["research", "write"]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("structured understandings retain evidence, support correction, and compile a bounded long-term snapshot", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-understanding-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", userId: "zane" };
		const preference = store.upsertClaim({
			...scope, kind: "preference", statement: "用户默认使用中文，并希望先给结论再给依据。",
			confidence: 0.95, stability: "high", evidence: { kind: "conversation", excerpt: "默认中文，先给结论。" },
		});
		store.upsertClaim({
			...scope, kind: "project", statement: "BeeMax 正在建设可解释的长期记忆系统。",
			confidence: 0.9, stability: "medium", evidence: { excerpt: "按设计实施记忆系统。" },
		});
		assert.equal(store.recallBrief("用户默认使用中文", scope).claims[0].id, preference.id);
		assert.equal(store.recall("用户默认使用中文", scope)[0].id, preference.id);
		assert.equal(store.explainClaim(preference.id, scope).evidence[0].excerpt, "默认中文，先给结论。");
		const correctionEvent = store.recordEvent({ ...scope, kind: "feedback", content: "架构讨论时需要完整方案。" });
		const corrected = store.correctClaim(preference.id, { statement: "用户默认使用中文；架构讨论时需要完整方案。", evidence: { kind: "correction", eventId: correctionEvent, excerpt: "架构讨论时需要完整方案。" } }, scope);
		assert.ok(corrected);
		assert.equal(store.listClaims(scope).some((claim) => claim.id === preference.id), false);
		assert.equal(store.explainClaim(preference.id, scope).claim.supersededBy, corrected.id);
		assert.ok(store.explainClaim(corrected.id, scope).evidence[0].eventId);
		assert.match(store.compileLongTermMemory({ ...scope, maxChars: 1000 }), /架构讨论时需要完整方案/);
		assert.match(store.compileLongTermMemory({ ...scope, maxChars: 1000 }), /BeeMax 正在建设/);
		store.upsertClaim({ ...scope, userId: "another-user", kind: "fact", statement: "Other user's private fact", confidence: 1, stability: "high" });
		assert.doesNotMatch(store.compileLongTermMemory({ ...scope, maxChars: 1000 }), /Other user's private fact/);
		const foreignEvent = store.recordEvent({ ...scope, userId: "another-user", kind: "user", content: "Private source" });
		assert.throws(() => store.upsertClaim({ ...scope, kind: "fact", statement: "Must not cross scopes", evidence: { eventId: foreignEvent, excerpt: "Private source" } }), /outside this user scope/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

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
		store.record({ id: "child-1", ownerKey: "cli:local:local", kind: "delegated", title: "Research", acceptanceCriteria: "Includes a source", verificationStatus: "pending", correctiveAttempts: 0, status: "pending", createdAt: 100 });
		store.transition("child-1", { status: "running", startedAt: 110 });
		store.transition("child-1", { status: "succeeded", finishedAt: 120, result: "done", evidence: "ACCEPT: source checked", verificationStatus: "accepted", correctiveAttempts: 1 });
		store.recordRun({ id: "run-1", taskId: "child-1", executor: "subagent", status: "running", startedAt: 110 });
		store.transitionRun("run-1", { status: "succeeded", finishedAt: 120, output: "done" });
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"] }), [{
			id: "child-1", ownerKey: "cli:local:local", kind: "delegated", title: "Research", acceptanceCriteria: "Includes a source",
			status: "succeeded", evidence: "ACCEPT: source checked", verificationStatus: "accepted", correctiveAttempts: 1, createdAt: 100, startedAt: 110, finishedAt: 120, result: "done",
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

test("a recovery runner skips a durable Task Plan claimed by another executor", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-recovery-claim-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path);
	const second = new MemoryStore(path);
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		new TaskGraph(first).createPlan({ id: "claimed-recovery-plan", ownerKey: "cli:local:local", tasks: [{ id: "claimed", title: "Claimed", recoveryPolicy: "safe_retry", idempotencyKey: "claimed-recovery-plan:claimed", executionScope: scope }] }, 1);
		assert.equal(first.claimTaskPlanExecution("cli:local:local", "claimed-recovery-plan", "other-executor", Date.now() + 60_000), true);
		let executions = 0;
		assert.deepEqual(await new TaskRecoveryRunner(second, async () => { executions++; return { output: "duplicate" }; }).run(), { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] });
		assert.equal(executions, 0);
		assert.equal(second.queryTasks({ ownerKeys: ["cli:local:local"], id: "claimed" })[0].status, "pending");
	} finally { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
});

test("startup recovery drains more Task Plans than one ledger batch", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-recovery-batches-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		const graph = new TaskGraph(store);
		for (let index = 0; index < 101; index++) graph.createPlan({
			id: `batch-plan-${index}`, ownerKey: "cli:local:local",
			tasks: [{ id: `batch-task-${index}`, title: `Task ${index}`, recoveryPolicy: "safe_retry", idempotencyKey: `batch:${index}`, executionScope: scope }],
		}, index + 1);
		const result = await new TaskRecoveryRunner(store, async () => ({ output: "recovered" })).run({ maxConcurrent: 20 });
		assert.deepEqual(result, { plans: 101, succeeded: 101, failed: 0, cancelled: 0, blocked: [] });
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("blocked Task Plans do not starve later startup recovery batches", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-recovery-blocked-batch-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		const graph = new TaskGraph(store);
		for (let index = 0; index < 100; index++) graph.createPlan({
			id: `blocked-plan-${index}`, ownerKey: "cli:local:local",
			tasks: [
				{ id: `unsafe-${index}`, title: "Unsafe prerequisite" },
				{ id: `blocked-${index}`, title: "Blocked recovery", recoveryPolicy: "safe_retry", idempotencyKey: `blocked:${index}`, executionScope: scope },
			], dependencies: [{ taskId: `blocked-${index}`, dependsOn: `unsafe-${index}` }],
		}, index + 1);
		graph.createPlan({ id: "later-plan", ownerKey: "cli:local:local", tasks: [{ id: "later-task", title: "Later", recoveryPolicy: "safe_retry", idempotencyKey: "later", executionScope: scope }] }, 101);
		const result = await new TaskRecoveryRunner(store, async () => ({ output: "recovered" })).run({ maxConcurrent: 20 });
		assert.equal(result.plans, 101);
		assert.equal(result.succeeded, 1);
		assert.equal(result.blocked.length, 100);
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "later-task" })[0].status, "succeeded");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task recovery terminalizes a pending Task whose dependency already failed", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-dependency-failure-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		store.recordPlan([
			{ id: "upstream", ownerKey: "cli:local:local", kind: "delegated", title: "Upstream", status: "failed", planId: "plan", recoveryPolicy: "safe_retry", idempotencyKey: "plan:upstream", executionScope: scope, createdAt: 1, finishedAt: 2, error: "failed" },
			{ id: "downstream", ownerKey: "cli:local:local", kind: "delegated", title: "Downstream", status: "pending", planId: "plan", recoveryPolicy: "safe_retry", idempotencyKey: "plan:downstream", executionScope: scope, createdAt: 1 },
		], [{ taskId: "downstream", dependsOn: "upstream" }]);
		let executions = 0;
		const result = await new TaskRecoveryRunner(store, async () => { executions++; return { output: "unused" }; }).run();
		assert.deepEqual(result, { plans: 1, succeeded: 0, failed: 1, cancelled: 0, blocked: [] });
		assert.equal(executions, 0);
		assert.match(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "downstream" })[0].error, /Dependency Failure/);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("manual Task Plan retry is owner-scoped and requeues only recoverable failed nodes", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-manual-retry-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		store.record({ id: "failed", ownerKey: "cli:local:local", kind: "delegated", title: "Retry", description: "retry safely", status: "failed", planId: "retry-plan", recoveryPolicy: "safe_retry", idempotencyKey: "retry-plan:failed", executionScope: scope, createdAt: 1, finishedAt: 2, error: "model failed" });
		const runner = new TaskRecoveryRunner(store, async () => ({ output: "retried" }));
		assert.deepEqual(await runner.retry(["cli:other:local"], "retry-plan"), { prepared: 0, plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] });
		assert.deepEqual(await runner.retry(["cli:local:local"], "retry-plan"), { prepared: 1, plans: 1, succeeded: 1, failed: 0, cancelled: 0, blocked: [] });
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "failed" })[0].result, "retried");
		assert.equal(store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "retry-plan" })[0].status, "succeeded");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Plan cancellation is owner-scoped and persists Tasks and active Runs atomically", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-task-plan-cancel-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		store.record({ id: "running", ownerKey: "cli:local:local", kind: "delegated", title: "Running", status: "running", planId: "cancel-plan", createdAt: 1, startedAt: 2 });
		store.recordRun({ id: "run", taskId: "running", executor: "subagent", status: "running", startedAt: 2, leaseExpiresAt: 1000 });
		store.record({ id: "pending", ownerKey: "cli:local:local", kind: "delegated", title: "Pending", status: "pending", planId: "cancel-plan", createdAt: 1 });
		const runner = new TaskRecoveryRunner(store, async () => ({ output: "unused" }));
		assert.deepEqual(runner.cancel(["cli:other:local"], "cancel-plan"), { active: 0, tasks: 0 });
		assert.deepEqual(runner.cancel(["cli:local:local"], "cancel-plan"), { active: 0, tasks: 2 });
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"], planIds: ["cancel-plan"] }).map((task) => task.status), ["cancelled", "cancelled"]);
		assert.equal(store.taskRuns("running")[0].status, "cancelled");
		const plan = store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "cancel-plan" })[0];
		assert.equal(plan.status, "cancelled");
		assert.equal(plan.taskCount, 2);
		assert.equal(plan.cancelled, 2);
		assert.ok(plan.finishedAt >= plan.startedAt);
		assert.deepEqual(await runner.retry(["cli:local:local"], "cancel-plan"), { prepared: 0, plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] });
		assert.equal(store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "cancel-plan" })[0].status, "cancelled");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Task Plan cancellation aborts a live recovery and leaves no running Task or Run", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-live-plan-cancel-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const scope = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
		store.record({ id: "live", ownerKey: "cli:local:local", kind: "delegated", title: "Live", status: "pending", planId: "live-plan", recoveryPolicy: "safe_retry", idempotencyKey: "live-plan:live", executionScope: scope, createdAt: 1 });
		const runner = new TaskRecoveryRunner(store, async (_task, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
		const running = runner.run();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(runner.cancel(["cli:local:local"], "live-plan"), { active: 1, tasks: 1 });
		assert.deepEqual(await running, { plans: 1, succeeded: 0, failed: 0, cancelled: 1, blocked: [] });
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "live" })[0].status, "cancelled");
		assert.equal(store.taskRuns("live")[0].status, "cancelled");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a cross-process cancellation remains the Terminal Outcome when a late executor exits", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-terminal-outcome-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		const graph = new TaskGraph(store);
		graph.createPlan({ id: "race-plan", ownerKey: "cli:local:local", tasks: [{ id: "race", title: "Race" }] });
		const running = graph.run(["cli:local:local"], "race-plan", async (_task, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), { leaseMs: 1_000, leaseHeartbeatMs: 5 });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(store.cancelTaskPlan(["cli:local:local"], "race-plan"), 1);
		assert.deepEqual(await running, { succeeded: 0, failed: 0, cancelled: 1, blocked: [] });
		assert.equal(store.queryTasks({ ownerKeys: ["cli:local:local"], id: "race" })[0].status, "cancelled");
		assert.equal(store.taskRuns("race")[0].status, "cancelled");
		assert.equal(store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "race-plan" })[0].status, "cancelled");
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
	new TaskGraph(store).createPlan({ id: "content-plan", ownerKey: "cli:local:local", title: "Create content", tasks: [{ id: "research", title: "Research" }, { id: "write", title: "Write" }], dependencies: [{ taskId: "write", dependsOn: "research" }] }, 100);
	store.close();
	store = new MemoryStore(path);
	try {
		assert.deepEqual(store.taskDependencies(["write"]), [{ taskId: "write", dependsOn: "research" }]);
		assert.deepEqual(store.queryTasks({ ownerKeys: ["cli:local:local"] }).map((task) => task.id).sort(), ["research", "write"]);
		assert.deepEqual(store.queryTaskPlans({ ownerKeys: ["cli:local:local"] }), [{
			id: "content-plan", ownerKey: "cli:local:local", title: "Create content", status: "pending", taskCount: 2,
			succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: 100,
		}]);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a Task Plan Terminal Outcome rejects late lifecycle updates", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-terminal-outcome-"));
	const store = new MemoryStore(join(root, "memory.db"));
	try {
		new TaskGraph(store).createPlan({ id: "terminal-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task" }] }, 100);
		const counts = { taskCount: 1, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0 };
		assert.equal(store.transitionPlan("terminal-plan", { ...counts, status: "running", startedAt: 110 }), true);
		assert.equal(store.transitionPlan("terminal-plan", { ...counts, status: "cancelled", cancelled: 1, finishedAt: 120 }), true);
		assert.equal(store.transitionPlan("terminal-plan", { ...counts, status: "failed", failed: 1, finishedAt: 130 }), false);
		assert.equal(store.transitionPlan("terminal-plan", { ...counts, status: "running", startedAt: 130 }), false);
		assert.equal(store.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "terminal-plan" })[0].status, "cancelled");
		assert.equal(store.claimTaskPlanExecution("cli:local:local", "terminal-plan", "late-worker", 300, 200), false);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a Task Plan Execution Claim admits one holder and fences a stale holder after takeover", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-plan-execution-claim-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path);
	const second = new MemoryStore(path);
	try {
		new TaskGraph(first).createPlan({ id: "claimed-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task" }] }, 100);
		assert.equal(first.claimTaskPlanExecution("cli:local:local", "claimed-plan", "worker-a", 200, 100), true);
		assert.equal(second.claimTaskPlanExecution("cli:local:local", "claimed-plan", "worker-b", 250, 150), false);
		assert.equal(second.claimTaskPlanExecution("cli:local:local", "claimed-plan", "worker-b", 350, 200), true);
		assert.equal(first.releaseTaskPlanExecution("cli:local:local", "claimed-plan", "worker-a"), false);
		assert.equal(second.renewTaskPlanExecution("cli:local:local", "claimed-plan", "worker-b", 400, 300), true);
		assert.equal(second.releaseTaskPlanExecution("cli:local:local", "claimed-plan", "worker-b"), true);
	} finally { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
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

import assert from "node:assert/strict";
import test from "node:test";
import { createTaskLedgerTools, SubagentManager } from "../dist/index.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("delegated work records one durable Task and advances its lifecycle", async () => {
	const records = new Map();
	const runs = new Map();
	const ledger = {
		record(task) { records.set(task.id, { ...task }); },
		transition(id, change) { records.set(id, { ...records.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); },
		transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
	};
	const manager = new SubagentManager({ taskLedger: ledger, execute: async () => "verified result" });
	const delegated = manager.spawn(source, { goal: "Review the release", name: "release-review" });
	const completed = await manager.wait(source, delegated.id, 1_000);
	assert.equal(completed.status, "completed");
	assert.deepEqual(records.get(delegated.id), {
		id: delegated.id,
		ownerKey: "cli:local:local",
		kind: "delegated",
		title: "release-review",
		status: "succeeded",
		createdAt: delegated.createdAt,
		startedAt: records.get(delegated.id).startedAt,
		finishedAt: completed.finishedAt,
		result: "verified result",
	});
	assert.equal(typeof records.get(delegated.id).startedAt, "number");
	assert.deepEqual([...runs.values()].map(({ taskId, executor, status, output }) => ({ taskId, executor, status, output })), [{ taskId: delegated.id, executor: "subagent", status: "succeeded", output: "verified result" }]);
	await manager.dispose();
});

test("delegated work retains its parent Objective", async () => {
	const records = new Map();
	const ledger = {
		record(task) { records.set(task.id, { ...task }); },
		transition(id, change) { records.set(id, { ...records.get(id), ...change }); return true; },
		recordRun() {}, transitionRun() {},
	};
	const manager = new SubagentManager({ taskLedger: ledger, execute: async () => "done" });
	const delegated = manager.spawn(source, { goal: "Research", parentId: "objective-1" });
	await manager.wait(source, delegated.id, 1_000);
	assert.equal(records.get(delegated.id).parentId, "objective-1");
	await manager.dispose();
});

test("single Delegation persists as a recoverable one-Task Plan", async () => {
	const records = new Map(); const plans = new Map();
	const ledger = {
		record() { throw new Error("standalone record must use durable Plan"); },
		recordPlan(tasks, _dependencies, plan) { for (const task of tasks) records.set(task.id, { ...task }); plans.set(plan.id, { ...plan }); },
		transition(id, change) { records.set(id, { ...records.get(id), ...change }); return true; },
		recordRun() {}, transitionRun() {},
	};
	const manager = new SubagentManager({ taskLedger: ledger, execute: async () => "done" });
	const delegated = manager.spawn(source, { goal: "Research official docs", context: "Use primary sources" });
	await manager.wait(source, delegated.id, 1_000);
	const task = records.get(delegated.id);
	assert.equal(task.planId, `delegation:${delegated.id}`);
	assert.equal(task.recoveryPolicy, "safe_retry");
	assert.equal(task.idempotencyKey, `delegation:${delegated.id}`);
	assert.deepEqual(task.executionScope, source);
	assert.match(task.description, /Use primary sources/);
	assert.equal(plans.get(task.planId).taskCount, 1);
	await manager.dispose();
});

test("Task ledger tools query durable work across conversation and Profile scopes without leaking other owners", async () => {
	const tasks = [
		{ id: "thread", ownerKey: "cli:local#topic:local", kind: "delegated", title: "Thread task", status: "succeeded", createdAt: 1 },
		{ id: "profile", ownerKey: "profile", kind: "objective", title: "Profile task", status: "pending", createdAt: 2 },
		{ id: "other", ownerKey: "cli:other:other", kind: "delegated", title: "Private", status: "running", createdAt: 3 },
	];
	const plans = [
		{ id: "owned-plan", ownerKey: "cli:local#topic:local", title: "Owned Plan", status: "succeeded", taskCount: 1, succeeded: 1, failed: 0, cancelled: 0, verified: 1, correctiveAttempts: 0, createdAt: 1 },
		{ id: "other-plan", ownerKey: "cli:other:other", title: "Private Plan", status: "running", taskCount: 1, succeeded: 0, failed: 0, cancelled: 0, verified: 0, correctiveAttempts: 0, createdAt: 1 },
	];
	const ledger = {
		record() {}, transition() {}, recordRun() {}, transitionRun() {},
		queryTasks(query) { return tasks.filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id)); },
		queryTaskPlans(query) { return plans.filter((plan) => query.ownerKeys.includes(plan.ownerKey) && (!query.id || plan.id === query.id)); },
		taskRuns(taskId) { return [{ id: "run", taskId, executor: "subagent", status: "succeeded", startedAt: 1, finishedAt: 2 }]; },
	};
	const tools = new Map(createTaskLedgerTools(ledger, { ...source, threadId: "topic" }).map((tool) => [tool.name, tool]));
	const listed = await tools.get("task_list").execute("list", {});
	assert.match(listed.content[0].text, /Thread task/);
	assert.match(listed.content[0].text, /Profile task/);
	assert.doesNotMatch(listed.content[0].text, /Private/);
	const listedPlans = await tools.get("task_plan_list").execute("plans", {});
	assert.match(listedPlans.content[0].text, /Owned Plan/);
	assert.doesNotMatch(listedPlans.content[0].text, /Private Plan/);
	await assert.rejects(() => tools.get("task_plan_get").execute("plan", { id: "other-plan" }), /not found/i);
	await assert.rejects(() => tools.get("task_runs").execute("runs", { id: "other" }), /not found/i);
});

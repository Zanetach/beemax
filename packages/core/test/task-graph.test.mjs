import assert from "node:assert/strict";
import test from "node:test";
import { createTaskOrchestrationTools, TaskGraph } from "../dist/index.js";

function memoryLedger() {
	const tasks = new Map();
	const dependencies = [];
	const runs = new Map();
	return {
		tasks, dependencies, runs,
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); },
		recordRun(run) { runs.set(run.id, { ...run }); }, transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); },
		renewTaskRunLease(id, leaseExpiresAt) { const run = runs.get(id); if (!run || run.status !== "running") return false; run.leaseExpiresAt = leaseExpiresAt; return true; },
		recordPlan(records, edges) { for (const task of records) this.record(task); dependencies.push(...edges); },
		queryTasks(query) { return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.statuses || query.statuses.includes(task.status)) && (!query.planIds || query.planIds.includes(task.planId))); },
		taskRuns() { return []; },
		taskDependencies(ids) { return dependencies.filter((edge) => ids.includes(edge.taskId)); },
	};
}

test("TaskGraph runs ready Tasks in parallel and waits for all dependencies", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({
		id: "release-plan",
		ownerKey: "cli:local:local",
		tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }],
		dependencies: [{ taskId: "c", dependsOn: "a" }, { taskId: "c", dependsOn: "b" }],
	});
	ledger.record({ id: "unrelated", ownerKey: "cli:local:local", kind: "objective", title: "Unrelated", status: "pending", planId: "other-plan", createdAt: 1 });
	let running = 0;
	let maxRunning = 0;
	const completed = new Set();
	const result = await graph.run(["cli:local:local"], "release-plan", async (task) => {
		if (task.id === "c") assert.deepEqual([...completed].sort(), ["a", "b"]);
		running++; maxRunning = Math.max(maxRunning, running);
		await new Promise((resolve) => setImmediate(resolve));
		running--; completed.add(task.id);
		return { output: `done:${task.id}` };
	}, { maxConcurrent: 2 });
	assert.equal(maxRunning, 2);
	assert.deepEqual(result, { succeeded: 3, failed: 0, cancelled: 0, blocked: [] });
	assert.equal(ledger.tasks.get("unrelated").status, "pending");
});

test("TaskGraph renews an active Task Run lease until execution reaches a terminal state", async () => {
	const ledger = memoryLedger();
	let renewals = 0;
	const renew = ledger.renewTaskRunLease.bind(ledger);
	ledger.renewTaskRunLease = (id, expiresAt) => { renewals++; return renew(id, expiresAt); };
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "lease-plan", ownerKey: "cli:local:local", tasks: [{ id: "leased", title: "Leased" }] });
	await graph.run(["cli:local:local"], "lease-plan", async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
		return { output: "done" };
	}, { leaseMs: 1_000, leaseHeartbeatMs: 5 });
	assert.ok(renewals >= 2);
	const afterCompletion = renewals;
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(renewals, afterCompletion);
});

test("TaskGraph fails execution when its Task Run lease can no longer be renewed", async () => {
	const ledger = memoryLedger();
	ledger.renewTaskRunLease = () => false;
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "lost-lease", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task" }] });
	const result = await graph.run(["cli:local:local"], "lost-lease", async (_task, signal) => new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	}), { leaseMs: 1_000, leaseHeartbeatMs: 5 });
	assert.deepEqual(result, { succeeded: 0, failed: 1, cancelled: 0, blocked: [] });
	assert.match(ledger.tasks.get("task").error, /Lease could not be renewed/);
});

test("TaskGraph only succeeds when an independent verifier accepts the result", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "verified-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task", acceptanceCriteria: "Cites one primary source" }] });
	const rejected = await graph.run(["cli:local:local"], "verified-plan", async () => ({ output: "Unsupported claim" }), {
		verify: async (_task, result) => {
			assert.equal(result.output, "Unsupported claim");
			return { accepted: false, feedback: "No primary source was cited" };
		},
	});
	assert.deepEqual(rejected, { succeeded: 0, failed: 1, cancelled: 0, blocked: [] });
	assert.equal(ledger.tasks.get("task").status, "failed");
	assert.match(ledger.tasks.get("task").error, /No primary source was cited/);
});

test("TaskGraph persists accepted verification evidence with the successful Task", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "accepted-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task", acceptanceCriteria: "Contains a checked fact" }] });
	const result = await graph.run(["cli:local:local"], "accepted-plan", async () => ({ output: "checked" }), {
		verify: async () => ({ accepted: true, evidence: "ACCEPT\nPrimary record checked" }),
	});
	assert.deepEqual(result, { succeeded: 1, failed: 0, cancelled: 0, blocked: [] });
	assert.equal(ledger.tasks.get("task").evidence, "ACCEPT\nPrimary record checked");
});

test("TaskGraph fails closed when criteria exist but no verifier is available", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "unverified-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task", acceptanceCriteria: "Produces evidence" }] });
	const result = await graph.run(["cli:local:local"], "unverified-plan", async () => ({ output: "done" }));
	assert.deepEqual(result, { succeeded: 0, failed: 1, cancelled: 0, blocked: [] });
	assert.match(ledger.tasks.get("task").error, /verification unavailable/i);
});

test("TaskGraph rejects cyclic plans before persisting any Task", () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	assert.throws(() => graph.createPlan({
		id: "cycle-plan",
		ownerKey: "cli:local:local",
		tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
		dependencies: [{ taskId: "a", dependsOn: "b" }, { taskId: "b", dependsOn: "a" }],
	}), /cycle/i);
	assert.equal(ledger.tasks.size, 0);
});

test("orchestration tool validates a model-authored DAG and dispatches bounded Sub-Agent work", async () => {
	const ledger = memoryLedger();
	const executed = [];
	const tools = new Map(createTaskOrchestrationTools(ledger, { platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, async (task) => {
		executed.push(task.title);
		return { output: `done:${task.title}` };
	}, { maxConcurrent: 2, verify: async () => ({ accepted: true }) }).map((tool) => [tool.name, tool]));
	const output = await tools.get("task_plan_execute").execute("plan", {
		tasks: [{ key: "research", title: "Research", goal: "Collect evidence", acceptanceCriteria: "Includes one source" }, { key: "write", title: "Write", goal: "Use the evidence", acceptanceCriteria: "Uses the collected evidence" }],
		dependencies: [{ task: "write", dependsOn: "research" }],
	});
	assert.deepEqual(executed, ["Research", "Write"]);
	assert.match(output.content[0].text, /"succeeded": 2/);
	assert.equal(tools.get("task_plan_execute").beemaxPolicy.approval, "never");
});

test("TaskGraph cancellation stops active work and cancels nodes that have not started", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "cancel-plan", ownerKey: "cli:local:local", tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }], dependencies: [{ taskId: "b", dependsOn: "a" }] });
	const controller = new AbortController();
	const running = graph.run(["cli:local:local"], "cancel-plan", async (_task, signal) => new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
	}), { signal: controller.signal, executor: "subagent" });
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new Error("stopped"));
	assert.deepEqual(await running, { succeeded: 0, failed: 0, cancelled: 2, blocked: [] });
});

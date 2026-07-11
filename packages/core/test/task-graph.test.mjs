import assert from "node:assert/strict";
import test from "node:test";
import { createTaskOrchestrationTools, TaskGraph } from "../dist/index.js";

function memoryLedger() {
	const tasks = new Map();
	const dependencies = [];
	return {
		tasks, dependencies,
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); },
		recordRun() {}, transitionRun() {},
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
	}, { maxConcurrent: 2 }).map((tool) => [tool.name, tool]));
	const output = await tools.get("task_plan_execute").execute("plan", {
		tasks: [{ key: "research", title: "Research", goal: "Collect evidence" }, { key: "write", title: "Write", goal: "Use the evidence" }],
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

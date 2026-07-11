import assert from "node:assert/strict";
import test from "node:test";
import { createTaskLedgerTools, createTaskOrchestrationTools, TaskGraph, TaskPlanRuntime } from "../dist/index.js";

function memoryLedger() {
	const tasks = new Map();
	const dependencies = [];
	const runs = new Map();
	const plans = new Map();
	return {
		tasks, dependencies, runs, plans,
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); }, transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		renewTaskRunLease(id, leaseExpiresAt) { const run = runs.get(id); if (!run || run.status !== "running") return false; run.leaseExpiresAt = leaseExpiresAt; return true; },
		recordPlan(records, edges, plan) { for (const task of records) this.record(task); dependencies.push(...edges); if (plan) plans.set(plan.id, { ...plan }); },
		transitionPlan(id, change) { plans.set(id, { ...plans.get(id), ...change }); return true; },
		queryTaskPlans(query) { return [...plans.values()].filter((plan) => query.ownerKeys.includes(plan.ownerKey) && (!query.id || plan.id === query.id) && (!query.statuses || query.statuses.includes(plan.status))); },
		queryTasks(query) { return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id) && (!query.statuses || query.statuses.includes(task.status)) && (!query.planIds || query.planIds.includes(task.planId))); },
		taskRuns() { return []; },
		taskDependencies(ids) { return dependencies.filter((edge) => ids.includes(edge.taskId)); },
		checkpointTask(ownerKey, taskId, checkpoint, now = Date.now()) { const task = tasks.get(taskId); if (!task || task.ownerKey !== ownerKey || task.status !== "running") return false; tasks.set(taskId, { ...task, checkpoint, checkpointAt: now }); return true; },
		advanceTaskRoute(ownerKey, taskId, error) { const task = tasks.get(taskId); if (!task || task.ownerKey !== ownerKey || task.status !== "running" || !task.routes?.[task.routeIndex + 1]) return false; tasks.set(taskId, { ...task, status: "pending", routeIndex: task.routeIndex + 1, error }); return true; },
		pauseTaskPlan() { return false; }, resumeTaskPlan() { return false; },
	};
}

test("a delegated Sub-Agent can checkpoint only its bound Task", async () => {
	const ledger = memoryLedger();
	ledger.record({ id: "bound", ownerKey: "feishu:chat#thread:user", kind: "delegated", title: "Bound", status: "running", createdAt: 1 });
	ledger.record({ id: "other", ownerKey: "feishu:chat#thread:user", kind: "delegated", title: "Other", status: "running", createdAt: 1 });
	const source = { platform: "feishu", chatId: "chat", chatType: "thread", userId: "user", threadId: "__subagent:bound", delegatedTask: { id: "bound", ownerKey: "feishu:chat#thread:user" } };
	const tools = new Map(createTaskLedgerTools(ledger, source).map((tool) => [tool.name, tool]));
	await tools.get("task_checkpoint_save").execute("save", { id: "bound", checkpoint: "milestone one" });
	assert.equal(ledger.tasks.get("bound").checkpoint, "milestone one");
	await assert.rejects(() => tools.get("task_checkpoint_save").execute("escape", { id: "other", checkpoint: "not allowed" }), /bound Task/i);
	await assert.rejects(() => tools.get("task_checkpoint_save").execute("secret", { id: "bound", checkpoint: "OPENAI_API_KEY=must-not-persist" }), /credential|secret|sensitive/i);
});

test("TaskPlanRuntime starts durable work without blocking the caller and remains cancellable", async () => {
	const runtime = new TaskPlanRuntime();
	let observedAbort = false;
	const started = runtime.start("owner", "background", async (signal) => {
		if (signal.aborted) { observedAbort = true; return; }
		await new Promise((resolve) => signal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true }));
	});
	assert.equal(started, true);
	assert.deepEqual(runtime.snapshot(), { active: 1 });
	assert.equal(runtime.cancel(["owner"], "background"), 1);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(observedAbort, true);
	assert.deepEqual(runtime.snapshot(), { active: 0 });
});

test("TaskPlanRuntime shutdown aborts and drains supervised background work", async () => {
	const runtime = new TaskPlanRuntime();
	let drained = false;
	runtime.start("owner", "shutdown", async (signal) => {
		if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		drained = true;
	});
	await runtime.shutdown();
	assert.equal(drained, true);
	assert.deepEqual(runtime.snapshot(), { active: 0 });
});

test("TaskPlanRuntime reports background failures without an unhandled rejection", async () => {
	const failures = [];
	const runtime = new TaskPlanRuntime((event) => failures.push(event));
	runtime.start("owner", "failed", async () => { throw new Error("executor failed"); });
	await runtime.shutdown();
	assert.equal(failures.length, 1);
	assert.equal(failures[0].planId, "failed");
	assert.match(failures[0].error.message, /executor failed/);
});

test("TaskPlanRuntime durable claims prevent two runtimes from executing one Plan", async () => {
	let holder;
	const ledger = {
		claimTaskPlanExecution(_owner, _plan, candidate) { if (holder) return false; holder = candidate; return true; },
		releaseTaskPlanExecution(_owner, _plan, candidate) { if (holder !== candidate) return false; holder = undefined; return true; },
	};
	const first = new TaskPlanRuntime();
	const second = new TaskPlanRuntime();
	let executions = 0;
	first.startClaimed(ledger, "owner", "claimed", async (signal) => { executions++; if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); });
	second.startClaimed(ledger, "owner", "claimed", async () => { executions++; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(executions, 1);
	await Promise.all([first.shutdown(), second.shutdown()]);
});

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
	const plan = ledger.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: "release-plan" })[0];
	assert.equal(plan.status, "succeeded");
	assert.equal(plan.taskCount, 3);
	assert.equal(plan.succeeded, 3);
	assert.equal(plan.failed, 0);
	assert.equal(plan.verified, 0);
	assert.ok(plan.startedAt >= plan.createdAt);
	assert.ok(plan.finishedAt >= plan.startedAt);
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

test("TaskGraph records Verification as unavailable when the verifier fails", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "verifier-failure-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task", acceptanceCriteria: "Passes an independent check" }] });
	const result = await graph.run(["cli:local:local"], "verifier-failure-plan", async () => ({ output: "candidate" }), {
		verify: async () => { throw new Error("verification provider unavailable"); },
	});
	assert.deepEqual(result, { succeeded: 0, failed: 1, cancelled: 0, blocked: [] });
	assert.equal(ledger.tasks.get("task").verificationStatus, "unavailable");
	assert.equal(ledger.tasks.get("task").result, undefined);
	assert.equal(ledger.tasks.get("task").candidateResult, "candidate");
	assert.match(ledger.tasks.get("task").error, /verification provider unavailable/);
	const failedRun = [...ledger.runs.values()][0];
	assert.deepEqual({ status: failedRun.status, output: failedRun.output }, { status: "failed", output: "candidate" });
	assert.equal(ledger.plans.get("verifier-failure-plan").status, "failed");
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

test("TaskGraph gives a dependent Task the verified results of its direct dependencies", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({
		id: "context-plan", ownerKey: "cli:local:local",
		tasks: [{ id: "research", title: "Research" }, { id: "write", title: "Write" }],
		dependencies: [{ taskId: "write", dependsOn: "research" }],
	});
	let dependencyContext;
	const result = await graph.run(["cli:local:local"], "context-plan", async (task, _signal, context) => {
		if (task.id === "write") dependencyContext = context.dependencies;
		if (task.id === "write") assert.deepEqual(context.dependencies, [{ id: "research", title: "Research", result: "verified evidence", evidence: undefined }]);
		return { output: task.id === "research" ? "verified evidence" : "final answer" };
	});
	assert.deepEqual(result, { succeeded: 2, failed: 0, cancelled: 0, blocked: [] });
	assert.equal(dependencyContext.length, 1);
});

test("TaskGraph makes one bounded Corrective Attempt after Verification rejection", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "correction-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task", acceptanceCriteria: "Cites a source" }] });
	const contexts = [];
	const result = await graph.run(["cli:local:local"], "correction-plan", async (_task, _signal, context) => {
		contexts.push(context);
		return { output: context.attempt === 1 ? "unsupported" : "supported [source]" };
	}, {
		maxCorrectiveAttempts: 1,
		verify: async (_task, candidate) => candidate.output?.includes("[source]")
			? { accepted: true, evidence: "source checked" }
			: { accepted: false, feedback: "Add a primary source" },
	});
	assert.deepEqual(result, { succeeded: 1, failed: 0, cancelled: 0, blocked: [] });
	assert.equal(contexts.length, 2);
	assert.equal(contexts[0].attempt, 1);
	assert.equal(contexts[0].verificationFeedback, undefined);
	assert.equal(contexts[0].previousResult, undefined);
	assert.equal(contexts[1].attempt, 2);
	assert.equal(contexts[1].verificationFeedback, "Add a primary source");
	assert.equal(contexts[1].previousResult, "unsupported");
	assert.equal(ledger.runs.size, 2);
	assert.deepEqual([...ledger.runs.values()].map((run) => run.status).sort(), ["failed", "succeeded"]);
	assert.equal(ledger.tasks.get("task").verificationStatus, "accepted");
	assert.equal(ledger.tasks.get("task").verificationFeedback, undefined);
	assert.equal(ledger.tasks.get("task").correctiveAttempts, 1);
});

test("TaskGraph stops after the configured Corrective Attempt budget is exhausted", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "bounded-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task", acceptanceCriteria: "Passes the check" }] });
	let executions = 0;
	const result = await graph.run(["cli:local:local"], "bounded-plan", async () => { executions++; return { output: "still wrong" }; }, {
		maxCorrectiveAttempts: 1,
		verify: async () => ({ accepted: false, feedback: "Still wrong" }),
	});
	assert.deepEqual(result, { succeeded: 0, failed: 1, cancelled: 0, blocked: [] });
	assert.equal(executions, 2);
	assert.equal(ledger.runs.size, 2);
	assert.match(ledger.tasks.get("task").error, /Still wrong/);
	assert.equal(ledger.tasks.get("task").verificationStatus, "rejected");
	assert.equal(ledger.tasks.get("task").correctiveAttempts, 1);
});

test("TaskGraph terminalizes downstream Tasks after a Dependency Failure", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({
		id: "failed-chain", ownerKey: "cli:local:local",
		tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }],
		dependencies: [{ taskId: "b", dependsOn: "a" }, { taskId: "c", dependsOn: "b" }],
	});
	const executed = [];
	const result = await graph.run(["cli:local:local"], "failed-chain", async (task) => {
		executed.push(task.id);
		throw new Error("A failed");
	});
	assert.deepEqual(executed, ["a"]);
	assert.deepEqual(result, { succeeded: 0, failed: 3, cancelled: 0, blocked: [] });
	assert.match(ledger.tasks.get("b").error, /Dependency Failure.*a.*failed/i);
	assert.match(ledger.tasks.get("c").error, /Dependency Failure.*b.*failed/i);
	assert.equal(ledger.runs.size, 1);
});

test("TaskGraph fails closed when criteria exist but no verifier is available", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "unverified-plan", ownerKey: "cli:local:local", tasks: [{ id: "task", title: "Task", acceptanceCriteria: "Produces evidence" }] });
	const result = await graph.run(["cli:local:local"], "unverified-plan", async () => ({ output: "done" }));
	assert.deepEqual(result, { succeeded: 0, failed: 1, cancelled: 0, blocked: [] });
	assert.match(ledger.tasks.get("task").error, /verification unavailable/i);
	assert.equal(ledger.tasks.get("task").verificationStatus, "unavailable");
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
		title: "Research and write",
		tasks: [{ key: "research", title: "Research", goal: "Collect evidence", acceptanceCriteria: "Includes one source" }, { key: "examples", title: "Examples", goal: "Collect examples", acceptanceCriteria: "Includes one example" }, { key: "write", title: "Write", goal: "Use the evidence", acceptanceCriteria: "Uses the collected evidence" }],
		dependencies: [{ task: "write", dependsOn: "research" }, { task: "write", dependsOn: "examples" }],
	});
	assert.match(output.content[0].text, /"accepted": true/);
	assert.match(output.content[0].text, /"status": "running"/);
	for (let attempt = 0; attempt < 20 && executed.length < 3; attempt++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(new Set(executed.slice(0, 2)).size, 2);
	assert.equal(executed[2], "Write");
	const planId = output.details.planId;
	assert.equal(ledger.queryTaskPlans({ ownerKeys: ["cli:local:local"], id: planId })[0].status, "succeeded");
	assert.equal(tools.get("task_plan_execute").beemaxPolicy.approval, "never");
	assert.equal(tools.get("task_plan_execute").beemaxPolicy.timeoutMs, 60_000);
	assert.equal(tools.get("task_plan_pause").beemaxPolicy.approval, "never");
	assert.equal(tools.get("task_plan_resume").beemaxPolicy.timeoutMs, 60_000);
});

test("orchestration tool rejects a serial checklist that has no Sub-Agent parallelism", async () => {
	const ledger = memoryLedger();
	const tool = createTaskOrchestrationTools(ledger, { platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, async () => ({ output: "unused" }))[0];
	await assert.rejects(() => tool.execute("plan", {
		title: "Serial checklist",
		tasks: [{ key: "first", title: "First", goal: "First step", acceptanceCriteria: "First complete" }, { key: "second", title: "Second", goal: "Second step", acceptanceCriteria: "Second complete" }],
		dependencies: [{ task: "second", dependsOn: "first" }],
	}), /parallel|directly|independent/i);
	assert.equal(ledger.tasks.size, 0);
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

test("TaskGraph persists checkpoints and switches to the next route after a recoverable failure", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "autonomous", ownerKey: "owner", tasks: [{ id: "work", title: "Work", recoveryPolicy: "safe_retry", idempotencyKey: "autonomous:work", routes: ["primary", "fallback"] }] });
	const seen = [];
	const result = await graph.run(["owner"], "autonomous", async (_task, _signal, context) => {
		seen.push({ route: context.route, checkpoint: context.checkpoint });
		if (context.route === "primary") {
			assert.equal(context.saveCheckpoint("primary evidence collected"), true);
			throw new Error("primary unavailable");
		}
		return { output: `continued from ${context.checkpoint}` };
	});
	assert.deepEqual(seen, [{ route: "primary", checkpoint: undefined }, { route: "fallback", checkpoint: "primary evidence collected" }]);
	assert.deepEqual(result, { succeeded: 1, failed: 0, cancelled: 0, blocked: [] });
	assert.equal(ledger.queryTasks({ ownerKeys: ["owner"], id: "work" })[0].result, "continued from primary evidence collected");
});

test("TaskGraph refuses to persist credential material as a checkpoint", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "safe-checkpoint", ownerKey: "owner", tasks: [{ id: "work", title: "Work" }] });
	await graph.run(["owner"], "safe-checkpoint", async (_task, _signal, context) => {
		assert.equal(context.saveCheckpoint("Bearer abcdefghijklmnopqrstuvwxyz"), false);
		return { output: "done" };
	});
	assert.equal(ledger.tasks.get("work").checkpoint, undefined);
});

test("TaskGraph redacts credential material from durable failure details", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "safe-error", ownerKey: "owner", tasks: [{ id: "work", title: "Work" }] });
	await graph.run(["owner"], "safe-error", async () => { throw new Error('{"password":"must-not-persist"}'); });
	assert.equal(ledger.tasks.get("work").error, "[credential details redacted]");
});

test("TaskGraph changes route after correction cannot satisfy final Acceptance Criteria", async () => {
	const ledger = memoryLedger();
	const graph = new TaskGraph(ledger);
	graph.createPlan({ id: "quality-route", ownerKey: "owner", tasks: [{ id: "work", title: "Work", acceptanceCriteria: "accepted", recoveryPolicy: "safe_retry", idempotencyKey: "quality-route:work", routes: ["primary", "fallback"] }] });
	const routes = [];
	const result = await graph.run(["owner"], "quality-route", async (_task, _signal, context) => { routes.push(context.route); return { output: context.route }; }, {
		verify: async (_task, output) => output.output === "fallback" ? { accepted: true, evidence: "fallback accepted" } : { accepted: false, feedback: "primary incomplete" },
	});
	assert.deepEqual(routes, ["primary", "fallback"]);
	assert.deepEqual(result, { succeeded: 1, failed: 0, cancelled: 0, blocked: [] });
});

test("orchestration enforces the active planning Sub-Agent and concurrency budgets", async () => {
	const ledger = memoryLedger();
	let running = 0;
	let peak = 0;
	const decision = { mode: "dag", suggestedConcurrency: 1, budget: { maxSubagents: 2, maxToolCalls: 20, maxTokens: 20_000, maxCorrectiveAttempts: 0 }, signals: { complexity: 6, independentWorkItems: 2, requiresResearch: true, requiresVerification: true, requestsParallelism: true }, reason: "test", directive: () => "test" };
	const tool = createTaskOrchestrationTools(ledger, { platform: "cli", chatId: "budget", chatType: "dm", userId: "local" }, async (task) => {
		running++; peak = Math.max(peak, running);
		await new Promise((resolve) => setTimeout(resolve, 5));
		running--;
		return { output: task.title };
	}, { maxConcurrent: 5, planningDecision: () => decision, verify: async () => ({ accepted: true }) })[0];
	const task = (key) => ({ key, title: key, goal: `Complete ${key}`, acceptanceCriteria: `${key} is complete` });
	await assert.rejects(() => tool.execute("over-budget", { title: "Too large", tasks: [task("one"), task("two"), task("three")] }), /Sub-Agent budget \(2\)/);
	assert.equal(ledger.tasks.size, 0);
	await tool.execute("admitted", { title: "Bounded", tasks: [task("one"), task("two")] });
	assert.equal(peak, 1);
});

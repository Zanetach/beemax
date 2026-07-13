import assert from "node:assert/strict";
import test from "node:test";
import { createTaskOrchestrationTools, responsibilityOwnerKey, TaskGraph } from "../dist/index.js";

test("one channel-neutral Task contract preserves responsibility across trusted channel identities", async () => {
	const cli = { platform: "cli", chatId: "local", chatType: "dm", userId: "local", userIdAlt: "employee-7" };
	const feishu = { platform: "feishu", chatId: "oc-chat", chatType: "dm", userId: "ou-app", userIdAlt: "employee-7" };
	const records = [];
	const plans = [];
	const ledger = {
		recordPlan: (tasks, _dependencies, plan) => { records.push(...tasks); plans.push(plan); },
		queryTasks: ({ ownerKeys, id }) => records.filter((task) => ownerKeys.includes(task.ownerKey) && (!id || task.id === id)),
		queryTaskPlans: ({ ownerKeys }) => plans.filter((plan) => ownerKeys.includes(plan.ownerKey)),
		transition: () => true,
		transitionRun: () => true,
		recordRun: () => undefined,
		taskRuns: () => [],
	};
	const tools = createTaskOrchestrationTools(ledger, cli, async () => ({ output: "done" }), { maxConcurrent: 2 });
	const execute = tools.find((tool) => tool.name === "task_plan_execute");
	await execute.execute("call", { title: "Cross-channel work", tasks: [
		{ key: "a", title: "Evidence A", goal: "Collect independent source A with enough detail to verify the claim", acceptanceCriteria: "A primary source is recorded" },
		{ key: "b", title: "Evidence B", goal: "Collect independent source B with enough detail to verify the claim", acceptanceCriteria: "A second source is recorded" },
	] });
	assert.equal(plans[0].ownerKey, responsibilityOwnerKey(feishu));
	assert.equal(records.every((task) => task.ownerKey === responsibilityOwnerKey(feishu)), true);
});

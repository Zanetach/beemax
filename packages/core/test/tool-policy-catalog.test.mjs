import test from "node:test";
import assert from "node:assert/strict";
import { createAutomationTools, createExecutionTools, createSkillTools, createSubagentTools, createWebTools, SubagentManager, ToolPolicyRegistry } from "../dist/index.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("automation, Skill, and Sub-Agent capabilities publish first-class execution policies", () => {
	const automation = createAutomationTools({}, source, () => undefined);
	assert.equal(policy(automation, "schedule_list").approval, "never");
	assert.equal(policy(automation, "schedule_get").sideEffect, "none");
	assert.equal(policy(automation, "schedule_status").approval, "never");
	assert.equal(policy(automation, "schedule_create").sideEffect, "local");
	assert.equal(policy(automation, "schedule_update").approval, "always");
	assert.equal(policy(automation, "schedule_run_now").sideEffect, "local");
	assert.equal(policy(automation, "schedule_delete").reversible, false);

	const skills = createSkillTools("/tmp/beemax-policy-test", () => undefined);
	assert.equal(policy(skills, "skill_read").approval, "never");
	assert.equal(policy(skills, "skill_create").risk, "high");
	assert.equal(policy(skills, "skill_update").maxAttempts, 1);

	const manager = new SubagentManager({ execute: async () => "done" });
	const tasks = createSubagentTools(manager, source);
	assert.equal(policy(tasks, "task_spawn").approval, "never");
	assert.equal(policy(tasks, "task_spawn").maxAttempts, 1);
	assert.equal(policy(tasks, "task_wait").timeoutMs, 130_000);
});

test("public web research capabilities publish first-class read-only policies", () => {
	const tools = createWebTools();
	for (const name of ["web_search", "agent_reach_search", "web_extract"]) {
		assert.deepEqual(policy(tools, name), {
			risk: "low",
			sideEffect: "none",
			approval: "never",
			reversible: true,
			timeoutMs: 60_000,
			maxAttempts: 2,
			maxResultBytes: 128 * 1024,
			impact: "Reads public web data without changing local or external state",
		});
	}
});

test("execution backend replacements explicitly preserve built-in safety policy", () => {
	const tools = createExecutionTools(source, "/workspace", { execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => undefined });
	assert.equal(policy(tools, "read").approval, "never");
	assert.equal(policy(tools, "read").sideEffect, "none");
	assert.equal(policy(tools, "bash").approval, "always");
	assert.equal(policy(tools, "bash").sideEffect, "local");
	assert.equal(policy(tools, "write").approval, "always");
});

test("an unannotated custom tool cannot silently inherit or replace a known built-in policy", () => {
	assert.throws(
		() => new ToolPolicyRegistry([{ name: "web_search", description: "Search", parameters: {}, execute: async () => ({ content: [], details: {} }) }]),
		/duplicates a built-in capability without declaring beemaxPolicy/,
	);
});

function policy(tools, name) {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool?.beemaxPolicy, `${name} must declare beemaxPolicy`);
	return tool.beemaxPolicy;
}

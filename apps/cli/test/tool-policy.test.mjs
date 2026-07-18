import assert from "node:assert/strict";
import test from "node:test";
import { mainAgentTools, readOnlyAgentTools, subagentExecutionTools } from "../dist/gateway.js";

test("shared read-only policy includes Exa web search for every session type", () => {
	const mcpTools = ["mcp_read"];
	const subagentTools = readOnlyAgentTools(mcpTools);
	const automationTools = readOnlyAgentTools(mcpTools, ["schedule_list"]);
	const mainTools = mainAgentTools("safe", mcpTools);

	for (const tools of [subagentTools, automationTools, mainTools]) {
		assert.ok(tools.includes("exa_web_search"));
		assert.ok(tools.includes("web_search"));
		assert.ok(tools.includes("web_extract"));
		assert.ok(tools.includes("mcp_read"));
	}
	assert.ok(automationTools.includes("schedule_list"));
	assert.ok(mainTools.includes("task_plan_status"));
	assert.equal(mainTools.includes("task_plan_execute"), false);
	assert.ok(mainAgentTools("standard", mcpTools).includes("task_plan_execute"));
	assert.ok(mainAgentTools("standard", mcpTools).includes("task_plan_pause"));
	assert.ok(mainAgentTools("standard", mcpTools).includes("task_plan_resume"));
	assert.ok(readOnlyAgentTools(mcpTools, ["task_checkpoint_save"]).includes("task_checkpoint_save"));
	assert.ok(mainAgentTools("safe", mcpTools).includes("capability_discover"));
	assert.equal(mainAgentTools("safe", mcpTools).includes("capability_acquire"), false);
	assert.ok(mainAgentTools("standard", mcpTools).includes("capability_acquire"));
	assert.equal(mainAgentTools("safe", mcpTools).includes("skill_candidate_install"), false);
	assert.ok(mainAgentTools("standard", mcpTools).includes("skill_candidate_promote"));
	assert.ok(mainAgentTools("safe", mcpTools).includes("skill_versions"));
	assert.ok(mainAgentTools("safe", mcpTools).includes("artifact_verify"));
	assert.ok(mainAgentTools("safe", mcpTools).includes("artifact_inspect"));
	assert.ok(readOnlyAgentTools(mcpTools).includes("artifact_inspect"));
	assert.equal(mainAgentTools("safe", mcpTools).includes("artifact_render"), false);
	assert.ok(mainAgentTools("standard", mcpTools).includes("artifact_render"));
	assert.equal(mainAgentTools("safe", mcpTools).includes("skill_rollback"), false);
	assert.ok(mainAgentTools("standard", mcpTools).includes("skill_rollback"));
});

test("Sub-Agent execution can progressively discover read-only capabilities without acquiring or mutating them", () => {
	const tools = subagentExecutionTools(["mcp_read"]);

	for (const expected of [
		"capability_discover", "task_checkpoint_save", "web_search", "web_extract", "mcp_read",
		"skill_read", "skill_activate", "skill_route", "skill_resource_read", "skill_complete",
	]) {
		assert.ok(tools.includes(expected), `expected ${expected}`);
	}
	for (const forbidden of ["capability_acquire", "verification_submit", "bash", "write", "edit"]) {
		assert.equal(tools.includes(forbidden), false, `did not expect ${forbidden}`);
	}
});

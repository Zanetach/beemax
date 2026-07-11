import assert from "node:assert/strict";
import test from "node:test";
import { mainAgentTools, readOnlyAgentTools } from "../dist/gateway.js";

test("shared read-only policy includes Agent-Reach for every session type", () => {
	const mcpTools = ["mcp_read"];
	const subagentTools = readOnlyAgentTools(mcpTools);
	const automationTools = readOnlyAgentTools(mcpTools, ["schedule_list"]);
	const mainTools = mainAgentTools("safe", mcpTools);

	for (const tools of [subagentTools, automationTools, mainTools]) {
		assert.ok(tools.includes("agent_reach_search"));
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
	assert.equal(mainAgentTools("safe", mcpTools).includes("skill_candidate_install"), false);
	assert.ok(mainAgentTools("standard", mcpTools).includes("skill_candidate_promote"));
});

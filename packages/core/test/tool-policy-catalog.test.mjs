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

test("public web research Tools expose unified Provider configuration and health metadata", async () => {
	const tools = new Map(createWebTools({ env: {}, agentReachAvailable: false }).map((tool) => [tool.name, tool]));
	const webProviders = tools.get("web_search").providers;
	assert.deepEqual(webProviders.map((provider) => provider.id), ["tavily", "brave", "searxng", "agent-reach"]);
	for (const provider of webProviders) {
		const health = await provider.health(new AbortController().signal);
		assert.equal(health.status, "configuration_required");
		assert.deepEqual(health.missingConfiguration, provider.configuration.required);
	}
	const configured = new Map(createWebTools({ env: { BRAVE_SEARCH_API_KEY: "configured-in-process" } }).map((tool) => [tool.name, tool]));
	const brave = configured.get("web_search").providers.find((provider) => provider.id === "brave");
	const braveHealth = await brave.health(new AbortController().signal);
	assert.equal(braveHealth.status, "unverified");
	assert.match(braveHealth.reason, /execution receipt/);
	const unhealthyAgentReach = new Map(createWebTools({ env: {}, agentReachAvailable: true, agentReachHealth: async () => false }).map((tool) => [tool.name, tool])).get("web_search").providers.find((provider) => provider.id === "agent-reach");
	assert.equal((await unhealthyAgentReach.health(new AbortController().signal)).status, "unhealthy");
	const healthyAgentReach = new Map(createWebTools({ env: {}, agentReachAvailable: true, agentReachHealth: async () => true }).map((tool) => [tool.name, tool])).get("web_search").providers.find((provider) => provider.id === "agent-reach");
	assert.equal((await healthyAgentReach.health(new AbortController().signal)).status, "ready");
});

test("web_search uses an available Agent-Reach Provider when API-key Providers are absent", async () => {
	const verboseHighlights = "Detailed evidence ".repeat(2_000);
	const tools = new Map(createWebTools({
		env: {},
		agentReachAvailable: true,
		agentReachSearch: async () => `Title: Current source\nURL: https://example.com/current\nPublished: 2026-07-15\nHighlights:\n${verboseHighlights}`,
	}).map((tool) => [tool.name, tool]));
	const result = await tools.get("web_search").execute("search", { query: "current evidence", maxResults: 2 }, new AbortController().signal);
	assert.equal(result.isError, false);
	assert.equal(result.details.provider, "agent-reach-exa");
	assert.match(result.content[0].text, /https:\/\/example\.com\/current/);
	assert.ok(result.content[0].text.length < 2_000);
});

test("web_search reroutes a failed configured read-only Provider to healthy Agent-Reach", async () => {
	const tools = new Map(createWebTools({
		env: { TAVILY_API_KEY: "configured" },
		agentReachAvailable: true,
		apiSearch: async () => { throw new Error("configured provider timeout"); },
		agentReachSearch: async () => "Title: Alternate source\nURL: https://example.com/alternate\nPublished: 2026-07-15\nHighlights:\nverified",
	}).map((tool) => [tool.name, tool]));
	const result = await tools.get("web_search").execute("search", { query: "current evidence", maxResults: 1 }, new AbortController().signal);
	assert.equal(result.isError, false);
	assert.equal(result.details.provider, "agent-reach-exa");
	assert.match(result.content[0].text, /alternate/);
	assert.deepEqual(result.details.attempts.map(({ provider, status, reasonCode }) => ({ provider, status, reasonCode })), [
		{ provider: "tavily", status: "failed", reasonCode: "timeout" },
		{ provider: "agent-reach", status: "succeeded", reasonCode: undefined },
	]);
});

test("web_search traverses configured API Providers before Agent-Reach", async () => {
	const attempts = [];
	const tools = new Map(createWebTools({
		env: { TAVILY_API_KEY: "configured", BRAVE_SEARCH_API_KEY: "configured" },
		agentReachAvailable: false,
		apiSearch: async (provider) => {
			attempts.push(provider);
			if (provider === "tavily") throw new Error("expired credential");
			return { provider: "brave", results: [{ title: "Healthy result", url: "https://example.com/healthy", snippet: "verified" }] };
		},
	}).map((tool) => [tool.name, tool]));
	const result = await tools.get("web_search").execute("search", { query: "current evidence", maxResults: 1 }, new AbortController().signal);
	assert.equal(result.isError, false);
	assert.deepEqual(attempts, ["tavily", "brave"]);
	assert.equal(result.details.provider, "brave");
	assert.deepEqual(result.details.attempts.map(({ provider, status, reasonCode }) => ({ provider, status, reasonCode })), [
		{ provider: "tavily", status: "failed", reasonCode: "authentication" },
		{ provider: "brave", status: "succeeded", reasonCode: undefined },
	]);
	assert.ok(result.details.attempts.every(({ durationMs }) => durationMs >= 0));
});

test("web_search traverses an empty configured Provider and preserves its audit attempt", async () => {
	const tools = new Map(createWebTools({
		env: { TAVILY_API_KEY: "configured", BRAVE_SEARCH_API_KEY: "configured" },
		agentReachAvailable: false,
		apiSearch: async (provider) => provider === "tavily"
			? { provider, results: [] }
			: { provider, results: [{ title: "Found", url: "https://example.com/found", snippet: "verified" }] },
	}).map((tool) => [tool.name, tool]));
	const result = await tools.get("web_search").execute("search", { query: "current evidence", maxResults: 1 }, new AbortController().signal);
	assert.equal(result.isError, false);
	assert.equal(result.details.provider, "brave");
	assert.deepEqual(result.details.attempts.map(({ provider, status }) => ({ provider, status })), [
		{ provider: "tavily", status: "empty" },
		{ provider: "brave", status: "succeeded" },
	]);
});

test("web_search redacts Provider credentials from final blockers", async () => {
	const tools = new Map(createWebTools({
		env: { TAVILY_API_KEY: "configured" },
		agentReachAvailable: false,
		apiSearch: async () => { throw new Error("Bearer secret-provider-token-123456789"); },
	}).map((tool) => [tool.name, tool]));
	const result = await tools.get("web_search").execute("search", { query: "current evidence" }, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.doesNotMatch(result.content[0].text, /secret-provider-token/);
});

test("direct Agent-Reach and web extraction failures redact credentials and omit raw URLs from details", async () => {
	const tools = new Map(createWebTools({
		env: {},
		agentReachAvailable: true,
		agentReachSearch: async () => { throw new Error("Bearer secret-provider-token-123456789"); },
	}).map((tool) => [tool.name, tool]));
	const reach = await tools.get("agent_reach_search").execute("reach", { query: "current evidence" }, new AbortController().signal);
	assert.equal(reach.isError, true);
	assert.doesNotMatch(reach.content[0].text, /secret-provider-token/);
	const extract = await tools.get("web_extract").execute("extract", { url: "https://user:secret-password@example.com/report?token=private-value" }, new AbortController().signal);
	assert.equal(extract.isError, true);
	assert.doesNotMatch(JSON.stringify(extract), /secret-password|private-value/);
	assert.deepEqual(extract.details, { status: "failed" });
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

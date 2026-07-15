import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	for (const name of ["web_search", "exa_web_search", "web_extract"]) {
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
	assert.deepEqual(webProviders.map((provider) => provider.id), ["tavily", "brave", "searxng", "exa-mcporter"]);
	assert.deepEqual(webProviders.find((provider) => provider.id === "exa-mcporter").install, { source: "beemax-provider-lock", package: "mcporter", version: "mcporter:0.9.0:lock:7c8ca25b89c4a23618c4385a373660cbf23512d7f461e82f2197c19027a183ec" });
	for (const provider of webProviders.filter((candidate) => candidate.id !== "exa-mcporter")) {
		const health = await provider.health(new AbortController().signal);
		assert.equal(health.status, "configuration_required");
		assert.deepEqual(health.missingConfiguration, provider.configuration.required);
	}
	assert.equal((await webProviders.find((provider) => provider.id === "exa-mcporter").health(new AbortController().signal)).status, "unavailable");
	const configured = new Map(createWebTools({ env: { BRAVE_SEARCH_API_KEY: "configured-in-process" } }).map((tool) => [tool.name, tool]));
	const brave = configured.get("web_search").providers.find((provider) => provider.id === "brave");
	const braveHealth = await brave.health(new AbortController().signal);
	assert.equal(braveHealth.status, "unverified");
	assert.match(braveHealth.reason, /execution receipt/);
	const unhealthyAgentReach = new Map(createWebTools({ env: {}, agentReachAvailable: true, agentReachHealth: async () => false }).map((tool) => [tool.name, tool])).get("web_search").providers.find((provider) => provider.id === "exa-mcporter");
	assert.equal((await unhealthyAgentReach.health(new AbortController().signal)).status, "unhealthy");
	const healthyAgentReach = new Map(createWebTools({ env: {}, agentReachAvailable: true, agentReachHealth: async () => true }).map((tool) => [tool.name, tool])).get("web_search").providers.find((provider) => provider.id === "exa-mcporter");
	assert.equal((await healthyAgentReach.health(new AbortController().signal)).status, "ready");
});

test("web_search uses an available exa-mcporter Provider when API-key Providers are absent", async () => {
	const verboseHighlights = "Detailed evidence ".repeat(2_000);
	const tools = new Map(createWebTools({
		env: {},
		agentReachAvailable: true,
		agentReachSearch: async () => `Title: Current source\nURL: https://example.com/current\nPublished: 2026-07-15\nHighlights:\n${verboseHighlights}`,
	}).map((tool) => [tool.name, tool]));
	const result = await tools.get("web_search").execute("search", { query: "current evidence", maxResults: 2 }, new AbortController().signal);
	assert.equal(result.isError, false);
	assert.equal(result.details.provider, "exa-mcporter");
	assert.match(result.content[0].text, /https:\/\/example\.com\/current/);
	assert.ok(result.content[0].text.length < 2_000);
});

test("exa-mcporter subprocess receives only its isolated runtime environment", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-agent-reach-env-"));
	const binary = join(root, "mcporter.js");
	const config = join(root, "mcporter.json");
	try {
		await writeFile(binary, `if (process.env.MODEL_API_KEY || process.env.FEISHU_APP_SECRET || process.env.TAVILY_API_KEY) { console.error("credential leak"); process.exit(9); }\nconsole.log("Title: Isolated source\\nURL: https://example.com/isolated\\nHighlights:\\nverified");\n`);
		await writeFile(config, "{}");
		const tools = new Map(createWebTools({
			env: {
				BEEMAX_AGENT_REACH_MCPORTER: binary,
				BEEMAX_AGENT_REACH_CONFIG: config,
				BEEMAX_AGENT_REACH_HOME: root,
				BEEMAX_AGENT_REACH_PATH: process.env.PATH,
				MODEL_API_KEY: "must-not-leak",
				FEISHU_APP_SECRET: "must-not-leak",
				TAVILY_API_KEY: "must-not-leak",
			},
			agentReachAvailable: true,
		}).map((tool) => [tool.name, tool]));
		const result = await tools.get("exa_web_search").execute("search", { query: "isolation evidence", maxResults: 1 }, new AbortController().signal);
		assert.equal(result.isError, false);
		assert.match(result.content[0].text, /example\.com\/isolated/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("web_search reroutes a failed configured read-only Provider to healthy exa-mcporter", async () => {
	const tools = new Map(createWebTools({
		env: { TAVILY_API_KEY: "configured" },
		agentReachAvailable: true,
		apiSearch: async () => { throw new Error("configured provider timeout"); },
		agentReachSearch: async () => "Title: Alternate source\nURL: https://example.com/alternate\nPublished: 2026-07-15\nHighlights:\nverified",
	}).map((tool) => [tool.name, tool]));
	const result = await tools.get("web_search").execute("search", { query: "current evidence", maxResults: 1 }, new AbortController().signal);
	assert.equal(result.isError, false);
	assert.equal(result.details.provider, "exa-mcporter");
	assert.match(result.content[0].text, /alternate/);
	assert.deepEqual(result.details.attempts.map(({ provider, status, reasonCode }) => ({ provider, status, reasonCode })), [
		{ provider: "tavily", status: "failed", reasonCode: "timeout" },
		{ provider: "exa-mcporter", status: "succeeded", reasonCode: undefined },
	]);
});

test("web Tool Spec availability reflects configured Providers without exposing credentials", () => {
	const unavailable = new Map(createWebTools({ env: {}, agentReachAvailable: false }).map((tool) => [tool.name, tool]));
	assert.deepEqual(unavailable.get("web_search").beemaxToolSpec, { kind: "tool", configured: false, health: "configuration_required", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt" } });
	assert.deepEqual(unavailable.get("exa_web_search").beemaxToolSpec, { kind: "tool", configured: false, health: "configuration_required", ranking: { inputModalities: ["text"], outputModalities: ["text"], freshness: "current", evidence: "source_receipt" } });
	const configured = new Map(createWebTools({ env: { TAVILY_API_KEY: "credential-must-not-appear" }, agentReachAvailable: false }).map((tool) => [tool.name, tool]));
	assert.deepEqual(configured.get("web_search").beemaxToolSpec, { kind: "tool", configured: true, health: "unverified", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt" } });
	assert.doesNotMatch(JSON.stringify(configured.get("web_search").beemaxToolSpec), /credential-must-not-appear/);
});

test("web_search traverses configured API Providers before exa-mcporter", async () => {
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

test("direct exa-mcporter and web extraction failures redact credentials and omit raw URLs from details", async () => {
	const tools = new Map(createWebTools({
		env: {},
		agentReachAvailable: true,
		agentReachSearch: async () => { throw new Error("Bearer secret-provider-token-123456789"); },
	}).map((tool) => [tool.name, tool]));
	const reach = await tools.get("exa_web_search").execute("reach", { query: "current evidence" }, new AbortController().signal);
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

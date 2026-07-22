import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityProviderRuntime, createAutomationTools, createExecutionTools, createSkillTools, createSubagentTools, createWebTools, SubagentManager, ToolPolicyRegistry } from "../dist/index.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("automation, Skill, and Sub-Agent capabilities publish first-class execution policies", () => {
	const automation = createAutomationTools({}, source, () => undefined);
	assert.equal(policy(automation, "schedule_list").sideEffect, "none");
	assert.equal(policy(automation, "schedule_get").sideEffect, "none");
	assert.equal(policy(automation, "schedule_status").sideEffect, "none");
	assert.equal(policy(automation, "schedule_create").sideEffect, "local");
	assert.equal(policy(automation, "schedule_update").risk, "medium");
	assert.equal(policy(automation, "schedule_run_now").sideEffect, "local");
	assert.equal(policy(automation, "schedule_delete").reversible, false);

	const skills = createSkillTools("/tmp/beemax-policy-test", () => undefined);
	assert.equal(policy(skills, "skill_read").sideEffect, "none");
	assert.equal(policy(skills, "skill_create").risk, "high");
	assert.equal(policy(skills, "skill_update").maxAttempts, 1);

	const manager = new SubagentManager({ execute: async () => "done" });
	const tasks = createSubagentTools(manager, source);
	assert.equal(policy(tasks, "task_spawn").risk, "medium");
	assert.equal(policy(tasks, "task_spawn").maxAttempts, 1);
	assert.equal(policy(tasks, "task_wait").timeoutMs, 130_000);
});

test("public web research capabilities publish first-class read-only policies", () => {
	const tools = createWebTools();
	for (const name of ["web_search", "exa_web_search", "web_extract"]) {
		assert.deepEqual(policy(tools, name), {
			risk: "low",
			sideEffect: "none",
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
	assert.deepEqual(webProviders.find((provider) => provider.id === "exa-mcporter").install, { source: "beemax-provider-lock", package: "mcporter", version: "mcporter:0.9.0:lock:428c1aaf7f10ddaad3ed172bac926ef46b0c8e713a874b8574780fdaba705a58" });
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

test("exa-mcporter keeps one MCP Provider identity across general, explicit, and status paths", async () => {
	const tools = new Map(createWebTools({
		env: {},
		agentReachAvailable: true,
		agentReachHealth: async () => true,
	}).map((tool) => [tool.name, tool]));
	const general = tools.get("web_search").providers.find((provider) => provider.id === "exa-mcporter");
	const explicit = tools.get("exa_web_search").providers.find((provider) => provider.id === "exa-mcporter");
	assert.equal(general.kind, "mcp");
	assert.equal(explicit.kind, "mcp");

	const status = await new CapabilityProviderRuntime().resolve({
		capability: "exa_web_search",
		providers: tools.get("exa_web_search").providers,
	});
	assert.equal(status.status, "ready");
	assert.equal(status.selected.kind, "mcp");
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
	assert.match(result.details.sourceReceipt.id, /^source-receipt:sha256:[a-f0-9]{64}$/);
	assert.deepEqual(result.details.sourceReceipt.sourceRefs, ["https://example.com/current"]);
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
				THRUVERA_AGENT_REACH_MCPORTER: binary,
				THRUVERA_AGENT_REACH_CONFIG: config,
				THRUVERA_AGENT_REACH_HOME: root,
				THRUVERA_AGENT_REACH_PATH: process.env.PATH,
				MODEL_API_KEY: "must-not-leak",
				FEISHU_APP_SECRET: "must-not-leak",
				TAVILY_API_KEY: "must-not-leak",
			},
			agentReachAvailable: true,
		}).map((tool) => [tool.name, tool]));
		const result = await tools.get("exa_web_search").execute("search", { query: "isolation evidence", maxResults: 1 }, new AbortController().signal);
		assert.equal(result.isError, false);
		assert.match(result.details.sourceReceipt.id, /^source-receipt:sha256:[a-f0-9]{64}$/);
		assert.deepEqual(result.details.sourceReceipt.sourceRefs, ["https://example.com/isolated"]);
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

test("web_search returns an exact configuration blocker instead of evergreen content when no Provider exists", async () => {
	const tools = new Map(createWebTools({ env: {}, agentReachAvailable: false }).map((tool) => [tool.name, tool]));
	const result = await tools.get("web_search").execute("search", { query: "qx-17 zorb flux" }, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /No search Provider is configured/);
	assert.deepEqual(result.details.attempts, []);
	assert.doesNotMatch(result.content[0].text, /evergreen|general background|best effort/i);
});

test("web_search preserves timeout and offline attempts when every configured route fails", async () => {
	const tools = new Map(createWebTools({
		env: { TAVILY_API_KEY: "configured" },
		agentReachAvailable: true,
		apiSearch: async () => { throw new Error("request timed out after 30s"); },
		agentReachSearch: async () => { throw new Error("network offline"); },
	}).map((tool) => [tool.name, tool]));
	const result = await tools.get("web_search").execute("search", { query: "qx-17 zorb flux" }, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.deepEqual(result.details.attempts.map(({ provider, status, reasonCode }) => ({ provider, status, reasonCode })), [
		{ provider: "tavily", status: "failed", reasonCode: "timeout" },
		{ provider: "exa-mcporter", status: "failed", reasonCode: "provider_unavailable" },
	]);
	assert.match(result.content[0].text, /tavily.*timed out.*Exa\/mcporter fallback failed.*network offline/i);
	assert.doesNotMatch(result.content[0].text, /evergreen|general background|best effort/i);
});

test("web Tool Spec availability reflects configured Providers without exposing credentials", () => {
	const unavailable = new Map(createWebTools({ env: {}, agentReachAvailable: false }).map((tool) => [tool.name, tool]));
	assert.deepEqual(unavailable.get("web_search").beemaxToolSpec, { kind: "tool", configured: false, health: "configuration_required", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt" } });
	assert.deepEqual(unavailable.get("exa_web_search").beemaxToolSpec, { kind: "tool", configured: false, health: "configuration_required", ranking: { inputModalities: ["text"], outputModalities: ["text"], freshness: "current", evidence: "source_receipt" } });
	assert.deepEqual(unavailable.get("exa_web_search").providers.map(({ id, capabilities }) => ({ id, capabilities })), [
		{ id: "exa-mcporter", capabilities: ["web_search", "exa_web_search"] },
	]);
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

test("web_extract binds one validated DNS answer to the outbound request while preserving HTTP and TLS authority", async () => {
	const lookups = [];
	const requests = [];
	const tools = new Map(createWebTools({
		env: {},
		agentReachAvailable: false,
		publicHttp: {
			lookup: async (hostname) => {
				lookups.push(hostname);
				return lookups.length === 1
					? [{ address: "93.184.216.34", family: 4 }]
					: [{ address: "127.0.0.1", family: 4 }];
			},
			request: async (url, options) => {
				requests.push({ url: url.toString(), ...options.destination, hostHeader: options.hostHeader, servername: options.servername });
				return new Response("<html><title>Pinned</title><body>validated body</body></html>", { status: 200, headers: { "content-type": "text/html" } });
			},
		},
	}).map((tool) => [tool.name, tool]));

	const result = await tools.get("web_extract").execute("extract", { url: "https://rebind.example.test/report" }, new AbortController().signal);
	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /validated body/);
	assert.deepEqual(lookups, ["rebind.example.test"]);
	assert.deepEqual(requests, [{
		url: "https://rebind.example.test/report",
		address: "93.184.216.34",
		family: 4,
		hostHeader: "rebind.example.test",
		servername: "rebind.example.test",
	}]);
});

test("SearXNG manually validates every redirect before issuing the next pinned request", async () => {
	const lookups = [];
	const requests = [];
	const tools = new Map(createWebTools({
		env: { SEARXNG_URL: "https://search.example.test/base/" },
		agentReachAvailable: false,
		publicHttp: {
			lookup: async (hostname) => {
				lookups.push(hostname);
				return hostname === "search.example.test"
					? [{ address: "93.184.216.34", family: 4 }]
					: [{ address: "127.0.0.1", family: 4 }];
			},
			request: async (url, options) => {
				requests.push({ url: url.toString(), address: options.destination.address });
				return new Response(null, { status: 302, headers: { location: "https://internal.example.test/results" } });
			},
		},
	}).map((tool) => [tool.name, tool]));

	const result = await tools.get("web_search").execute("search", { query: "current evidence", maxResults: 1 }, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.deepEqual(lookups, ["search.example.test", "internal.example.test"]);
	assert.equal(requests.length, 1);
	assert.match(requests[0].url, /^https:\/\/search\.example\.test\/base\/search\?/u);
	assert.equal(requests[0].address, "93.184.216.34");
});

test("public Web providers bound success and error bodies before parsing or logging them", async () => {
	let successCancelled = false;
	const oversizedSuccess = new ReadableStream({
		start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
		cancel() { successCancelled = true; },
	});
	const successTools = new Map(createWebTools({
		env: { SEARXNG_URL: "https://search.example.test/" },
		agentReachAvailable: false,
		publicHttp: {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			request: async () => new Response(oversizedSuccess, { status: 200, headers: { "content-type": "application/json" } }),
		},
	}).map((tool) => [tool.name, tool]));
	const success = await successTools.get("web_search").execute("search", { query: "bounded", maxResults: 1 }, new AbortController().signal);
	assert.equal(success.isError, true);
	assert.match(success.content[0].text, /exceeds 2097152 bytes/u);
	assert.equal(successCancelled, true);

	let errorCancelled = false;
	const oversizedError = new ReadableStream({
		start(controller) { controller.enqueue(new Uint8Array(4_097)); },
		cancel() { errorCancelled = true; },
	});
	const errorTools = new Map(createWebTools({
		env: {},
		agentReachAvailable: false,
		publicHttp: {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			request: async () => new Response(oversizedError, { status: 502, headers: { "content-type": "text/plain" } }),
		},
	}).map((tool) => [tool.name, tool]));
	const failure = await errorTools.get("web_extract").execute("extract", { url: "https://source.example.test/report" }, new AbortController().signal);
	assert.equal(failure.isError, true);
	assert.match(failure.content[0].text, /HTTP 502/u);
	assert.equal(errorCancelled, true);
});

test("web_extract revalidates a redirect target before issuing the next pinned request", async () => {
	const lookups = [];
	const requests = [];
	const tools = new Map(createWebTools({
		env: {},
		agentReachAvailable: false,
		publicHttp: {
			lookup: async (hostname) => {
				lookups.push(hostname);
				return hostname === "source.example.test"
					? [{ address: "93.184.216.34", family: 4 }]
					: [{ address: "169.254.169.254", family: 4 }];
			},
			request: async (url, options) => {
				requests.push({ url: url.toString(), address: options.destination.address });
				return new Response(null, { status: 302, headers: { location: "http://metadata-hop.example.test/latest/meta-data" } });
			},
		},
	}).map((tool) => [tool.name, tool]));

	const result = await tools.get("web_extract").execute("extract", { url: "https://source.example.test/report" }, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.deepEqual(lookups, ["source.example.test", "metadata-hop.example.test"]);
	assert.deepEqual(requests, [{ url: "https://source.example.test/report", address: "93.184.216.34" }]);
});

test("execution backend replacements explicitly preserve built-in safety policy", () => {
	const tools = createExecutionTools(source, "/workspace", { execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => undefined });
	assert.equal(policy(tools, "read").risk, "low");
	assert.equal(policy(tools, "read").sideEffect, "none");
	assert.equal(policy(tools, "bash").risk, "high");
	assert.equal(policy(tools, "bash").sideEffect, "local");
	assert.equal(policy(tools, "write").risk, "high");
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

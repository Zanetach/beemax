import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createFeishuMeetingTools } from "@beemax/feishu-capability";
import { McpManager } from "@beemax/mcp-capability";
import { filterEligibleSkills, reloadRuntimeResourcesIfNeeded } from "@beemax/core";
import { buildAgentFactory } from "../../../apps/cli/dist/agent-factory.js";
import { createSkillTools } from "@beemax/core";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const hangingMcpFixture = fileURLToPath(new URL("./fixtures/hanging-mcp-server.mjs", import.meta.url));
const environmentMcpFixture = fileURLToPath(new URL("./fixtures/mcp-environment-server.mjs", import.meta.url));

test("Feishu meeting tools publish read, mutation, and destructive policies", () => {
	const tools = new Map(createFeishuMeetingTools(() => undefined).map((tool) => [tool.name, tool]));
	assert.equal(tools.get("feishu_meeting_reserve_active_get").beemaxPolicy.sideEffect, "none");
	assert.equal(tools.get("feishu_meeting_reserve_create").beemaxPolicy.risk, "medium");
	assert.equal(tools.get("feishu_meeting_end").beemaxPolicy.reversible, false);
});

test("managed skills can evolve without escaping their directory", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-test-"));
	let reloadNeeded = false;
	try {
		const tools = new Map(createSkillTools(join(root, "agent"), () => { reloadNeeded = true; })
			.map((tool) => [tool.name, tool]));
		await tools.get("skill_create").execute("create", {
			name: "weekly-review",
			description: "Prepare a concise verified weekly review: safely",
			instructions: "Collect completed tasks, blockers, and next actions. Verify every result before summarizing.",
		});
		assert.equal(reloadNeeded, true);
		const read = await tools.get("skill_read").execute("read", { name: "weekly-review" });
		assert.match(read.content[0].text, /Collect completed tasks, blockers, and next actions/);
		assert.equal(read.details.descriptor.name, "weekly-review");
		await assert.rejects(() => tools.get("skill_read").execute("bad", { name: "../escape" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi keeps Skill metadata out of the base prompt and hot-reloads the registry", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-reload-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	mkdirSync(join(agentDir, "skills", "existing"), { recursive: true });
	mkdirSync(cwd);
	writeFileSync(join(agentDir, "skills", "existing", "SKILL.md"),
		"---\nname: existing\ndescription: Existing verified workflow\n---\n\n# Existing\n\nFollow the verified workflow.\n");
	const memoryStore = { remember: () => "id", recall: () => [], list: () => [], forget: () => true };
	const factory = buildAgentFactory({
		profileId: "profile:test",
		provider: "anthropic", model: "claude-sonnet-4-5", cwd, agentDir,
		getApiKey: () => "test", memoryStore,
	});
	const session = await factory("skill-test", { platform: "feishu", chatId: "c", chatType: "dm", userId: "u" });
	try {
		assert.doesNotMatch(session.agent.state.systemPrompt, /Existing verified workflow/);
		assert.ok(session.agent.state.tools.some((tool) => tool.name === "capability_discover"));
		const create = session.agent.state.tools.find((tool) => tool.name === "skill_create");
		await create.execute("create", {
			name: "evolved-test",
			description: "A durable evolved test workflow",
			instructions: "Run the verified workflow and report concrete evidence before completion.",
		});
		assert.equal(await reloadRuntimeResourcesIfNeeded(session), true);
		assert.doesNotMatch(session.agent.state.systemPrompt, /A durable evolved test workflow/);
		const discover = session.agent.state.tools.find((tool) => tool.name === "capability_discover");
		const result = await discover.execute("discover", { query: "evolved-test", topK: 3 });
		assert.equal(result.details.skills[0].name, "evolved-test");
		assert.match(result.content[0].text, /evolved-test/, "the model-visible Tool result must name matching capabilities");
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("MCP tools are discovered, callable, and expose approval-free policies", async () => {
	const manager = new McpManager({ environment: {} });
	try {
		const status = await manager.connectAll({
			servers: { smoke: { type: "stdio", command: process.execPath, args: [fixture], required: true, trustReadOnlyOperations: true } },
		});
		assert.equal(status[0].connected, true);
		assert.equal(status[0].tools.length, 6);
		assert.equal(status[0].resources, 1);
		assert.equal(status[0].prompts, 1);
		const tools = new Map(manager.getTools().map((tool) => [tool.name, tool]));
		assert.deepEqual(tools.get("mcp_smoke_echo").beemaxToolSpec, { kind: "mcp", configured: true, health: "ready" });
		assert.equal(tools.get("mcp_smoke_echo").beemaxPolicy.sideEffect, "none");
		assert.deepEqual(tools.get("mcp_smoke_echo").aliases, ["echo", "smoke echo", "smoke/echo"]);
		assert.equal(tools.get("mcp_smoke_mutate").beemaxPolicy.sideEffect, "external");
		assert.equal("approval" in tools.get("mcp_smoke_mutate").beemaxPolicy, false);
		assert.equal(tools.get("mcp_smoke_resource_read").beemaxPolicy.sideEffect, "none");
		const result = await tools.get("mcp_smoke_echo").execute(
			"echo",
			{ text: "ok" },
			new AbortController().signal,
		);
		assert.equal(result.isError, false);
		assert.match(result.content[0].text, /echo:ok/);
		const resource = await tools.get("mcp_smoke_resource_read").execute("read", { uri: "memo://brief" }, new AbortController().signal);
		assert.match(resource.content[0].text, /Brief resource/);
		const cancelled = new AbortController(); cancelled.abort(new Error("cancelled by caller"));
		await assert.rejects(tools.get("mcp_smoke_resource_read").execute("cancelled-read", { uri: "memo://brief" }, cancelled.signal), /cancel|abort/i);
		const prompt = await tools.get("mcp_smoke_prompt_get").execute("prompt", { name: "brief-template", arguments: { topic: "memory" } }, new AbortController().signal);
		assert.match(prompt.content[0].text, /Brief memory/);
	} finally {
		await manager.close();
	}
});

test("MCP read-only hints fail closed until the Profile explicitly trusts that server", async () => {
	const manager = new McpManager({ environment: {} });
	try {
		await manager.connectAll({
			servers: { untrusted: { type: "stdio", command: process.execPath, args: [fixture], required: true } },
		});
		const tools = new Map(manager.getTools().map((tool) => [tool.name, tool]));
		assert.equal(tools.get("mcp_untrusted_echo").beemaxPolicy.sideEffect, "external");
		assert.equal(tools.get("mcp_untrusted_resource_read").beemaxPolicy.sideEffect, "external");
		assert.equal("approval" in tools.get("mcp_untrusted_echo").beemaxPolicy, false);
	} finally {
		await manager.close();
	}
});

test("MCP initialization times out and degrades optional servers", async () => {
	const manager = new McpManager({ environment: {}, initializationTimeoutMs: 100 });
	const startedAt = Date.now();
	try {
		const status = await manager.connectAll({
			servers: { hanging: { type: "stdio", command: process.execPath, args: [hangingMcpFixture] } },
		});
		assert.equal(status[0].connected, false);
		assert.match(status[0].error, /timed out/);
		assert.ok(Date.now() - startedAt < 750, "timed-out MCP startup must also terminate its child process promptly");
	} finally {
		await manager.close();
	}
});

test("stdio MCP argument expansion and child environment use one immutable caller snapshot", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-mcp-environment-"));
	const previousUser = process.env.USER;
	process.env.USER = "ambient-user-must-not-enter-profile";
	const environment = {
		MCP_FIXTURE: environmentMcpFixture,
		PROFILE_ARG: "profile-argument",
		PROFILE_VALUE: "profile-value",
		PROFILE_SECRET: "profile-secret-must-not-enter-child",
		HOME: join(root, "profile-home"),
	};
	const manager = new McpManager({ environment });
	try {
		environment.MCP_FIXTURE = join(root, "mutated-fixture.mjs");
		environment.PROFILE_ARG = "mutated-argument";
		environment.PROFILE_VALUE = "mutated-value";
		environment.HOME = join(root, "mutated-home");
		const status = await manager.connectAll({
			servers: {
				environment: {
					type: "stdio",
					command: process.execPath,
					args: ["${MCP_FIXTURE}", "${PROFILE_ARG}"],
					cwd: root,
					env: { SERVER_VALUE: "${PROFILE_VALUE}" },
					required: true,
				},
			},
		});
		assert.equal(status[0].connected, true);
		const tool = manager.getTools().find((candidate) => candidate.name === "mcp_environment_runtime_context");
		const result = await tool.execute("context", {}, new AbortController().signal);
		const context = JSON.parse(result.content[0].text);
		assert.deepEqual(context, {
			args: ["profile-argument"],
			cwd: realpathSync(root),
			serverValue: "profile-value",
			home: join(root, "profile-home"),
			user: "",
		});
	} finally {
		await manager.close();
		if (previousUser === undefined) delete process.env.USER;
		else process.env.USER = previousUser;
		rmSync(root, { recursive: true, force: true });
	}
});

test("HTTP MCP URL and headers use the same immutable caller snapshot", async () => {
	let captureRequest;
	const request = new Promise((resolve) => { captureRequest = resolve; });
	const server = createServer((incoming, response) => {
		captureRequest({ url: incoming.url, authorization: incoming.headers.authorization });
		response.writeHead(500, { "content-type": "text/plain" });
		response.end("intentional MCP test failure");
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const previousToken = process.env.MCP_HTTP_TOKEN;
	process.env.MCP_HTTP_TOKEN = "ambient-token-must-not-be-used";
	const environment = {
		MCP_HTTP_PORT: String(address.port),
		MCP_HTTP_PATH: "profile-endpoint",
		MCP_HTTP_TOKEN: "profile-token",
	};
	const manager = new McpManager({ environment, initializationTimeoutMs: 1_000 });
	try {
		environment.MCP_HTTP_PORT = "1";
		environment.MCP_HTTP_PATH = "mutated-endpoint";
		environment.MCP_HTTP_TOKEN = "mutated-token";
		const status = await manager.connectAll({
			servers: {
				http: {
					type: "http",
					url: "http://127.0.0.1:${MCP_HTTP_PORT}/${MCP_HTTP_PATH}",
					headers: { authorization: "Bearer ${MCP_HTTP_TOKEN}" },
				},
			},
		});
		assert.equal(status[0].connected, false);
		assert.deepEqual(await request, { url: "/profile-endpoint", authorization: "Bearer profile-token" });
	} finally {
		await manager.close();
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		if (previousToken === undefined) delete process.env.MCP_HTTP_TOKEN;
		else process.env.MCP_HTTP_TOKEN = previousToken;
	}
});

test("Skill metadata hides unavailable or unsafe Skills before prompt injection", () => {
	const base = { name: "base", description: "Always available", filePath: "/tmp/base/SKILL.md", baseDir: "/tmp/base", sourceInfo: {}, disableModelInvocation: false };
	const standard = { ...base, name: "standard", metadata: { beemax: { toolset: "standard" } } };
	const missingEnv = { ...base, name: "missing-env", metadata: { beemax: { env: ["BEE_MAX_MISSING_FOR_TEST"] } } };
	assert.deepEqual(filterEligibleSkills([base, standard, missingEnv], "safe").map((skill) => skill.name), ["base"]);
	assert.deepEqual(filterEligibleSkills([base, standard, missingEnv], "standard").map((skill) => skill.name), ["base", "standard"]);
});

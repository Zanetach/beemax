import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("Feishu meeting tools publish read, mutation, and destructive policies", () => {
	const tools = new Map(createFeishuMeetingTools(() => undefined).map((tool) => [tool.name, tool]));
	assert.equal(tools.get("feishu_meeting_reserve_active_get").beemaxPolicy.approval, "never");
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
		getApiKey: () => "test", memoryStore, authorizeTool: async () => ({ allowed: true }),
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

test("MCP tools are discovered, callable, and mutating tools require approval", async () => {
	const manager = new McpManager();
	try {
		const status = await manager.connectAll({
			servers: { smoke: { type: "stdio", command: process.execPath, args: [fixture], required: true } },
		});
		assert.equal(status[0].connected, true);
		assert.equal(status[0].tools.length, 6);
		assert.equal(status[0].resources, 1);
		assert.equal(status[0].prompts, 1);
		const tools = new Map(manager.getTools().map((tool) => [tool.name, tool]));
		assert.deepEqual(tools.get("mcp_smoke_echo").beemaxToolSpec, { kind: "mcp", configured: true, health: "ready" });
		assert.equal(tools.get("mcp_smoke_echo").beemaxPolicy.approval, "never");
		assert.deepEqual(tools.get("mcp_smoke_echo").aliases, ["echo", "smoke echo", "smoke/echo"]);
		assert.equal(tools.get("mcp_smoke_mutate").beemaxPolicy.approval, "always");
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

test("MCP initialization times out and degrades optional servers", async () => {
	const manager = new McpManager({ initializationTimeoutMs: 100 });
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

test("Skill metadata hides unavailable or unsafe Skills before prompt injection", () => {
	const base = { name: "base", description: "Always available", filePath: "/tmp/base/SKILL.md", baseDir: "/tmp/base", sourceInfo: {}, disableModelInvocation: false };
	const standard = { ...base, name: "standard", metadata: { beemax: { toolset: "standard" } } };
	const missingEnv = { ...base, name: "missing-env", metadata: { beemax: { env: ["BEE_MAX_MISSING_FOR_TEST"] } } };
	assert.deepEqual(filterEligibleSkills([base, standard, missingEnv], "safe").map((skill) => skill.name), ["base"]);
	assert.deepEqual(filterEligibleSkills([base, standard, missingEnv], "standard").map((skill) => skill.name), ["base", "standard"]);
});

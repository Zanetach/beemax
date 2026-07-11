import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createCodexImageTool } from "@beemax/codex-image-capability";
import { createFeishuMeetingTools } from "@beemax/feishu-capability";
import { McpManager } from "@beemax/mcp-capability";
import { filterEligibleSkills } from "@beemax/core";
import { buildAgentFactory } from "../../../apps/cli/dist/agent-factory.js";
import { createSkillTools } from "@beemax/core";
import { reloadResourcesIfNeeded } from "../dist/core/resource-reload.js";

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
		assert.match(read.content[0].text, /managed-by: beemax/);
		assert.match(read.content[0].text, /description: "Prepare a concise verified weekly review: safely"/);
		await assert.rejects(() => tools.get("skill_read").execute("bad", { name: "../escape" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi discovers managed skills and hot-reloads evolved skills", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-reload-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	mkdirSync(join(agentDir, "skills", "existing"), { recursive: true });
	mkdirSync(cwd);
	writeFileSync(join(agentDir, "skills", "existing", "SKILL.md"),
		"---\nname: existing\ndescription: Existing verified workflow\n---\n\n# Existing\n\nFollow the verified workflow.\n");
	const memoryStore = { remember: () => "id", recall: () => [], list: () => [], forget: () => true };
	const factory = buildAgentFactory({
		provider: "anthropic", model: "claude-sonnet-4-5", cwd, agentDir,
		getApiKey: () => "test", memoryStore, authorizeTool: async () => ({ allowed: true }),
	});
	const session = await factory("skill-test", { platform: "feishu", chatId: "c", chatType: "dm", userId: "u" });
	try {
		assert.match(session.agent.state.systemPrompt, /existing/);
		const create = session.agent.state.tools.find((tool) => tool.name === "skill_create");
		await create.execute("create", {
			name: "evolved-test",
			description: "A durable evolved test workflow",
			instructions: "Run the verified workflow and report concrete evidence before completion.",
		});
		assert.equal(await reloadResourcesIfNeeded(session), true);
		assert.match(session.agent.state.systemPrompt, /evolved-test/);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Codex image generation saves and delivers a PNG without exposing OAuth", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-image-test-"));
	const originalFetch = globalThis.fetch;
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
	const token = `x.${payload}.y`;
	let delivered;
	globalThis.fetch = async (_url, request) => {
		assert.equal(request.headers.Authorization, `Bearer ${token}`);
		assert.equal(request.headers["chatgpt-account-id"], "acct-test");
		const event = { type: "response.output_item.done", item: { type: "image_generation_call", result: Buffer.from("fake-png").toString("base64") } };
		return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { status: 200 });
	};
	try {
		const tool = createCodexImageTool({ platform:"feishu",chatId:"chat",chatType:"dm" }, {
			outputDir: root, quality: "medium", getAccessToken: async () => token,
			mediaOutbox: { enqueueMedia: async (_source, media) => { delivered = media.path; } },
		});
		assert.equal(tool.beemaxPolicy.approval, "always");
		assert.equal(tool.beemaxPolicy.maxAttempts, 1);
		const result = await tool.execute("image", { prompt:"a bee", aspectRatio:"square" }, new AbortController().signal);
		assert.match(result.content[0].text, /queued for delivery/);
		assert.equal(delivered, result.details.path);
		assert.doesNotMatch(JSON.stringify(result), /acct-test|Bearer/);
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(root, { recursive:true, force:true });
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
		assert.equal(tools.get("mcp_smoke_echo").beemaxPolicy.approval, "never");
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
		const prompt = await tools.get("mcp_smoke_prompt_get").execute("prompt", { name: "brief-template", arguments: { topic: "memory" } }, new AbortController().signal);
		assert.match(prompt.content[0].text, /Brief memory/);
	} finally {
		await manager.close();
	}
});

test("MCP initialization times out and degrades optional servers", async () => {
	const manager = new McpManager({ initializationTimeoutMs: 100 });
	try {
		const status = await manager.connectAll({
			servers: { hanging: { type: "stdio", command: process.execPath, args: [hangingMcpFixture] } },
		});
		assert.equal(status[0].connected, false);
		assert.match(status[0].error, /timed out/);
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

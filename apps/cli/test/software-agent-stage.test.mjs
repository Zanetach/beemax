import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	LexicalCapabilityRanker,
	LocalExecutionPort,
	ProgressiveCapabilityRanker,
	createExecutionTools,
	createSkillTools,
} from "@beemax/core";
import { loadConfig, profileTaskGrantCapabilities } from "../dist/config.js";
import { buildMainAgentSystemPrompt } from "../dist/gateway.js";
import { configureSoftwareAgentMode, createProfile } from "../dist/profile-config.js";

const source = { platform: "feishu", chatId: "oc_software", chatType: "dm", userId: "ou_owner" };

test("software Agent mode grants unattended workspace edits without granting shell or external effects", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-software-agent-mode-"));
	try {
		const paths = await createProfile("developer", { home, root: resolve(".") });
		await configureSoftwareAgentMode("developer", { home });
		const config = loadConfig(paths.configPath, "developer");

		assert.equal(config.agent.toolset, "standard");
		assert.equal(config.execution.workspaceWritePolicy, "allow-within-workspace");
		assert.deepEqual(config.execution.taskGrantCapabilities, ["edit"]);
		assert.deepEqual(profileTaskGrantCapabilities(config), ["write", "edit"]);
		assert.equal(profileTaskGrantCapabilities(config).includes("bash"), false);
		assert.match(await readFile(join(paths.homePath, "skills", "software-delivery", "SKILL.md"), "utf8"), /software delivery/i);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("software delivery progressively loads only its implementation route and exposes the coding toolchain", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-software-skill-"));
	try {
		const paths = await createProfile("developer", { home, root: resolve(".") });
		const inventory = ["read", "grep", "find", "ls", "write", "edit"].map((name) => ({
			name,
			description: `${name} workspace capability`,
		}));
		const tools = new Map(createSkillTools(
			paths.homePath,
			() => undefined,
			inventory,
			undefined,
			[],
			undefined,
			new ProgressiveCapabilityRanker(new LexicalCapabilityRanker(), { async rank() { return []; } }),
		).map((tool) => [tool.name, tool]));

		const discovery = await tools.get("capability_discover").execute("discover", {
			query: "开发一个 CRM 系统，运行测试，遇到错误自己定位并修复直到通过",
		});
		assert.deepEqual(discovery.details.skills.map((skill) => skill.name), ["software-delivery"]);

		const selected = await tools.get("skill_read").execute("read", { name: "software-delivery" });
		assert.deepEqual(selected.details.routes.map((route) => route.name), ["implement"]);
		assert.deepEqual(selected.details.activatedTools, ["skill_route", "skill_complete"]);

		const routed = await tools.get("skill_route").execute("route", { route: "implement" });
		assert.deepEqual(routed.details.activatedTools, [
			"skill_resource_read",
			"skill_complete",
			"read",
			"grep",
			"find",
			"ls",
			"write",
			"edit",
		]);
		const module = await tools.get("skill_resource_read").execute("module", { path: "modules/implement.md" });
		assert.match(module.content[0].text, /diagnose/i);
		assert.match(module.content[0].text, /retest/i);
		assert.match(module.content[0].text, /acceptance criteri/i);
		assert.equal((await tools.get("skill_complete").execute("complete", {})).details.state, "completed");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("software delivery tools can reproduce a failure, repair the implementation, and verify the result", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "beemax-software-repair-"));
	try {
		const tools = new Map(createExecutionTools(source, workspace, new LocalExecutionPort()).map((tool) => [tool.name, tool]));
		await tools.get("write").execute("package", {
			path: "package.json",
			content: JSON.stringify({ type: "module", scripts: { test: "node crm.test.js" } }),
		}, new AbortController().signal);
		await tools.get("write").execute("implementation:broken", {
			path: "crm.js",
			content: "export const totalPipeline = (values) => values.reduce((sum, value) => sum - value, 0);\n",
		}, new AbortController().signal);
		await tools.get("write").execute("test", {
			path: "crm.test.js",
			content: "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { totalPipeline } from './crm.js';\ntest('totals CRM pipeline value', () => assert.equal(totalPipeline([12, 8]), 20));\n",
		}, new AbortController().signal);

		const reproduced = await tools.get("bash").execute("test:reproduce", { command: "npm test" }, new AbortController().signal);
		assert.equal(reproduced.isError, true);

		await tools.get("write").execute("implementation:fixed", {
			path: "crm.js",
			content: "export const totalPipeline = (values) => values.reduce((sum, value) => sum + value, 0);\n",
		}, new AbortController().signal);
		const verified = await tools.get("bash").execute("test:verify", { command: "npm test" }, new AbortController().signal);
		assert.equal(verified.isError, false);
		assert.match(verified.content[0].text, /pass 1/i);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("main Agent contract requires evidence-backed repair instead of stopping at a plan or first failure", () => {
	const prompt = buildMainAgentSystemPrompt("You are BeeMax.");
	assert.match(prompt, /inspect.*implement.*test.*diagnose.*repair.*retest/is);
	assert.match(prompt, /Do not stop at a plan/i);
	assert.match(prompt, /verified/i);
});

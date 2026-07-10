import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { configureModel } from "../dist/profile-config.js";
import { runSetup } from "../dist/setup.js";
import { MemoryStore } from "@beemax/memory";

const cli = resolve("apps/cli/dist/cli.js");

test("CLI supports init, model setup, Feishu channel setup, listing, and safe deletion", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-cli-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-home-"));
	const invocationDir = await mkdtemp(join(tmpdir(), "beemax-invoke-"));
	const run = (args, env = {}) => {
		const inherited = { ...process.env };
		for (const key of [
			"BEEMAX_PROFILE", "BEEMAX_PROVIDER", "BEEMAX_MODEL", "BEEMAX_API_KEY", "BEEMAX_DB_PATH",
			"BEEMAX_MCP_CONFIG", "BEEMAX_AGENT_DIR", "BEEMAX_CWD", "FEISHU_APP_ID", "FEISHU_APP_SECRET",
			"FEISHU_ALLOWED_USERS",
		]) delete inherited[key];
		return execFileSync(process.execPath, [cli, ...args], {
			cwd: invocationDir,
			encoding: "utf8",
			env: {
				...inherited,
			BEEMAX_ROOT: root,
			BEEMAX_HOME: home,
				...env,
			},
		});
	};

	assert.match(run(["init", "--profile", "personal"]), /Created BeeMax Agent 'personal'/);
	assert.match(run(["--help"]), /persistent personal agent/);
	assert.match(run(["model", "list"]), /Anthropic/);
	assert.equal(run(["agent", "list"]).trim(), "personal");
	assert.throws(
		() => run(["model", "set", "openrouter", "openai/gpt-5.2", "--profile", "personal", "--api-key", "must-not-appear"]),
		/Do not pass model secrets in argv/,
	);
	assert.match(run(["model", "set", "openrouter", "openai/gpt-5.2", "--profile", "personal", "--non-interactive"], {
		BEEMAX_API_KEY: "model-key",
	}), /Configured openrouter\/openai\/gpt-5.2/);
	const liveMemory = new MemoryStore(join(home, "profiles", "personal", "memory.db"));
	liveMemory.remember({ platform: "feishu", chatId: "chat", userId: "user", role: "memory", content: "Backup must preserve this fact" });
	const backupDir = await mkdtemp(join(tmpdir(), "beemax-backup-"));
	assert.match(run(["profile", "backup", "personal", backupDir]), /SQLite snapshot verified/);
	liveMemory.close();
	const backupMemory = new MemoryStore(join(backupDir, "personal", "memory.db"));
	assert.equal(backupMemory.recall("preserve", { platform: "feishu", chatId: "chat", userId: "user" }).length, 1);
	backupMemory.close();
	assert.match(run(["channel", "add", "feishu", "--profile", "personal", "--non-interactive"], {
		FEISHU_APP_ID: "cli_test",
		FEISHU_APP_SECRET: "feishu-key",
		FEISHU_ALLOWED_USERS: "ou_test",
	}), /Configured Feishu channel/);
	assert.match(run(["channel", "list", "--profile", "personal"]), /feishu  configured/);
	assert.match(run(["mcp", "status", "--profile", "personal"]), /No MCP servers configured/);
	assert.match(run(["memory", "status", "--profile", "personal"]), /curated=1 pending=0/);
	assert.match(run(["channel", "qr", "--profile", "personal"]), /Feishu Developer Console/);
	assert.match(run(["profile", "use", "personal"]), /active Profile is now 'personal'/);
	assert.equal(run(["model", "show"]).trim(), "openrouter/openai/gpt-5.2");
	assert.equal(run(["profile", "list", "--home", home, "--root", root], {
		BEEMAX_HOME: join(home, "wrong"),
		BEEMAX_ROOT: join(root, "wrong"),
	}).trim(), "personal");
	assert.throws(() => run(["profile", "show", "ghost"]), /does not exist/);

	const config = loadConfig(join(home, "profiles", "personal", "config.yaml"), "personal");
	assert.equal(config.model.apiKey, "model-key");
	assert.equal(config.gateway.feishu.appSecret, "feishu-key");
	assert.match(await readFile(join(home, "profiles", "personal", "config.yaml"), "utf8"), /gateway:\n\s+feishu:/);
	assert.equal(config.paths.agentDir, join(home, "profiles", "personal"));

	assert.match(run(["profile", "delete", "personal", "--yes"]), /Runtime data was preserved/);
	assert.match(run(["agent", "list"]), /No Agent profiles configured/);
	assert.match(run(["profile", "create", "personal"]), /Created Agent 'personal'/);
	assert.equal(run(["agent", "list"]).trim(), "personal");
	assert.match(run(["gateway", "list"]), /personal  beemax@personal\.service/);
	assert.throws(() => run(["gateway", "unknown"]), /Unknown gateway action/);
	assert.match(run(["profile", "delete", "personal", "--yes"]), /Runtime data was preserved/);
});

test("unified setup configures an isolated Profile and Feishu gateway non-interactively", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-setup-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-home-"));
	const previousRoot = process.env.BEEMAX_ROOT;
	const previousHome = process.env.BEEMAX_HOME;
	const isolatedEnvKeys = ["BEEMAX_PROFILE", "BEEMAX_PROVIDER", "BEEMAX_MODEL", "BEEMAX_API_KEY", "BEEMAX_DB_PATH", "BEEMAX_MCP_CONFIG", "BEEMAX_AGENT_DIR", "BEEMAX_CWD", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_ALLOWED_USERS"];
	const previousOverrides = Object.fromEntries(isolatedEnvKeys.map((key) => [key, process.env[key]]));
	process.env.BEEMAX_ROOT = root;
	process.env.BEEMAX_HOME = home;
	for (const key of isolatedEnvKeys) delete process.env[key];
	const logs = [];
	const previousLog = console.log;
	console.log = (...items) => { logs.push(items.join(" ")); };
	let configured;
	try {
		assert.equal(await runSetup({
			profile: "assistant",
			nonInteractive: true,
			provider: "openrouter",
			model: "openai/gpt-5.2",
			apiKey: "model-secret",
			soul: "You are the dedicated BeeMax operations assistant.",
			appId: "cli_setup",
			appSecret: "feishu-secret",
			allowedUsers: ["ou_setup"],
		}, {
			probe: async () => ({ botName: "BeeMax Setup Bot", botOpenId: "ou_bot" }),
			doctor: async () => true,
		}), true);
		await configureModel("assistant", { provider: "custom", model: "private-model", apiKey: "custom-secret", baseUrl: "https://models.example.test/v1" });
		assert.equal(await runSetup({ profile: "assistant", nonInteractive: true }, {
			probe: async () => ({ botName: "BeeMax Setup Bot" }),
			doctor: async () => true,
		}), true);
		assert.equal(loadConfig(join(home, "profiles", "assistant", "config.yaml"), "assistant").model.baseUrl, "https://models.example.test/v1");
		await runSetup({ profile: "assistant", nonInteractive: true, provider: "anthropic", model: "claude-sonnet-4-5" }, {
			probe: async () => ({ botName: "BeeMax Setup Bot" }),
			doctor: async () => true,
		});
		assert.equal(await runSetup({
			profile: "assistant",
			gatewayOnly: true,
			nonInteractive: true,
			appId: "cli_gateway",
			appSecret: "gateway-secret",
			allowedUsers: ["ou_gateway"],
		}, { probe: async () => ({ botName: "BeeMax Gateway Bot" }) }), true);
		configured = loadConfig(join(home, "profiles", "assistant", "config.yaml"), "assistant");
	} finally {
		console.log = previousLog;
		if (previousRoot === undefined) delete process.env.BEEMAX_ROOT; else process.env.BEEMAX_ROOT = previousRoot;
		if (previousHome === undefined) delete process.env.BEEMAX_HOME; else process.env.BEEMAX_HOME = previousHome;
		for (const [key, value] of Object.entries(previousOverrides)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
	const output = logs.join("\n");
	assert.match(output, /Created Agent Profile 'assistant'/);
	assert.match(output, /Required Feishu configuration/);
	assert.match(output, /PASS  Feishu live probe/);
	assert.match(output, /BeeMax setup complete/);
	const profileHome = join(home, "profiles", "assistant");
	assert.equal((await readFile(join(profileHome, "SOUL.md"), "utf8")).trim(), "You are the dedicated BeeMax operations assistant.");
	assert.equal(configured.model.provider, "anthropic");
	assert.equal(configured.gateway.feishu.appId, "cli_gateway");
	assert.equal(configured.model.baseUrl, undefined);
	assert.equal((await readFile(join(home, "active-profile"), "utf8")).trim(), "assistant");
});

test("setup keeps the generated SOUL unless the user explicitly supplies a custom identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-default-soul-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-default-soul-home-"));
	const previousRoot = process.env.BEEMAX_ROOT;
	const previousHome = process.env.BEEMAX_HOME;
	process.env.BEEMAX_ROOT = root;
	process.env.BEEMAX_HOME = home;
	try {
		await runSetup({
			profile: "personal", nonInteractive: true, provider: "openrouter", model: "openai/gpt-5.2", apiKey: "model-secret",
			appId: "cli_setup", appSecret: "feishu-secret", allowedUsers: ["ou_setup"],
		}, { probe: async () => ({}), doctor: async () => true });
		const soulPath = join(home, "profiles", "personal", "SOUL.md");
		assert.match(await readFile(soulPath, "utf8"), /# BeeMax/);
		await runSetup({
			profile: "personal", nonInteractive: true, soul: "You are a custom executive assistant.",
			appId: "cli_setup", appSecret: "feishu-secret", allowedUsers: ["ou_setup"],
		}, { probe: async () => ({}), doctor: async () => true });
		assert.equal((await readFile(soulPath, "utf8")).trim(), "You are a custom executive assistant.");
	} finally {
		process.env.BEEMAX_ROOT = previousRoot;
		process.env.BEEMAX_HOME = previousHome;
	}
});

test("base setup creates a local Agent that can be used before any Gateway exists", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-local-setup-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-local-home-"));
	const previousRoot = process.env.BEEMAX_ROOT;
	const previousHome = process.env.BEEMAX_HOME;
	process.env.BEEMAX_ROOT = root;
	process.env.BEEMAX_HOME = home;
	try {
		assert.equal(await runSetup({
			profile: "local",
			nonInteractive: true,
			provider: "openrouter",
			model: "openai/gpt-5.2",
			apiKey: "model-secret",
		}, { doctor: async (_config, options) => options.requireGateway === false }), true);
		const config = loadConfig(join(home, "profiles", "local", "config.yaml"), "local");
		assert.equal(config.gateway.feishu.appId, "");
		assert.equal(config.model.provider, "openrouter");
	} finally {
		if (previousRoot === undefined) delete process.env.BEEMAX_ROOT; else process.env.BEEMAX_ROOT = previousRoot;
		if (previousHome === undefined) delete process.env.BEEMAX_HOME; else process.env.BEEMAX_HOME = previousHome;
	}
});

test("setup validates the live Feishu connection before creating a Profile", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-setup-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-home-"));
	const previousRoot = process.env.BEEMAX_ROOT;
	const previousHome = process.env.BEEMAX_HOME;
	process.env.BEEMAX_ROOT = root;
	process.env.BEEMAX_HOME = home;
	try {
		await assert.rejects(() => runSetup({
			profile: "failed",
			nonInteractive: true,
			soul: "Failed setup should not persist.",
			provider: "openrouter",
			model: "openai/gpt-5.2",
			apiKey: "model-secret",
			appId: "cli_failed",
			appSecret: "bad-secret",
			allowedUsers: ["ou_test"],
		}, { probe: async () => { throw new Error("invalid credentials"); } }), /invalid credentials/);
		await assert.rejects(() => readFile(join(home, "profiles", "failed", "config.yaml"), "utf8"));
	} finally {
		if (previousRoot === undefined) delete process.env.BEEMAX_ROOT; else process.env.BEEMAX_ROOT = previousRoot;
		if (previousHome === undefined) delete process.env.BEEMAX_HOME; else process.env.BEEMAX_HOME = previousHome;
	}
});

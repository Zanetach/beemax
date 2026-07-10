import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";

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
	assert.equal(run(["agent", "list"]).trim(), "personal");
	assert.match(run(["model", "set", "openrouter", "openai/gpt-5.2", "--profile", "personal", "--non-interactive"], {
		BEEMAX_API_KEY: "model-key",
	}), /Configured openrouter\/openai\/gpt-5.2/);
	assert.match(run(["channel", "add", "feishu", "--profile", "personal", "--non-interactive"], {
		FEISHU_APP_ID: "cli_test",
		FEISHU_APP_SECRET: "feishu-key",
		FEISHU_ALLOWED_USERS: "ou_test",
	}), /Configured Feishu channel/);
	assert.match(run(["channel", "list", "--profile", "personal"]), /feishu  configured/);
	assert.match(run(["profile", "use", "personal"]), /active Profile is now 'personal'/);
	assert.equal(run(["model", "show"]).trim(), "openrouter/openai/gpt-5.2");
	assert.equal(run(["profile", "list", "--home", home, "--root", root], {
		BEEMAX_HOME: join(home, "wrong"),
		BEEMAX_ROOT: join(root, "wrong"),
	}).trim(), "personal");
	assert.throws(() => run(["profile", "show", "ghost"]), /does not exist/);

	const config = loadConfig(join(home, "profiles", "personal", "config.yaml"), "personal");
	assert.equal(config.model.apiKey, "model-key");
	assert.equal(config.feishu.appSecret, "feishu-key");
	assert.equal(config.paths.agentDir, join(home, "profiles", "personal"));

	assert.match(run(["profile", "delete", "personal", "--yes"]), /Runtime data was preserved/);
	assert.match(run(["agent", "list"]), /No Agent profiles configured/);
	assert.match(run(["profile", "create", "personal"]), /Created Agent 'personal'/);
	assert.equal(run(["agent", "list"]).trim(), "personal");
	assert.match(run(["profile", "delete", "personal", "--yes"]), /Runtime data was preserved/);
});

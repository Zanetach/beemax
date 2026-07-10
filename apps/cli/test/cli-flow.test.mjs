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
	const run = (args, env = {}) => execFileSync(process.execPath, [cli, ...args], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});

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

	const config = loadConfig(join(root, "config", "profiles", "personal.yaml"), "personal");
	assert.equal(config.model.apiKey, "model-key");
	assert.equal(config.feishu.appSecret, "feishu-key");

	assert.match(run(["agent", "delete", "personal", "--yes"]), /Runtime data was preserved/);
	assert.match(run(["agent", "list"]), /No Agent profiles configured/);
});

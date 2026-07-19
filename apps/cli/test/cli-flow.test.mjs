import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { consumeChannelCredential, loadConfig } from "../dist/config.js";

const readCredential = (config, channel) => consumeChannelCredential(config, channel, (credential) => ({ ...credential }));
import { configureModel } from "../dist/profile-config.js";
import { runSetup } from "../dist/setup.js";
import { ensureBuiltinTasks, installedVersion, taskLedgerContextForQuestion } from "../dist/runtime-facts.js";
import { MemoryStore } from "@beemax/memory";
import { FileCredentialVault } from "@beemax/core";

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
	assert.match(run(["model", "set", "custom", "private-model", "--profile", "personal", "--non-interactive"], {
		BEEMAX_API_KEY: "custom-key",
	}), /Configured custom\/private-model/);
	const backupCredentialOutput = run(["credentials", "add", "--profile", "personal", "--label", "Backup account", "--purpose", "backup login", "--non-interactive"], { BEEMAX_CREDENTIAL_SECRET: "backup-private-value" });
	const backupCredentialRef = backupCredentialOutput.match(/cred_[a-f0-9-]{36}/)?.[0];
	assert.ok(backupCredentialRef);
	const liveMemory = new MemoryStore(join(home, "profiles", "personal", "memory.db"));
	liveMemory.remember({ platform: "feishu", chatId: "chat", userId: "user", role: "memory", content: "Backup must preserve this fact" });
	const backupDir = await mkdtemp(join(tmpdir(), "beemax-backup-"));
	assert.match(run(["profile", "backup", "personal", backupDir]), /SQLite snapshot verified/);
	liveMemory.close();
	const backupMemory = new MemoryStore(join(backupDir, "personal", "memory.db"));
	assert.equal(backupMemory.recall("preserve", { platform: "feishu", chatId: "chat", userId: "user" }).length, 1);
	backupMemory.close();
	const backupKey = Buffer.from((await readFile(join(backupDir, "personal", "state", "credential-vault.key"), "utf8")).trim(), "base64");
	const backupVault = new FileCredentialVault(join(backupDir, "personal", "credentials.vault"), backupKey);
	assert.equal(backupVault.list("profile:personal")[0].ref, backupCredentialRef);
	assert.equal(await backupVault.withSecret("profile:personal", backupCredentialRef, "backup.verify", async (secret) => secret), "backup-private-value");
	const sourceVaultPath = join(home, "profiles", "personal", "credentials.vault");
	const sourceVault = await readFile(sourceVaultPath, "utf8");
	await writeFile(sourceVaultPath, "corrupt-vault");
	const failedBackupDir = await mkdtemp(join(tmpdir(), "beemax-bad-backup-"));
	assert.throws(() => run(["profile", "backup", "personal", failedBackupDir]), /Credential Vault|decrypt|corrupt/i);
	await assert.rejects(() => readFile(join(failedBackupDir, "personal", "config.yaml"), "utf8"));
	await writeFile(sourceVaultPath, sourceVault, { mode: 0o600 });
	assert.match(run(["credentials", "remove", backupCredentialRef, "--profile", "personal", "--yes"]), /Removed Credential Ref/);
	assert.match(run(["channel", "add", "feishu", "--profile", "personal", "--non-interactive"], {
		FEISHU_APP_ID: "cli_test",
		FEISHU_APP_SECRET: "feishu-key",
		FEISHU_ALLOWED_USERS: "ou_test",
	}), /Configured Feishu channel/);
	assert.match(run(["channel", "list", "--profile", "personal"]), /feishu  configured/);
	assert.match(run(["mcp", "status", "--profile", "personal"]), /No MCP servers configured/);
	assert.match(run(["memory", "status", "--profile", "personal"]), /curated=0 pending=0/);
	assert.throws(() => run(["credentials", "add", "--profile", "personal", "--label", "Example", "--purpose", "login", "--secret", "must-not-appear"]), /Do not pass Credential Secrets in argv/);
	const storedCredential = run(["credentials", "add", "--profile", "personal", "--label", "Example account", "--purpose", "example.com login", "--non-interactive"], { BEEMAX_CREDENTIAL_SECRET: "correct-horse-battery-staple" });
	const credentialRef = storedCredential.match(/cred_[a-f0-9-]{36}/)?.[0];
	assert.ok(credentialRef);
	assert.doesNotMatch(storedCredential, /correct-horse/);
	assert.match(run(["credentials", "list", "--profile", "personal"]), new RegExp(`${credentialRef}.*Example account.*example\\.com login`));
	assert.match(run(["credentials", "rotate", credentialRef, "--profile", "personal", "--non-interactive"], { BEEMAX_CREDENTIAL_SECRET: "rotated-private-value" }), new RegExp(`Rotated Credential Ref ${credentialRef}`));
	assert.doesNotMatch(run(["credentials", "list", "--profile", "personal"]), /rotated-private-value/);
	assert.match(run(["credentials", "remove", credentialRef, "--profile", "personal", "--yes"]), /Removed Credential Ref/);
	assert.match(run(["credentials", "list", "--profile", "personal"]), /No credentials stored/);
	assert.match(run(["status", "--deep", "--profile", "personal"]), /Gateway: unknown/);
	assert.match(run(["task", "list", "--profile", "personal"]), /anthropic-protocol  \[done\].*tag:v0\.1\.0-preview\.15.*completed_at=2026-07-11T00:19:56\.000Z/);
	assert.match(run(["task", "set", "release-audit", "in_progress", "--title", "Verify release status", "--profile", "personal"]), /Updated task 'release-audit' to in_progress/);
	assert.match(run(["channel", "qr", "--profile", "personal"]), /Feishu Developer Console/);
	assert.match(run(["profile", "use", "personal"]), /active Profile is now 'personal'/);
	assert.equal(run(["model", "show"]).trim(), "custom/private-model");
	assert.equal(run(["profile", "list", "--home", home, "--root", root], {
		BEEMAX_HOME: join(home, "wrong"),
		BEEMAX_ROOT: join(root, "wrong"),
	}).trim(), "personal");
	assert.throws(() => run(["profile", "show", "ghost"]), /does not exist/);

	const config = loadConfig(join(home, "profiles", "personal", "config.yaml"), "personal");
	assert.equal(config.model.apiKey, "custom-key");
	assert.equal(readCredential(config, config.gateway.channels.find((channel) => channel.adapter === "feishu")).appSecret, "feishu-key");
	assert.doesNotMatch(JSON.stringify(config.gateway), /feishu-key/);
	assert.match(await readFile(join(home, "profiles", "personal", "config.yaml"), "utf8"), /gateway:\n\s+feishu:/);
	assert.equal(config.paths.agentDir, join(home, "profiles", "personal"));

	assert.match(run(["profile", "delete", "personal", "--yes"]), /Runtime data was preserved/);
	assert.match(run(["agent", "list"]), /No Agent profiles configured/);
	assert.match(run(["profile", "create", "personal"]), /Created Agent 'personal'/);
	assert.equal(run(["agent", "list"]).trim(), "personal");
	const serviceName = process.platform === "darwin" ? "com.beemax.agent.personal" : process.platform === "linux" ? "beemax@personal.service" : "beemax:personal";
	assert.equal(run(["gateway", "list"]).trim(), `personal  ${serviceName}`);
	assert.throws(() => run(["gateway", "unknown"]), /Unknown gateway action/);
	assert.match(run(["profile", "delete", "personal", "--yes"]), /Runtime data was preserved/);
});

test("fact-sensitive chat questions receive task and installed-version facts, not restored transcript claims", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-runtime-facts-"));
	const store = new MemoryStore(join(home, "memory.db"));
	try {
		ensureBuiltinTasks(store);
		assert.match(taskLedgerContextForQuestion(store, "Was Anthropic support shipped?"), /anthropic-protocol: succeeded/);
		assert.match(taskLedgerContextForQuestion(store, "What BeeMax version is installed?"), /installed_version=/);
		assert.match(taskLedgerContextForQuestion(store, "你是什么模型？", { model: "anthropic/claude-sonnet-4-5", profile: "personal" }), /current_model=anthropic\/claude-sonnet-4-5/);
		await writeFile(join(home, "RELEASE_VERSION"), "v0.1.0-preview.16\n");
		assert.equal(installedVersion(home), "v0.1.0-preview.16");
		assert.equal(taskLedgerContextForQuestion(store, "Draft a weekly report"), "");
		assert.equal(taskLedgerContextForQuestion(store, "写一段包含持久任务和可验证结果的产品发布文案"), "");
		assert.equal(taskLedgerContextForQuestion(store, "面向需要在飞书中持续完成复杂工作的团队，介绍 Task Ledger、定时任务和 OCR"), "");
	} finally {
		store.close();
	}
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
	assert.equal(readCredential(configured, configured.gateway.channels.find((channel) => channel.adapter === "feishu")).appId, "cli_gateway");
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
		assert.equal(config.gateway.channels.length, 0);
		assert.equal(config.model.provider, "openrouter");
	} finally {
		if (previousRoot === undefined) delete process.env.BEEMAX_ROOT; else process.env.BEEMAX_ROOT = previousRoot;
		if (previousHome === undefined) delete process.env.BEEMAX_HOME; else process.env.BEEMAX_HOME = previousHome;
	}
});

test("Feishu Gateway manual fallback is guided and keeps safe WebSocket defaults", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-wizard-root-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-wizard-home-"));
	const previousRoot = process.env.BEEMAX_ROOT;
	const previousHome = process.env.BEEMAX_HOME;
	const logs = [];
	const prompts = [];
	const previousLog = console.log;
	process.env.BEEMAX_ROOT = root;
	process.env.BEEMAX_HOME = home;
	console.log = (...items) => logs.push(items.join(" "));
	try {
		await runSetup({ profile: "guided", nonInteractive: true, provider: "openrouter", model: "openai/gpt-5.2", apiKey: "model-secret" }, { doctor: async () => true });
		const answers = new Map([
			["[1/5] Setup method (qr or manual)", "manual"],
			["[2/5] Platform (feishu or lark)", ""],
			["Feishu App ID", "cli_guided"],
			["Feishu App Secret", "guided-secret"],
			["[4/5] Connection mode (websocket or webhook)", ""],
			["Allowed Feishu user IDs (comma-separated)", "ou_guided,on_guided"],
		]);
		await runSetup({ profile: "guided", gatewayOnly: true, nonInteractive: false }, {
			ask: async (prompt) => { prompts.push(prompt); return answers.get(prompt.label) ?? ""; },
			probe: async (input) => {
				assert.deepEqual(input, { appId: "cli_guided", appSecret: "guided-secret", domain: "feishu" });
				return { botName: "Guided Bot" };
			},
		});
		const config = loadConfig(join(home, "profiles", "guided", "config.yaml"), "guided");
		assert.equal(config.gateway.feishu.domain, "feishu");
		assert.equal(config.gateway.feishu.connectionMode, "websocket");
		assert.deepEqual(config.gateway.feishu.allowedUsers, ["ou_guided", "on_guided"]);
		const output = logs.join("\n");
		assert.match(output, /Scan to create a bot automatically/);
		assert.match(output, /card\.action\.trigger/);
		assert.match(output, /beemax gateway run --profile guided/);
		assert.equal(prompts.find(({ label }) => label === "Feishu App Secret")?.secret, true);
	} finally {
		console.log = previousLog;
		if (previousRoot === undefined) delete process.env.BEEMAX_ROOT; else process.env.BEEMAX_ROOT = previousRoot;
		if (previousHome === undefined) delete process.env.BEEMAX_HOME; else process.env.BEEMAX_HOME = previousHome;
	}
});

test("Feishu Gateway QR setup stores generated credentials and authorizes only the scanning user", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-qr-wizard-root-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-qr-wizard-home-"));
	const previousRoot = process.env.BEEMAX_ROOT;
	const previousHome = process.env.BEEMAX_HOME;
	const logs = [];
	const prompts = [];
	const previousLog = console.log;
	process.env.BEEMAX_ROOT = root;
	process.env.BEEMAX_HOME = home;
	console.log = (...items) => logs.push(items.join(" "));
	try {
		await runSetup({ profile: "qr", nonInteractive: true, provider: "openrouter", model: "openai/gpt-5.2", apiKey: "model-secret" }, { doctor: async () => true });
		await runSetup({ profile: "qr", gatewayOnly: true, nonInteractive: false }, {
			ask: async (prompt) => { prompts.push(prompt); return ""; },
			qrRegister: async () => ({ appId: "cli_qr", appSecret: "qr-secret", domain: "lark", openId: "ou_scanner" }),
			probe: async (input) => { assert.deepEqual(input, { appId: "cli_qr", appSecret: "qr-secret", domain: "lark" }); return { botName: "QR Bot" }; },
		});
		const config = loadConfig(join(home, "profiles", "qr", "config.yaml"), "qr");
		assert.equal(readCredential(config, config.gateway.channels.find((channel) => channel.adapter === "feishu")).appId, "cli_qr");
		assert.equal(config.gateway.feishu.domain, "lark");
		assert.equal(config.gateway.feishu.connectionMode, "websocket");
		assert.deepEqual(config.gateway.feishu.allowedUsers, ["ou_scanner"]);
		assert.equal(prompts.some(({ label }) => label === "Feishu App Secret"), false);
		assert.match(logs.join("\n"), /configured by QR registration/);
		assert.doesNotMatch(logs.join("\n"), /finish the Feishu console checklist/);
	} finally {
		console.log = previousLog;
		if (previousRoot === undefined) delete process.env.BEEMAX_ROOT; else process.env.BEEMAX_ROOT = previousRoot;
		if (previousHome === undefined) delete process.env.BEEMAX_HOME; else process.env.BEEMAX_HOME = previousHome;
	}
});

test("Feishu Gateway setup keeps an existing configuration unless replacement is explicit", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-keep-root-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-keep-home-"));
	const previousRoot = process.env.BEEMAX_ROOT;
	const previousHome = process.env.BEEMAX_HOME;
	process.env.BEEMAX_ROOT = root;
	process.env.BEEMAX_HOME = home;
	try {
		await runSetup({ profile: "keep", nonInteractive: true, provider: "openrouter", model: "openai/gpt-5.2", apiKey: "model-secret", appId: "cli_existing", appSecret: "existing-secret", allowedUsers: ["ou_existing"] }, { doctor: async () => true, probe: async () => ({ botName: "Existing" }) });
		await runSetup({ profile: "keep", gatewayOnly: true, nonInteractive: false }, {
			ask: async ({ label }) => label === "Existing Feishu configuration (keep or replace)" ? "" : assert.fail(`unexpected prompt: ${label}`),
			qrRegister: async () => assert.fail("QR registration must not run when existing configuration is kept"),
		});
		const config = loadConfig(join(home, "profiles", "keep", "config.yaml"), "keep");
		assert.equal(readCredential(config, config.gateway.channels.find((channel) => channel.adapter === "feishu")).appId, "cli_existing");
		assert.deepEqual(config.gateway.feishu.allowedUsers, ["ou_existing"]);
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

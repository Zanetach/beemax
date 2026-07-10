import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "@beemax/memory";
import { loadConfig } from "../dist/config.js";
import { activeProfile } from "../dist/profile-home.js";
import {
	configureFeishuChannel,
	configureModel,
	createProfile,
	deleteProfile,
	listProfiles,
	migrateProfile,
	removeFeishuChannel,
	testFeishuCredentials,
} from "../dist/profile-config.js";

test("profile creation and Feishu channel configuration keep secrets in a protected env file", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-home-"));
	const options = { root, home };
	const paths = await createProfile("personal", options);
	assert.equal(paths.homePath, join(home, "profiles", "personal"));
	assert.equal(paths.configPath, join(paths.homePath, "config.yaml"));
	assert.match(await readFile(paths.soulPath, "utf8"), /private personal assistant/);
	assert.equal((await readFile(paths.envPath, "utf8")).trim(), "");
	assert.equal((await stat(paths.homePath)).mode & 0o777, 0o700);
	assert.deepEqual(await listProfiles(options), ["personal"]);

	await writeFile(paths.envPath, 'EXISTING="value"\n', { mode: 0o644 });
	await chmod(paths.envPath, 0o644);
	await configureFeishuChannel("personal", {
		appId: "cli_test",
		appSecret: 'secret-\\-"-value',
		allowedUsers: ["ou_allowed"],
		domain: "feishu",
		requireMention: true,
	}, options);

	const yaml = await readFile(paths.configPath, "utf8");
	const env = await readFile(paths.envPath, "utf8");
	assert.doesNotMatch(yaml, /secret-\\-/);
	assert.match(env, /FEISHU_APP_SECRET=/);
	assert.equal((await stat(paths.envPath)).mode & 0o777, 0o600);

	const config = loadConfig(paths.configPath, "personal");
	assert.equal(config.feishu.appId, "cli_test");
	assert.equal(config.feishu.appSecret, 'secret-\\-"-value');
	assert.deepEqual(config.feishu.allowedUsers, ["ou_allowed"]);
	assert.equal(config.subagents.enabled, true);
	assert.equal(config.subagents.maxConcurrent, 3);
	assert.equal(config.subagents.maxChildrenPerOwner, 5);
	await configureModel("personal", { provider: "openrouter", model: "openai/gpt-5.2", apiKey: "model-secret" }, options);
	const modelConfig = loadConfig(paths.configPath, "personal");
	assert.equal(modelConfig.model.provider, "openrouter");
	assert.equal(modelConfig.model.model, "openai/gpt-5.2");
	assert.equal(modelConfig.model.apiKey, "model-secret");

	await removeFeishuChannel("personal", options);
	assert.doesNotMatch(await readFile(paths.envPath, "utf8"), /FEISHU_APP_/);
	await deleteProfile("personal", options);
	assert.deepEqual(await listProfiles(options), []);
});

test("profile creation refuses accidental overwrite", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-home-"));
	await createProfile("personal", { root, home });
	await assert.rejects(() => createProfile("personal", { root, home }), /already exists/);
	await mkdir(join(home, "profiles", "partial"), { recursive: true });
	await writeFile(join(home, "profiles", "partial", "SOUL.md"), "existing\n");
	await assert.rejects(() => createProfile("partial", { root, home }), /already exists/);
	await assert.rejects(() => readFile(join(home, "profiles", "partial", "config.yaml"), "utf8"));
});

test("legacy profiles migrate into an isolated home without deleting their source", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-legacy-"));
	const home = await mkdtemp(join(tmpdir(), "beemax-home-"));
	const legacyConfigDir = join(root, "config", "profiles");
	const legacyData = join(root, "data", "profiles", "legacy");
	await mkdir(join(legacyData, "agent", "skills", "remember-me"), { recursive: true });
	await mkdir(legacyConfigDir, { recursive: true });
	await writeFile(join(legacyConfigDir, "legacy.yaml"), [
		"agent:",
		"  systemPrompt: You are the legacy BeeMax identity.",
		"model:",
		"  provider: anthropic",
		"  model: claude-sonnet-4-5",
		"memory:",
		"  dbPath: data/profiles/legacy/beemax.db",
		"mcp:",
		"  configPath: config/profiles/legacy.mcp.json",
		"imageGeneration:",
		"  outputDir: data/profiles/legacy/cache/images",
		"paths:",
		"  agentDir: data/profiles/legacy/agent",
		"  cwd: .",
	].join("\n"));
	await writeFile(join(legacyConfigDir, "legacy.env"), [
		'BEEMAX_API_KEY="legacy-secret"',
		'BEEMAX_DB_PATH="data/profiles/legacy/env-memory.db"',
		'BEEMAX_AGENT_DIR="data/profiles/legacy/agent"',
		'BEEMAX_CWD="."',
		'BEEMAX_SYSTEM_PROMPT="Identity from the legacy environment."',
		'BEEMAX_HOME="/wrong/home"',
		"",
	].join("\n"), { mode: 0o600 });
	const liveMemory = new MemoryStore(join(legacyData, "env-memory.db"));
	liveMemory.remember({ platform: "feishu", chatId: "chat", userId: "user", role: "memory", content: "migrated while source is open" });
	await writeFile(join(legacyData, "agent", "skills", "remember-me", "SKILL.md"), "# Remember me\n");
	await writeFile(join(legacyConfigDir, "legacy.mcp.json"), "{}\n");

	const migrated = await migrateProfile("legacy", { root, home });
	liveMemory.close();
	assert.equal(migrated.homePath, join(home, "profiles", "legacy"));
	assert.match(await readFile(migrated.soulPath, "utf8"), /Identity from the legacy environment/);
	const migratedMemory = new MemoryStore(join(migrated.homePath, "memory.db"));
	assert.equal(migratedMemory.list({ userId: "user" })[0].content, "migrated while source is open");
	migratedMemory.close();
	assert.match(await readFile(join(migrated.homePath, "skills", "remember-me", "SKILL.md"), "utf8"), /Remember me/);
	assert.equal(await readFile(join(migrated.homePath, "mcp.json"), "utf8"), "{}\n");
	const migratedEnv = await readFile(migrated.envPath, "utf8");
	assert.match(migratedEnv, /BEEMAX_API_KEY/);
	assert.doesNotMatch(migratedEnv, /BEEMAX_(DB_PATH|AGENT_DIR|CWD|SYSTEM_PROMPT|HOME)/);
	assert.match(await readFile(join(legacyConfigDir, "legacy.yaml"), "utf8"), /legacy BeeMax identity/);

	const config = loadConfig(migrated.configPath, "legacy");
	assert.equal(config.paths.agentDir, migrated.homePath);
	assert.equal(config.memory.dbPath, join(migrated.homePath, "memory.db"));
	assert.equal(config.agent.systemPrompt, "Identity from the legacy environment.");
});

test("a corrupt active-profile marker fails closed instead of selecting default", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-home-"));
	await writeFile(join(home, "active-profile"), "INVALID PROFILE\n");
	assert.throws(() => activeProfile({ BEEMAX_HOME: home }), /Invalid profile name/);
	await writeFile(join(home, "active-profile"), "  \n");
	assert.throws(() => activeProfile({ BEEMAX_HOME: home }), /marker is empty/);
});

test("Feishu credential test validates the tenant token response without returning the token", async () => {
	let request;
	const message = await testFeishuCredentials(
		{ appId: "cli_test", appSecret: "secret", domain: "feishu" },
		async (url, init) => {
			request = { url, init };
			return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-secret" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	);
	assert.equal(message, "Feishu credentials are valid");
	assert.equal(request.url, "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal");
	assert.doesNotMatch(message, /tenant-secret/);
});

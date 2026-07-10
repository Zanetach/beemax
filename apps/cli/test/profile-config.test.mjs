import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import {
	configureFeishuChannel,
	configureModel,
	createProfile,
	deleteProfile,
	listProfiles,
	removeFeishuChannel,
	testFeishuCredentials,
} from "../dist/profile-config.js";

test("profile creation and Feishu channel configuration keep secrets in a protected env file", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-"));
	const paths = await createProfile("personal", root);
	assert.deepEqual(await listProfiles(root), ["personal"]);

	await writeFile(paths.envPath, 'EXISTING="value"\n', { mode: 0o644 });
	await chmod(paths.envPath, 0o644);
	await configureFeishuChannel("personal", {
		appId: "cli_test",
		appSecret: 'secret-\\-"-value',
		allowedUsers: ["ou_allowed"],
		domain: "feishu",
		requireMention: true,
	}, root);

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
	await configureModel("personal", { provider: "openrouter", model: "openai/gpt-5.2", apiKey: "model-secret" }, root);
	const modelConfig = loadConfig(paths.configPath, "personal");
	assert.equal(modelConfig.model.provider, "openrouter");
	assert.equal(modelConfig.model.model, "openai/gpt-5.2");
	assert.equal(modelConfig.model.apiKey, "model-secret");

	await removeFeishuChannel("personal", root);
	assert.doesNotMatch(await readFile(paths.envPath, "utf8"), /FEISHU_APP_/);
	await deleteProfile("personal", root);
	assert.deepEqual(await listProfiles(root), []);
});

test("profile creation refuses accidental overwrite", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-"));
	await createProfile("personal", root);
	await assert.rejects(() => createProfile("personal", root), /already exists/);
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

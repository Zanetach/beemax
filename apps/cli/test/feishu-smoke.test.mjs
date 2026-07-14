import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeFeishuSmoke, renderFeishuSmoke } from "../dist/feishu-smoke.js";

test("guided Feishu smoke command renders a compact compatibility matrix", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-feishu-smoke-"));
	const profileEnvPath = join(home, ".env");
	await writeFile(profileEnvPath, 'FEISHU_APP_ID="app"\nFEISHU_APP_SECRET="secret"\n', { mode: 0o600 });
	const config = {
		profile: "personal",
		gateway: { channels: [{ id: "feishu-main", adapter: "feishu", enabled: true, credentialRef: "profile-env:feishu", settings: {} }], feishu: { domain: "feishu" } },
		paths: { profileEnvPath, channelCredentialEnvironment: "profile" },
	};
	let receivedChat;
	const command = await executeFeishuSmoke(config, "oc_chat", async (_settings, chatId) => {
		receivedChat = chatId;
		return {
			success: false, chatId, botName: "BeeMax",
			checks: [
				{ name: "credentials", status: "pass", detail: "authenticated" },
				{ name: "reaction", status: "fail", detail: "permission missing" },
				{ name: "image", status: "skip", detail: "not tested" },
			],
		};
	});
	await rm(home, { recursive: true, force: true });
	assert.equal(receivedChat, "oc_chat");
	assert.equal(command.success, false);
	assert.match(command.output, /Profile 'personal'.*chat=oc_chat/);
	assert.match(command.output, /PASS\s+credentials/);
	assert.match(command.output, /FAIL\s+reaction\s+permission missing/);
	assert.match(command.output, /SKIP\s+image/);
});

test("successful Feishu smoke matrix gives a clear final verdict", () => {
	const output = renderFeishuSmoke({ success: true, chatId: "chat", checks: [
		{ name: "text", status: "pass", detail: "delivered" },
	] }, "default");
	assert.match(output, /Real Feishu text, card, Reaction, and image transport are compatible/);
});

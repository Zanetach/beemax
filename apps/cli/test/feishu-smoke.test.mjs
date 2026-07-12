import assert from "node:assert/strict";
import test from "node:test";
import { executeFeishuSmoke, renderFeishuSmoke } from "../dist/feishu-smoke.js";

test("guided Feishu smoke command renders a compact compatibility matrix", async () => {
	const config = { profile: "personal", gateway: { feishu: { appId: "app", appSecret: "secret", domain: "feishu" } } };
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

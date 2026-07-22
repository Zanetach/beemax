import assert from "node:assert/strict";
import test from "node:test";
import { runFeishuSmoke } from "../dist/index.js";

const settings = { appId: "app", appSecret: "secret", domain: "feishu", retryBaseDelayMs: 0 };

test("Feishu smoke test verifies credentials, text, card, Reaction, and image delivery", async () => {
	const messages = [];
	const reactions = [];
	const client = {
		request: async () => ({ code: 0, bot: { open_id: "ou_bot", app_name: "Thruvera" } }),
		im: { v1: {
			message: { create: async (payload) => { messages.push(payload.data.msg_type); return { code: 0, data: { message_id: `message-${messages.length}` } }; } },
			messageReaction: {
				create: async (payload) => { reactions.push(["create", payload]); return { code: 0, data: { reaction_id: "reaction" } }; },
				delete: async (payload) => { reactions.push(["delete", payload]); return { code: 0 }; },
			},
			image: { create: async (payload) => { assert.ok(Buffer.isBuffer(payload.data.image)); return { image_key: "image-key" }; } },
		} },
	};
	const result = await runFeishuSmoke(settings, "oc_chat", client);
	assert.equal(result.success, true);
	assert.equal(result.botName, "Thruvera");
	assert.deepEqual(result.checks.map((check) => [check.name, check.status]), [
		["credentials", "pass"], ["text", "pass"], ["card", "pass"], ["reaction", "pass"], ["image", "pass"],
	]);
	assert.deepEqual(messages, ["text", "interactive", "image"]);
	assert.deepEqual(reactions.map(([operation]) => operation), ["create", "delete"]);
});

test("Feishu smoke test continues after independent failures and returns actionable diagnostics", async () => {
	const client = {
		request: async () => ({ code: 99991663, msg: "invalid token" }),
		im: { v1: {
			message: { create: async (payload) => payload.data.msg_type === "text" ? { code: 230001, msg: "bot not in chat" } : { code: 230027, msg: "permission denied" } },
			messageReaction: { create: async () => { throw new Error("must skip"); }, delete: async () => ({ code: 0 }) },
			image: { create: async () => { throw Object.assign(new Error("forbidden"), { response: { status: 403 } }); } },
		} },
	};
	const result = await runFeishuSmoke(settings, "oc_missing", client);
	assert.equal(result.success, false);
	assert.deepEqual(result.checks.map((check) => check.status), ["fail", "fail", "fail", "skip", "fail"]);
	assert.match(result.checks[0].detail, /App ID\/App Secret/);
	assert.match(result.checks[1].detail, /add the bot/);
	assert.match(result.checks[2].detail, /permissions/);
});

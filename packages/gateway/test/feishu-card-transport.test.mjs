import assert from "node:assert/strict";
import test from "node:test";
import { FeishuAdapter, parseFeishuCardActionEvent } from "../dist/index.js";

const settings = {
	appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
	requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: true,
};

test("Feishu cards reply to the triggering message and preserve topic routing", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	const calls = [];
	adapter.client = { im: { v1: { message: {
		reply: async (payload) => { calls.push(["reply", payload]); return { code: 0, data: { message_id: "reply-card" } }; },
		create: async (payload) => { calls.push(["create", payload]); return { code: 0, data: { message_id: "new-card" } }; },
	} } } };
	assert.deepEqual(await adapter.sendCard("chat", { schema: "2.0" }, "source-message", true), { success: true, messageId: "reply-card" });
	assert.equal(calls[0][0], "reply");
	assert.equal(calls[0][1].path.message_id, "source-message");
	assert.equal(calls[0][1].data.reply_in_thread, true);
	assert.equal(calls[0][1].data.msg_type, "interactive");
	assert.deepEqual(await adapter.sendCard("chat", { schema: "2.0" }), { success: true, messageId: "new-card" });
	assert.equal(calls[1][0], "create");
	assert.equal(calls[1][1].data.receive_id, "chat");
});

test("Feishu Card JSON 2.0 callbacks normalize identity, routing, and stable action id", () => {
	const raw = {
		context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
		operator: { open_id: "ou_user", user_id: "user", union_id: "on_user" },
		action: { tag: "button", name: "approve_once", value: { choice: "once", approval_id: "approval:turn", beemax_action: "approval.decide" } },
	};
	const first = parseFeishuCardActionEvent(raw);
	const reordered = parseFeishuCardActionEvent({ ...raw, action: { ...raw.action, value: { beemax_action: "approval.decide", approval_id: "approval:turn", choice: "once" } } });
	assert.equal(first.messageId, "om_card");
	assert.equal(first.chatId, "oc_chat");
	assert.equal(first.userId, "ou_user");
	assert.equal(first.userIdAlt, "on_user");
	assert.equal(first.actionId, reordered.actionId);
	assert.deepEqual(first.value, raw.action.value);
});

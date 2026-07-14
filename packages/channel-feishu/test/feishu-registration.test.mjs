import assert from "node:assert/strict";
import test from "node:test";
import { createFeishuAdapterRegistration } from "../dist/index.js";

test("Feishu registration creates independent Channel Instances from their settings and Credential Refs", () => {
	const requested = [];
	const registration = createFeishuAdapterRegistration({
		defaults: {
			domain: "feishu", connectionMode: "websocket", requireMention: true,
			allowedUsers: ["legacy"], allowedChats: [], allowAllUsers: false,
		},
		resolveCredentials: (instance) => {
			requested.push(`${instance.id}:${instance.credentialRef}`);
			return { appId: `app-${instance.id}`, appSecret: `secret-${instance.id}` };
		},
	});
	const first = registration.create({ id: "company-a", adapter: "feishu", enabled: true, credentialRef: "profile-env:channel:company-a", settings: { allowedUsers: ["user-a"] } });
	const second = registration.create({ id: "company-b", adapter: "feishu", enabled: true, credentialRef: "profile-env:channel:company-b", settings: { domain: "lark", allowedUsers: ["user-b"] } });

	assert.equal(first.admit({ sender_id: { open_id: "user-a" } }, { chat_id: "dm-a", chat_type: "p2p", message_id: "a", message_type: "text", content: "{}" }), null);
	assert.match(first.admit({ sender_id: { open_id: "user-b" } }, { chat_id: "dm-a", chat_type: "p2p", message_id: "b", message_type: "text", content: "{}" }), /not authorized/);
	assert.equal(second.admit({ sender_id: { open_id: "user-b" } }, { chat_id: "dm-b", chat_type: "p2p", message_id: "c", message_type: "text", content: "{}" }), null);
	assert.deepEqual(requested, ["company-a:profile-env:channel:company-a", "company-b:profile-env:channel:company-b"]);
});

test("Feishu registration fails closed on missing credentials and invalid instance settings", () => {
	const registration = createFeishuAdapterRegistration({
		defaults: { domain: "feishu", connectionMode: "websocket", requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: false },
		resolveCredentials: (instance) => instance.id === "missing" ? undefined : { appId: "app", appSecret: "secret" },
	});
	assert.throws(() => registration.create({ id: "missing", adapter: "feishu", enabled: true, credentialRef: "missing", settings: {} }), /missing.*credentials/i);
	assert.throws(() => registration.create({ id: "invalid", adapter: "feishu", enabled: true, credentialRef: "invalid", settings: { allowedUsers: "everyone" } }), /allowedUsers/i);
});

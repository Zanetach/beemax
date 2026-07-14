import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramAdapterRegistration } from "../dist/index.js";

test("Telegram registration creates independent Channel Instances from settings and Credential Refs", () => {
	const requested = [];
	const registration = createTelegramAdapterRegistration({
		defaults: { allowedUsers: ["legacy"], allowedChats: [], allowAllUsers: false },
		resolveCredentials: (instance) => { requested.push(`${instance.id}:${instance.credentialRef}`); return { botToken: `token-${instance.id}` }; },
	});
	const first = registration.create({ id: "team-a", adapter: "telegram", enabled: true, credentialRef: "profile-env:channel:team-a", settings: { allowedUsers: ["1"] } });
	const second = registration.create({ id: "team-b", adapter: "telegram", enabled: true, credentialRef: "profile-env:channel:team-b", settings: { allowedUsers: ["2"] } });
	assert.equal(first.admit({ chatId: "chat", chatType: "dm", userId: "1" }), null);
	assert.match(first.admit({ chatId: "chat", chatType: "dm", userId: "2" }), /not authorized/);
	assert.equal(second.admit({ chatId: "chat", chatType: "dm", userId: "2" }), null);
	assert.deepEqual(requested, ["team-a:profile-env:channel:team-a", "team-b:profile-env:channel:team-b"]);
});

test("Telegram registration fails closed on missing credentials and invalid instance settings", () => {
	const registration = createTelegramAdapterRegistration({ defaults: { allowedUsers: [], allowedChats: [], allowAllUsers: false }, resolveCredentials: (instance) => instance.id === "missing" ? undefined : { botToken: "token" } });
	assert.throws(() => registration.create({ id: "missing", adapter: "telegram", enabled: true, credentialRef: "missing", settings: {} }), /missing.*credentials/i);
	assert.throws(() => registration.create({ id: "invalid", adapter: "telegram", enabled: true, credentialRef: "invalid", settings: { allowAllUsers: "yes" } }), /allowAllUsers/i);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
	conversationIdentity,
	conversationKey,
	conversationOwnerKey,
	memoryScopeForSource,
	interactionScopeForSource,
} from "../dist/index.js";

test("agent scope derives every runtime view from one canonical identity", () => {
	const source = {
		platform: "discord",
		chatId: "channel-1",
		chatType: "thread",
		userId: "app-user",
		userIdAlt: "global-user",
		threadId: "topic-7",
	};

	assert.deepEqual(conversationIdentity(source), {
		platform: "discord",
		chatId: "channel-1",
		userId: "global-user",
		threadId: "topic-7",
	});
	assert.equal(conversationOwnerKey(source), "discord:channel-1:global-user");
	assert.equal(conversationKey(source), "discord:channel-1#topic-7:global-user");
	assert.deepEqual(memoryScopeForSource(source), {
		platform: "discord",
		chatId: "channel-1",
		userId: "global-user",
	});
	assert.deepEqual(interactionScopeForSource(source, "personal"), {
		profileId: "personal",
		platform: "discord",
		chatId: "channel-1",
		userId: "global-user",
		threadId: "topic-7",
	});
});

test("anonymous agent scope has stable owner and thread keys", () => {
	const source = { platform: "cli", chatId: "local", chatType: "dm" };
	assert.equal(conversationOwnerKey(source), "cli:local:anon");
	assert.equal(conversationKey(source), "cli:local:anon");
});

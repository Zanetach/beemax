import assert from "node:assert/strict";
import test from "node:test";
import {
	conversationIdentity,
	conversationKey,
	conversationOwnerKey,
	responsibilityOwnerKey,
	responsibilityOwnerKeys,
	memoryScopeForSource,
	interactionScopeForSource,
	legacySessionIdsForSource,
	sessionIdForSource,
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
	assert.equal(conversationOwnerKey(source), "discord:channel-1");
	assert.equal(conversationKey(source), "discord:channel-1#topic-7");
	assert.equal(responsibilityOwnerKey(source), "user:global-user");
	assert.deepEqual(memoryScopeForSource(source), {
		platform: "discord",
		chatId: "channel-1",
		threadId: "topic-7",
		chatType: "thread",
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
	assert.equal(responsibilityOwnerKey(source), "cli:local:anon");
});

test("trusted cross-application identity shares durable responsibility without sharing sessions", () => {
	const cli = { platform: "cli", chatId: "local", chatType: "dm", userId: "local", userIdAlt: "employee-7" };
	const feishu = { platform: "feishu", chatId: "oc-chat", chatType: "dm", userId: "ou-app", userIdAlt: "employee-7" };
	assert.notEqual(conversationKey(cli), conversationKey(feishu));
	assert.equal(responsibilityOwnerKey(cli), responsibilityOwnerKey(feishu));
});

test("group participants share one conversation while retaining distinct responsibility", () => {
	const alice = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const bob = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "bob" };

	assert.equal(conversationOwnerKey(alice), "feishu@company-a:group-1");
	assert.equal(conversationKey(alice), conversationKey(bob));
	assert.notEqual(responsibilityOwnerKey(alice), responsibilityOwnerKey(bob));
	assert.equal(memoryScopeForSource(alice).userId, undefined);
	assert.equal(memoryScopeForSource(bob).userId, undefined);
	assert.equal(memoryScopeForSource(alice).platform, "feishu@company-a");
});

test("legacy actor-scoped task owners remain discoverable after enabling shared group conversations", () => {
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	assert.deepEqual(responsibilityOwnerKeys(source), [
		"feishu@company-a:group-1:alice",
		"feishu@company-a:group-1",
		"feishu:group-1:alice",
		"feishu:group-1",
	]);
});

test("shared group sessions retain deterministic fallback ids for legacy actor transcripts", () => {
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "group", userId: "alice" };
	const legacyIds = legacySessionIdsForSource(source);
	assert.equal(legacyIds.length, 2);
	assert.equal(legacyIds.includes(sessionIdForSource(source)), false);
	assert.deepEqual(legacyIds, legacySessionIdsForSource(source));
});

test("group threads and channel instances are distinct conversation spaces", () => {
	const base = { platform: "feishu", chatId: "group-1", chatType: "thread", userId: "alice" };
	assert.notEqual(
		conversationKey({ ...base, channelInstanceId: "company-a", threadId: "topic-1" }),
		conversationKey({ ...base, channelInstanceId: "company-a", threadId: "topic-2" }),
	);
	assert.notEqual(
		conversationKey({ ...base, channelInstanceId: "company-a", threadId: "topic-1" }),
		conversationKey({ ...base, channelInstanceId: "company-b", threadId: "topic-1" }),
	);
});

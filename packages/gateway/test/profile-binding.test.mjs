import assert from "node:assert/strict";
import test from "node:test";
import { ProfileBindingResolver } from "../dist/index.js";

test("Profile Binding resolves thread, conversation, account, then instance precedence", () => {
	const resolver = new ProfileBindingResolver([
		{ id: "instance", profileId: "general", channelInstanceId: "feishu-a" },
		{ id: "account", profileId: "sales", channelInstanceId: "feishu-a", accountRef: "sales-bot" },
		{ id: "conversation", profileId: "support", channelInstanceId: "feishu-a", conversationId: "group-1" },
		{ id: "thread", profileId: "incident", channelInstanceId: "feishu-a", conversationId: "group-1", threadId: "topic-7" },
	]);
	assert.deepEqual(resolver.validate(), { valid: true, conflicts: [] });
	assert.equal(resolver.resolve({ channelInstanceId: "feishu-a", accountRef: "sales-bot", conversationId: "group-1", threadId: "topic-7" }).profileId, "incident");
	assert.equal(resolver.resolve({ channelInstanceId: "feishu-a", accountRef: "sales-bot", conversationId: "group-1" }).profileId, "support");
	assert.equal(resolver.resolve({ channelInstanceId: "feishu-a", accountRef: "sales-bot", conversationId: "other" }).profileId, "sales");
	assert.equal(resolver.resolve({ channelInstanceId: "feishu-a", conversationId: "other" }).profileId, "general");
});

test("Profile Binding fails explicitly for same-level conflicts and unmatched routes", () => {
	const resolver = new ProfileBindingResolver([
		{ id: "first", profileId: "sales", channelInstanceId: "feishu-a", conversationId: "group-1" },
		{ id: "second", profileId: "finance", channelInstanceId: "feishu-a", conversationId: "group-1" },
	]);
	const validation = resolver.validate();
	assert.equal(validation.valid, false);
	assert.deepEqual(validation.conflicts[0].bindingIds, ["first", "second"]);
	assert.throws(() => resolver.resolve({ channelInstanceId: "feishu-a", conversationId: "group-1" }), /conflict.*first.*second/i);
	assert.throws(() => resolver.resolve({ channelInstanceId: "telegram-a", conversationId: "chat" }), /no Profile Binding/i);
});

test("Profile Binding explain exposes deterministic precedence without secrets", () => {
	const resolver = new ProfileBindingResolver([
		{ id: "default", profileId: "general", channelInstanceId: "feishu-a" },
		{ id: "group", profileId: "sales", channelInstanceId: "feishu-a", conversationId: "group-1" },
	]);
	assert.deepEqual(resolver.explain({ channelInstanceId: "feishu-a", conversationId: "group-1" }), {
		status: "matched", profileId: "sales", bindingId: "group", precedence: "conversation", candidates: ["group"],
	});
});

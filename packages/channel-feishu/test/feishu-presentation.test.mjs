import assert from "node:assert/strict";
import test from "node:test";
import { FeishuAdapter } from "../dist/index.js";
import { interactionCompletionDeliveryKey } from "@beemax/core";

const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user", messageId: "incoming", replyToMessageId: "incoming" };

test("Feishu Adapter owns rich Turn presentation and exposes only the Channel Runtime presenter interface", async () => {
	const cards = [];
	const bindings = [];
	const cardKeys = [];
	const textDeliveries = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async (_chatId, card, _replyTo, _replyInThread, idempotencyKey) => { cards.push(card); cardKeys.push(idempotencyKey); return { success: true, messageId: "card-1" }; };
	adapter.updateCard = async (_messageId, card) => { cards.push(card); return { success: true, messageId: "card-1" }; };
	adapter.sendTyping = async () => undefined;
	adapter.stopTyping = async () => undefined;
	adapter.send = async (_chatId, text, options) => { textDeliveries.push({ text, options }); return { success: true, messageId: "text" }; };
	const streamedAnswer = "x".repeat(50_001);
	const canonicalResult = streamedAnswer.slice(0, 50_000);

	const turn = adapter.presentation.open({
		source,
		profileId: "profile",
		preferences: { title: "BeeMax · profile", updateIntervalMs: 0, ioTimeoutMs: 100 },
		onBinding: (messageId, pendingApprovalId) => bindings.push({ messageId, pendingApprovalId }),
	});
	await turn.start();
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, text: streamedAnswer });
	const result = { answer: streamedAnswer, model: "test", durationMs: 1, usage: {}, outcome: { status: "answered" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, result });
	const durableKey = interactionCompletionDeliveryKey("profile", source, source.messageId);
	const receipt = await turn.finish(canonicalResult, { idempotencyKey: durableKey });
	await turn.close(false);

	assert.ok(cards.length >= 1);
	assert.match(JSON.stringify(cards.at(-1)), /xxxxx/);
	assert.deepEqual(bindings.at(-1), { messageId: "card-1", pendingApprovalId: undefined });
	assert.notEqual(cardKeys[0], durableKey, "transient progress and durable final delivery must not share a Provider key");
	assert.deepEqual(textDeliveries, [{ text: canonicalResult, options: { idempotencyKey: durableKey, replyTo: "incoming", replyInThread: false } }]);
	assert.deepEqual(receipt, { idempotencyKey: durableKey, deliveredAt: receipt.deliveredAt, providerMessageId: "text" });
});

test("Feishu replaces a streamed Candidate Outcome with the canonical Verification result", async () => {
	const cards = [];
	const texts = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async (_chatId, card) => { cards.push(card); return { success: true, messageId: "card-1" }; };
	adapter.updateCard = async (_messageId, card) => { cards.push(card); return { success: true, messageId: "card-1" }; };
	adapter.sendTyping = async () => undefined;
	adapter.stopTyping = async () => undefined;
	adapter.send = async (_chatId, text) => { texts.push(text); return { success: true, messageId: "text" }; };

	const turn = adapter.presentation.open({
		source,
		profileId: "profile",
		preferences: { title: "BeeMax · profile", updateIntervalMs: 0, ioTimeoutMs: 100 },
	});
	await turn.start();
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, text: "UNVERIFIED CANDIDATE" });
	const result = { answer: "任务尚未完成：独立 Verification 当前不可用。", model: "test", durationMs: 1, usage: {}, outcome: { status: "verification_unavailable", objectiveId: "objective:1" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, result });
	await turn.finish(result.answer);
	await turn.close(false);

	const finalCard = JSON.stringify(cards.at(-1));
	assert.match(finalCard, /任务尚未完成/);
	assert.match(finalCard, /尚未完成/);
	assert.doesNotMatch(finalCard, /"template":"green"/);
	assert.doesNotMatch(finalCard, /UNVERIFIED CANDIDATE/);
	assert.deepEqual(texts, []);
});

test("Feishu fails closed when a legacy Runtime omits the Host outcome", async () => {
	const cards = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async (_chatId, card) => { cards.push(card); return { success: true, messageId: "card-legacy" }; };
	adapter.updateCard = async (_messageId, card) => { cards.push(card); return { success: true, messageId: "card-legacy" }; };
	adapter.sendTyping = async () => undefined;
	adapter.stopTyping = async () => undefined;
	adapter.send = async () => ({ success: true, messageId: "text-legacy" });

	const turn = adapter.presentation.open({ source, profileId: "profile", preferences: { title: "BeeMax · profile", updateIntervalMs: 0, ioTimeoutMs: 100 } });
	await turn.start();
	const result = { answer: "legacy result without Host state", model: "test", durationMs: 1, usage: {} };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, result });
	await turn.finish(result.answer);
	await turn.close(false);

	const finalCard = JSON.stringify(cards.at(-1));
	assert.match(finalCard, /尚未完成/);
	assert.doesNotMatch(finalCard, /"template":"green"/);
});

test("Feishu renders a Host-rejected Candidate as a distinct red Verification state", async () => {
	const cards = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async (_chatId, card) => { cards.push(card); return { success: true, messageId: "card-rejected" }; };
	adapter.updateCard = async (_messageId, card) => { cards.push(card); return { success: true, messageId: "card-rejected" }; };
	adapter.sendTyping = async () => undefined;
	adapter.stopTyping = async () => undefined;
	adapter.send = async () => ({ success: true, messageId: "text-rejected" });

	const turn = adapter.presentation.open({ source, profileId: "profile", preferences: { title: "BeeMax · profile", updateIntervalMs: 0, ioTimeoutMs: 100 } });
	await turn.start();
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, text: "UNVERIFIED CANDIDATE" });
	const result = { answer: "任务未通过独立 Verification：缺少来源证据。", model: "test", durationMs: 1, usage: {}, outcome: { status: "rejected", objectiveId: "objective:1" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, result });
	await turn.finish(result.answer);
	await turn.close(false);

	const finalCard = JSON.stringify(cards.at(-1));
	assert.match(finalCard, /验证未通过/);
	assert.match(finalCard, /"template":"red"/);
	assert.match(finalCard, /缺少来源证据/);
	assert.doesNotMatch(finalCard, /尚未完成|UNVERIFIED CANDIDATE/);
});

test("Feishu work progress degrades to mandatory text delivery when CardKit is unavailable", async () => {
	const texts = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async () => ({ success: false, error: "CardKit unavailable" });
	adapter.send = async (_chatId, text) => { texts.push(text); return { success: true, messageId: "fallback" }; };
	await adapter.presentation.presentWorkProgress({
		target: { platform: "feishu", chatId: "chat", chatType: "dm" },
		event: { workId: "plan", title: "季度复盘", state: "running", completed: 1, total: 3, failed: 0, cancelled: 0 },
		idempotencyKey: "progress:plan",
	});
	assert.deepEqual(texts, ["季度复盘 · 1/3"]);
});

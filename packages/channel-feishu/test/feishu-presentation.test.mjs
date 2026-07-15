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
	const result = { answer: streamedAnswer, model: "test", durationMs: 1, usage: {} };
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

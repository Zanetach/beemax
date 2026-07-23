import assert from "node:assert/strict";
import test from "node:test";
import { FeishuAdapter } from "../dist/index.js";
import { interactionCompletionDeliveryKey } from "@beemax/core";

const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user", messageId: "incoming", replyToMessageId: "incoming" };

function mainContent(card) {
	return card.body.elements
		.filter((element) => String(element.element_id ?? "").startsWith("main_content"))
		.map((element) => element.content)
		.join("\n");
}

test("a short Feishu Turn sends one final result without exposing streamed model narration", async () => {
	const cards = [];
	const texts = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async (_chatId, card) => { cards.push(card); return { success: true, messageId: "card-short" }; };
	adapter.updateCard = async (_messageId, card) => { cards.push(card); return { success: true, messageId: "card-short" }; };
	adapter.sendTyping = async () => undefined;
	adapter.stopTyping = async () => undefined;
	adapter.send = async (_chatId, text) => { texts.push(text); return { success: true, messageId: "result-short" }; };

	const turn = adapter.presentation.open({
		source,
		profileId: "profile",
		preferences: { title: "BeeMax · profile", progressDelayMs: 50, updateIntervalMs: 0, ioTimeoutMs: 100 },
	});
	await turn.start();
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, text: "我先发现工具，再拉取数据，然后继续分析。" });
	const result = { answer: "这是最终结果。", model: "test", durationMs: 1, usage: {}, outcome: { status: "answered" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, result });
	await turn.finish(result.answer);
	await turn.close(false);

	assert.equal(cards.length, 0);
	assert.deepEqual(texts, ["这是最终结果。"]);
	const visible = JSON.stringify([...cards, ...texts]);
	assert.doesNotMatch(visible, /我先发现工具|再拉取数据|继续分析/);
});

test("a late Feishu card creation cannot duplicate the final answer after local timeout", async () => {
	const cards = [];
	const texts = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async (_chatId, card) => {
		await new Promise((resolve) => setTimeout(resolve, 30));
		cards.push(card);
		return { success: true, messageId: "late-card" };
	};
	adapter.updateCard = async (_messageId, card) => { cards.push(card); return { success: true, messageId: "late-card" }; };
	adapter.sendTyping = async () => undefined;
	adapter.stopTyping = async () => undefined;
	adapter.send = async (_chatId, text) => { texts.push(text); return { success: true, messageId: "fallback" }; };

	const turn = adapter.presentation.open({
		source,
		profileId: "profile",
		preferences: { title: "BeeMax · profile", progressDelayMs: 50, updateIntervalMs: 0, ioTimeoutMs: 10 },
	});
	await turn.start();
	const answer = "唯一的最终答案";
	const result = { answer, model: "test", durationMs: 1, usage: {}, outcome: { status: "answered" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, result });
	await turn.finish(answer);
	await new Promise((resolve) => setTimeout(resolve, 40));
	await turn.close(false);

	const deliveries = [...cards.map((card) => JSON.stringify(card)), ...texts];
	assert.equal(deliveries.filter((delivery) => delivery.includes(answer)).length, 1);
});

test("a long Feishu Turn reuses one card and shows at most two human-readable progress states", async () => {
	const sends = [];
	const updates = [];
	const texts = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async (_chatId, card) => { sends.push(card); return { success: true, messageId: "card-long" }; };
	adapter.updateCard = async (messageId, card) => { updates.push({ messageId, card }); return { success: true, messageId }; };
	adapter.sendTyping = async () => undefined;
	adapter.stopTyping = async () => undefined;
	adapter.send = async (_chatId, text) => { texts.push(text); return { success: true, messageId: "result-long" }; };

	const turn = adapter.presentation.open({
		source,
		profileId: "profile",
		preferences: { title: "BeeMax · profile", progressDelayMs: 10, updateIntervalMs: 0, ioTimeoutMs: 100 },
	});
	await turn.start();
	await turn.onEvent({ type: "planning.selected", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, mode: "direct", concurrency: 1, maxSubagents: 0, requiredTools: ["market_series"] });
	await new Promise((resolve) => setTimeout(resolve, 25));
	await turn.onEvent({ type: "tool.changed", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, callId: "call-1", name: "market_series", state: "running", summary: "Downloading provider rows" });
	await turn.onEvent({ type: "tool.changed", sessionId: "session", scope: source, turnId: "turn", at: 3, sequence: 3, callId: "call-1", name: "market_series", state: "completed", summary: "Downloaded 1,000 rows" });
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 4, sequence: 4, text: "我调用了 market_series，现在继续分析内部数据。" });
	const result = { answer: "黄金走势报告已完成。", model: "test", durationMs: 30_000, usage: {}, outcome: { status: "answered" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 5, sequence: 5, result });
	await turn.finish(result.answer);
	await turn.close(false);

	assert.equal(sends.length, 1, "the progress and result must share one card");
	assert.ok(updates.length <= 2, "only one additional progress state and one final update are allowed");
	assert.ok(updates.every(({ messageId }) => messageId === "card-long"));
	const progressCards = [sends[0], ...updates.slice(0, -1).map(({ card }) => card)];
	assert.ok(progressCards.length <= 2);
	for (const card of progressCards) {
		assert.match(mainContent(card), /正在/);
		assert.doesNotMatch(mainContent(card), /market_series|provider|1,000|内部数据|direct|并发/);
	}
	assert.match(mainContent(updates.at(-1).card), /处理结束/);
	assert.deepEqual(texts, ["黄金走势报告已完成。"]);
});

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
		preferences: { title: "BeeMax · profile", progressDelayMs: 0, updateIntervalMs: 0, ioTimeoutMs: 100 },
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
	assert.doesNotMatch(JSON.stringify(cards), /x{100}/, "the durable final answer must not also be copied into the progress card");
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
		preferences: { title: "BeeMax · profile", progressDelayMs: 0, updateIntervalMs: 0, ioTimeoutMs: 100 },
	});
	await turn.start();
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, text: "UNVERIFIED CANDIDATE" });
	const result = { answer: "任务尚未完成：独立 Verification 当前不可用。", model: "test", durationMs: 1, usage: {}, outcome: { status: "verification_unavailable", objectiveId: "objective:1" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, result });
	await turn.finish(result.answer);
	await turn.close(false);

	const finalCard = JSON.stringify(cards.at(-1));
	assert.match(finalCard, /尚未完成/);
	assert.doesNotMatch(finalCard, /"template":"green"/);
	assert.doesNotMatch(finalCard, /UNVERIFIED CANDIDATE/);
	assert.deepEqual(texts, [result.answer]);
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

	const turn = adapter.presentation.open({ source, profileId: "profile", preferences: { title: "BeeMax · profile", progressDelayMs: 0, updateIntervalMs: 0, ioTimeoutMs: 100 } });
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
	const texts = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async (_chatId, card) => { cards.push(card); return { success: true, messageId: "card-rejected" }; };
	adapter.updateCard = async (_messageId, card) => { cards.push(card); return { success: true, messageId: "card-rejected" }; };
	adapter.sendTyping = async () => undefined;
	adapter.stopTyping = async () => undefined;
	adapter.send = async (_chatId, text) => { texts.push(text); return { success: true, messageId: "text-rejected" }; };

	const turn = adapter.presentation.open({ source, profileId: "profile", preferences: { title: "BeeMax · profile", progressDelayMs: 0, updateIntervalMs: 0, ioTimeoutMs: 100 } });
	await turn.start();
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, text: "UNVERIFIED CANDIDATE" });
	const result = { answer: "任务未通过独立 Verification：缺少来源证据。", model: "test", durationMs: 1, usage: {}, outcome: { status: "rejected", objectiveId: "objective:1" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, result });
	await turn.finish(result.answer);
	await turn.close(false);

	const finalCard = JSON.stringify(cards.at(-1));
	assert.match(finalCard, /验证未通过/);
	assert.match(finalCard, /"template":"red"/);
	assert.doesNotMatch(finalCard, /尚未完成|UNVERIFIED CANDIDATE/);
	assert.deepEqual(texts, [result.answer]);
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

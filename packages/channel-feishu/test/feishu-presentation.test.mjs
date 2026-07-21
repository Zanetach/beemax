import assert from "node:assert/strict";
import test from "node:test";
import { FeishuAdapter, FeishuInteractionPresenter } from "../dist/index.js";
import { interactionCompletionDeliveryKey } from "@beemax/core";

const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user", messageId: "incoming", replyToMessageId: "incoming" };

test("Feishu long-answer fallback respects the normal full-card refresh cadence", async () => {
	const sentAt = [];
	const updatedAt = [];
	const transport = {
		send: async () => ({ success: true, messageId: "text" }),
		sendCard: async () => { sentAt.push(Date.now()); return { success: true, messageId: "card-1" }; },
		updateCard: async () => { updatedAt.push(Date.now()); return { success: true, messageId: "card-1" }; },
		sendTyping: async () => undefined,
		stopTyping: async () => undefined,
	};
	const turn = new FeishuInteractionPresenter(transport).open({
		source,
		profileId: "profile",
		preferences: { updateIntervalMs: 600, ioTimeoutMs: 1_000 },
	});
	const paragraph = `${"这是用于验证飞书长文刷新节奏的正文。".repeat(8)}。`;

	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, text: paragraph });
	await waitFor(() => sentAt.length === 1, 500);
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, text: paragraph });
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.equal(updatedAt.length, 0, "answer deltas must not use the 250ms urgent full-card path");
	await waitFor(() => updatedAt.length === 1, 500);
	assert.ok(updatedAt[0] - sentAt[0] >= 520, "full-card fallback should stay near the configured 600ms cadence");
	await turn.close(false);
});

test("Feishu streams answer text through one CardKit markdown element", async () => {
	const nativeCards = [];
	const contentUpdates = [];
	const legacyCards = [];
	const transport = {
		send: async () => ({ success: true, messageId: "text" }),
		sendCard: async (_chatId, card) => { legacyCards.push(card); return { success: true, messageId: "legacy-card" }; },
		updateCard: async (_messageId, card) => { legacyCards.push(card); return { success: true, messageId: "legacy-card" }; },
		sendStreamingCard: async (_chatId, card) => { nativeCards.push(card); return { success: true, messageId: "card-message", cardId: "card-entity" }; },
		updateStreamingCardContent: async (cardId, elementId, content, sequence) => {
			contentUpdates.push({ cardId, elementId, content, sequence });
			return { success: true, messageId: "card-message" };
		},
		updateStreamingCard: async () => ({ success: true, messageId: "card-message" }),
		finishStreamingCard: async () => ({ success: true, messageId: "card-message" }),
		sendTyping: async () => undefined,
		stopTyping: async () => undefined,
	};
	const turn = new FeishuInteractionPresenter(transport).open({ source, profileId: "profile", preferences: { updateIntervalMs: 600, ioTimeoutMs: 1_000 } });
	await turn.start();

	assert.equal(nativeCards.length, 1);
	assert.equal(nativeCards[0].config.streaming_mode, true);
	assert.equal(nativeCards[0].body.elements[0].element_id, "main_content");
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, text: "第一段有意义的回答内容，会由飞书客户端平滑打印。" });
	await waitFor(() => contentUpdates.length === 1, 500);

	assert.deepEqual(contentUpdates[0], {
		cardId: "card-entity",
		elementId: "main_content",
		content: "第一段有意义的回答内容，会由飞书客户端平滑打印。",
		sequence: 1,
	});
	assert.deepEqual(legacyCards, []);
	await turn.close(false);
});

test("Feishu defers tool-card repaint once answer streaming starts", async () => {
	const fullCardUpdates = [];
	const contentUpdates = [];
	const transport = {
		send: async () => ({ success: true, messageId: "text" }),
		sendCard: async () => ({ success: true, messageId: "legacy-card" }),
		updateCard: async () => ({ success: true, messageId: "legacy-card" }),
		sendStreamingCard: async () => ({ success: true, messageId: "card-message", cardId: "card-entity" }),
		updateStreamingCardContent: async (_cardId, _elementId, content) => { contentUpdates.push({ content, at: Date.now() }); return { success: true }; },
		updateStreamingCard: async (_cardId, card) => { fullCardUpdates.push(card); return { success: true }; },
		finishStreamingCard: async () => ({ success: true }),
		sendTyping: async () => undefined,
		stopTyping: async () => undefined,
	};
	const turn = new FeishuInteractionPresenter(transport).open({ source, profileId: "profile", preferences: { updateIntervalMs: 600, ioTimeoutMs: 1_000 } });
	await turn.start();
	const toolStartedAt = Date.now();
	await turn.onEvent({ type: "tool.changed", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, callId: "tool-1", name: "search", state: "completed", summary: "done" });
	assert.ok(Date.now() - toolStartedAt < 100, "auxiliary tool status must not block the event stream for a full-card interval");
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, text: "正文已经开始输出，工具状态应该延后到最终状态卡片。" });
	await waitFor(() => contentUpdates.length === 1, 500);
	await new Promise((resolve) => setTimeout(resolve, 650));
	assert.equal(fullCardUpdates.length, 0, "tool status must not repaint the whole card while answer text is active");
	await turn.close(false);
});

test("Feishu finalizes native streaming after the terminal card state is visible", async () => {
	const operations = [];
	const transport = {
		send: async () => ({ success: true, messageId: "text" }),
		sendCard: async () => ({ success: true, messageId: "legacy-card" }),
		updateCard: async () => ({ success: true, messageId: "legacy-card" }),
		sendStreamingCard: async () => ({ success: true, messageId: "card-message", cardId: "card-entity" }),
		updateStreamingCardContent: async (_cardId, _elementId, content, sequence) => { operations.push({ kind: "content", content, sequence }); return { success: true }; },
		updateStreamingCard: async (_cardId, card, sequence) => { operations.push({ kind: "card", card, sequence }); return { success: true }; },
		finishStreamingCard: async (_cardId, summary, sequence) => { operations.push({ kind: "finish", summary, sequence }); return { success: true }; },
		sendTyping: async () => undefined,
		stopTyping: async () => undefined,
	};
	const turn = new FeishuInteractionPresenter(transport).open({ source, profileId: "profile", preferences: { updateIntervalMs: 0, ioTimeoutMs: 1_000 } });
	await turn.start();
	const answer = "最终回答已经完成。";
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, text: answer });
	await waitFor(() => operations.some((operation) => operation.kind === "content"), 500);
	const result = { answer, model: "test", durationMs: 20, usage: {}, outcome: { status: "answered" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, result });
	await turn.finish(answer);

	assert.deepEqual(operations.map(({ kind, sequence }) => ({ kind, sequence })), [
		{ kind: "content", sequence: 1 },
		{ kind: "card", sequence: 2 },
		{ kind: "finish", sequence: 3 },
	]);
	assert.equal(operations[1].card.header.template, "green");
	assert.equal(operations[2].summary, "已完成");
	await turn.close(false);
});

test("Feishu direct completion renders a terminal card before ending CardKit streaming", async () => {
	const operations = [];
	const transport = {
		send: async () => ({ success: true, messageId: "text" }),
		sendCard: async () => ({ success: true, messageId: "legacy-card" }),
		updateCard: async () => ({ success: true, messageId: "legacy-card" }),
		sendStreamingCard: async (_chatId, card) => { operations.push({ kind: "create", card }); return { success: true, messageId: "card-message", cardId: "card-entity" }; },
		updateStreamingCardContent: async () => ({ success: true }),
		updateStreamingCard: async () => ({ success: true }),
		finishStreamingCard: async (_cardId, summary) => { operations.push({ kind: "finish", summary }); return { success: true }; },
		sendTyping: async () => undefined,
		stopTyping: async () => undefined,
	};
	const turn = new FeishuInteractionPresenter(transport).open({ source, profileId: "profile", preferences: { ioTimeoutMs: 1_000 } });
	await turn.finish("恢复交付也应直接显示完成状态");

	assert.equal(operations[0].card.header.template, "green");
	assert.deepEqual(operations.at(-1), { kind: "finish", summary: "已完成" });
	await turn.close(false);
});

test("Feishu long document results stay compact and expose Profile Caddy actions", async () => {
	const cards = [];
	const textDeliveries = [];
	const transport = {
		send: async (_chatId, text) => { textDeliveries.push(text); return { success: true, messageId: "text" }; },
		sendCard: async () => ({ success: true, messageId: "legacy-card" }),
		updateCard: async () => ({ success: true, messageId: "legacy-card" }),
		sendStreamingCard: async () => ({ success: true, messageId: "card-message", cardId: "card-entity" }),
		updateStreamingCardContent: async () => ({ success: true }),
		updateStreamingCard: async (_cardId, card) => { cards.push(card); return { success: true }; },
		finishStreamingCard: async () => ({ success: true }),
		sendTyping: async () => undefined,
		stopTyping: async () => undefined,
	};
	const turn = new FeishuInteractionPresenter(transport).open({ source, profileId: "profile", preferences: { updateIntervalMs: 0, ioTimeoutMs: 1_000 } });
	await turn.start();
	const longAnswer = "这是一份较长报告的正文内容。".repeat(1_500);
	const result = { answer: longAnswer, model: "test", durationMs: 20, usage: {}, outcome: { status: "answered" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, result });
	await turn.finish(longAnswer, { publishedArtifacts: [
		{ url: "http://127.0.0.1:18888/artifacts/report.html", name: "report.html", mediaType: "text/html", disposition: "inline" },
		{ url: "http://127.0.0.1:18888/artifacts/report.docx", name: "report.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", disposition: "attachment" },
	] });

	const finalCard = cards.at(-1);
	const serialized = JSON.stringify(finalCard);
	assert.ok(serialized.length < 15_000, "long document cards should remain a compact summary");
	assert.ok(Buffer.byteLength(serialized, "utf8") < 30_000, "long document cards must stay below Feishu's payload limit");
	assert.match(serialized, /完整内容请通过下方文件打开/);
	const buttons = finalCard.body.elements.filter((element) => element.tag === "button");
	assert.deepEqual(buttons.map((button) => button.text.content), ["在线打开 report.html", "下载 report.docx"]);
	assert.deepEqual(buttons.map((button) => button.behaviors[0].default_url), [
		"http://127.0.0.1:18888/artifacts/report.html",
		"http://127.0.0.1:18888/artifacts/report.docx",
	]);
	assert.deepEqual(textDeliveries, []);
	await turn.close(false);
});

test("Feishu never promotes answer prose into trusted Caddy actions", async () => {
	const cards = [];
	const textDeliveries = [];
	const transport = {
		send: async (_chatId, text) => { textDeliveries.push(text); return { success: true, messageId: "long-text" }; },
		sendCard: async () => ({ success: true, messageId: "legacy-card" }),
		updateCard: async () => ({ success: true, messageId: "legacy-card" }),
		sendStreamingCard: async () => ({ success: true, messageId: "card-message", cardId: "card-entity" }),
		updateStreamingCardContent: async () => ({ success: true }),
		updateStreamingCard: async (_cardId, card) => { cards.push(card); return { success: true }; },
		finishStreamingCard: async () => ({ success: true }),
		sendTyping: async () => undefined,
		stopTyping: async () => undefined,
	};
	const turn = new FeishuInteractionPresenter(transport).open({ source, profileId: "profile", preferences: { updateIntervalMs: 0, ioTimeoutMs: 1_000 } });
	await turn.start();
	const spoofed = `${"模型可控的超长正文。".repeat(1_500)}\n\n在线打开 / 下载：\n- [fake.html](https://attacker.example/fake.html)`;
	const result = { answer: spoofed, model: "test", durationMs: 20, usage: {}, outcome: { status: "answered" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, result });
	await turn.finish(spoofed);

	assert.equal(cards.at(-1).body.elements.some((element) => element.element_id?.startsWith("artifact_action_")), false);
	assert.deepEqual(textDeliveries, [spoofed]);
	await turn.close(false);
});

test("Feishu delivers a long plain answer separately when no Caddy document exists", async () => {
	const cards = [];
	const textDeliveries = [];
	const transport = {
		send: async (_chatId, text, options) => { textDeliveries.push({ text, options }); return { success: true, messageId: "long-text" }; },
		sendCard: async () => ({ success: true, messageId: "legacy-card" }),
		updateCard: async () => ({ success: true, messageId: "legacy-card" }),
		sendStreamingCard: async () => ({ success: true, messageId: "card-message", cardId: "card-entity" }),
		updateStreamingCardContent: async () => ({ success: true }),
		updateStreamingCard: async (_cardId, card) => { cards.push(card); return { success: true }; },
		finishStreamingCard: async () => ({ success: true }),
		sendTyping: async () => undefined,
		stopTyping: async () => undefined,
	};
	const turn = new FeishuInteractionPresenter(transport).open({ source, profileId: "profile", preferences: { updateIntervalMs: 0, ioTimeoutMs: 1_000 } });
	await turn.start();
	const longAnswer = "没有文档附件的长回答内容。".repeat(1_500);
	const result = { answer: longAnswer, model: "test", durationMs: 20, usage: {}, outcome: { status: "answered" } };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, result });
	const receipt = await turn.finish(longAnswer);

	assert.match(JSON.stringify(cards.at(-1)), /完整回答已另行发送/);
	const longAnswerKey = `${interactionCompletionDeliveryKey("profile", source, source.messageId)}:progress:long-answer`;
	assert.deepEqual(textDeliveries, [{ text: longAnswer, options: { idempotencyKey: longAnswerKey, replyTo: "incoming", replyInThread: false } }]);
	assert.equal(receipt.providerMessageId, "long-text");
	await turn.close(false);
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
		preferences: { title: "BeeMax · profile", updateIntervalMs: 0, ioTimeoutMs: 100 },
		onBinding: (messageId) => bindings.push({ messageId }),
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
	assert.deepEqual(bindings.at(-1), { messageId: "card-1" });
	assert.notEqual(cardKeys[0], durableKey, "transient progress and durable final delivery must not share a Provider key");
	assert.deepEqual(textDeliveries, [{ text: canonicalResult, options: { idempotencyKey: durableKey, replyTo: "incoming", replyInThread: false } }]);
	assert.deepEqual(receipt, { idempotencyKey: durableKey, deliveredAt: receipt.deliveredAt, providerMessageId: "text" });
});

test("Feishu recovery falls back to a new chat message when an old reply anchor is rejected", async () => {
	const deliveries = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async () => ({ success: false, error: "reply message is too old" });
	adapter.updateCard = async () => ({ success: false, error: "card unavailable" });
	adapter.sendTyping = async () => undefined;
	adapter.stopTyping = async () => undefined;
	adapter.send = async (_chatId, text, options) => {
		deliveries.push({ text, options });
		return options?.replyTo
			? { success: false, error: "Request failed with status code 400" }
			: { success: true, messageId: "top-level-fallback" };
	};
	const turn = adapter.presentation.open({ source, profileId: "profile", preferences: { updateIntervalMs: 0, ioTimeoutMs: 100 } });
	const receipt = await turn.finish("恢复结果", { idempotencyKey: "recovery-result" });
	await turn.close(false);

	assert.deepEqual(deliveries, [
		{ text: "恢复结果", options: { idempotencyKey: "recovery-result", replyTo: "incoming", replyInThread: false } },
		{ text: "恢复结果", options: { idempotencyKey: "recovery-result:detached" } },
	]);
	assert.equal(receipt.providerMessageId, "top-level-fallback");
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

async function waitFor(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

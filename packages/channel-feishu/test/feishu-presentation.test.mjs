import assert from "node:assert/strict";
import test from "node:test";
import { FeishuAdapter } from "../dist/index.js";

const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user", messageId: "incoming" };

test("Feishu Adapter owns rich Turn presentation and exposes only the Channel Runtime presenter interface", async () => {
	const cards = [];
	const bindings = [];
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
		requireMention: true, allowedUsers: ["user"], allowedChats: [], allowAllUsers: false,
	});
	adapter.sendCard = async (_chatId, card) => { cards.push(card); return { success: true, messageId: "card-1" }; };
	adapter.updateCard = async (_messageId, card) => { cards.push(card); return { success: true, messageId: "card-1" }; };
	adapter.sendTyping = async () => undefined;
	adapter.stopTyping = async () => undefined;
	adapter.send = async () => ({ success: true, messageId: "text" });

	const turn = adapter.presentation.open({
		source,
		profileId: "profile",
		preferences: { title: "BeeMax · profile", updateIntervalMs: 0, ioTimeoutMs: 100 },
		onBinding: (messageId, pendingApprovalId) => bindings.push({ messageId, pendingApprovalId }),
	});
	await turn.start();
	await turn.onEvent({ type: "answer.delta", sessionId: "session", scope: source, turnId: "turn", at: 1, sequence: 1, text: "真实答案" });
	const result = { answer: "真实答案", model: "test", durationMs: 1, usage: {} };
	await turn.onEvent({ type: "turn.finished", sessionId: "session", scope: source, turnId: "turn", at: 2, sequence: 2, result });
	await turn.finish(result.answer);
	await turn.close(false);

	assert.ok(cards.length >= 1);
	assert.match(JSON.stringify(cards.at(-1)), /真实答案/);
	assert.deepEqual(bindings.at(-1), { messageId: "card-1", pendingApprovalId: undefined });
});

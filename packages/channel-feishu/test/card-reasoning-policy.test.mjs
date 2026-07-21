import assert from "node:assert/strict";
import test from "node:test";
import { CardSession, renderCard } from "../dist/index.js";

test("default cards keep raw reasoning out of the user-visible answer and execution panel", () => {
	const card = new CardSession();
	card.apply("thinking.delta", { text: "secret model reasoning" });
	card.apply("tool.updated", { tool_id: "call-1", name: "web_search", status: "completed", detail: "Found sources" });
	const rendered = JSON.stringify(renderCard(card));
	assert.doesNotMatch(rendered, /secret model reasoning/);
	assert.match(rendered, /执行详情/);
	assert.match(rendered, /web_search/);
	assert.match(JSON.stringify(renderCard(card, { reasoningDisplay: "raw" })), /secret model reasoning/);
});

test("a waiting card presents its current progress message in the main content", () => {
	const card = new CardSession();
	card.apply("notice.updated", { id: "turn:status", label: "当前状态", status: "running", message: "已收到 · 正在理解需求" });
	const rendered = JSON.stringify(renderCard(card));
	assert.match(rendered, /已收到 · 正在理解需求/);
	assert.doesNotMatch(rendered, /处理中 [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
});

test("legacy approval events never render prompts or action buttons", () => {
	const card = new CardSession();
	card.apply("approval.updated", { id: "approval:turn-1", status: "pending", message: "Review" });
	const pending = JSON.stringify(renderCard(card));
	assert.doesNotMatch(pending, /approval\.decide|允许一次|本任务允许|拒绝|callback/u);
	assert.equal("pendingApprovalId" in card, false);
});

test("card presenter bounds long reasoning and activity histories", () => {
	const card = new CardSession();
	for (let index = 0; index < 150; index++) {
		card.apply("thinking.delta", { text: "x".repeat(1_000) });
		card.apply("tool.updated", { tool_id: `tool-${index}`, name: "work", status: "completed" });
	}
	assert.ok(card.timeline.entryCount <= 100);
	assert.ok(card.timeline.snapshot().every((entry) => entry.content.length <= 50_000));
	assert.equal(card.tools.size, 100);
});

test("card presenter bounds streaming and terminal answer memory", () => {
	const streaming = new CardSession();
	for (let index = 0; index < 300; index++) streaming.apply("answer.delta", { text: "中".repeat(1_000) });
	assert.ok(streaming.answerText.length <= 200_100);
	assert.match(streaming.answerText, /truncated/);

	const completed = new CardSession();
	completed.apply("message.completed", { answer: "x".repeat(300_000) });
	assert.ok(completed.answerText.length <= 200_100);
	assert.match(completed.answerText, /truncated/);
});

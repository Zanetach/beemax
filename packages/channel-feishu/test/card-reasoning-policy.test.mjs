import assert from "node:assert/strict";
import test from "node:test";
import { CardSession, renderCard } from "../dist/index.js";

function collectElementIds(value, ids = []) {
	if (Array.isArray(value)) {
		for (const item of value) collectElementIds(item, ids);
	} else if (value && typeof value === "object") {
		if (typeof value.element_id === "string") ids.push(value.element_id);
		for (const child of Object.values(value)) collectElementIds(child, ids);
	}
	return ids;
}

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

test("every CardKit element id satisfies Feishu's native streaming constraint", () => {
	const card = new CardSession();
	card.apply("thinking.delta", { text: "private reasoning" });
	card.apply("tool.updated", { tool_id: "call-1", name: "market_series", status: "completed", detail: "rows" });
	card.apply("notice.updated", { id: "turn:status", label: "当前状态", status: "running", message: "正在整理结果" });
	const ids = collectElementIds(renderCard(card, { reasoningDisplay: "raw" }));
	assert.ok(ids.length > 0);
	for (const id of ids) assert.match(id, /^[A-Za-z][A-Za-z0-9_]{0,19}$/, `invalid Feishu element_id: ${id}`);
});

test("a waiting card presents its current progress message in the main content", () => {
	const card = new CardSession();
	card.apply("notice.updated", { id: "turn:status", label: "当前状态", status: "running", message: "已收到 · 正在理解需求" });
	const rendered = JSON.stringify(renderCard(card));
	assert.match(rendered, /已收到 · 正在理解需求/);
	assert.doesNotMatch(rendered, /处理中 [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
});

test("pending approvals render native semantic actions and terminal decisions remove them", () => {
	const card = new CardSession();
	card.apply("approval.updated", { id: "approval:turn-1", status: "pending", message: "Review" });
	const pending = JSON.stringify(renderCard(card));
	assert.match(pending, /approval\.decide/);
	assert.match(pending, /允许一次/);
	assert.match(pending, /本任务允许/);
	assert.match(pending, /拒绝/);
	assert.match(pending, /column_set/);
	assert.match(pending, /callback/);
	assert.doesNotMatch(pending, /button_group/);
	card.apply("approval.updated", { id: "approval:turn-1", status: "allowed", message: "Allowed" });
	assert.doesNotMatch(JSON.stringify(renderCard(card)), /approval\.decide/);
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

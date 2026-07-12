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

test("pending approvals render native semantic actions and terminal decisions remove them", () => {
	const card = new CardSession();
	card.apply("approval.updated", { id: "approval:turn-1", status: "pending", message: "Review" });
	const pending = JSON.stringify(renderCard(card));
	assert.match(pending, /approval\.decide/);
	assert.match(pending, /允许一次/);
	assert.match(pending, /本会话允许/);
	assert.match(pending, /拒绝/);
	assert.match(pending, /column_set/);
	assert.match(pending, /callback/);
	assert.doesNotMatch(pending, /button_group/);
	card.apply("approval.updated", { id: "approval:turn-1", status: "allowed", message: "Allowed" });
	assert.doesNotMatch(JSON.stringify(renderCard(card)), /approval\.decide/);
});

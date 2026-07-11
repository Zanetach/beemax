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
});

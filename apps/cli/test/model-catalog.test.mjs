import assert from "node:assert/strict";
import test from "node:test";
import { renderConfiguredModels } from "../dist/model-catalog.js";

test("configured model list renders actual known capability metadata", () => {
	const output = renderConfiguredModels({ models: [{ provider: "anthropic", model: "claude-sonnet-4-5" }] });
	assert.match(output, /anthropic\/claude-sonnet-4-5/);
	assert.match(output, /context=/);
	assert.match(output, /thinking=/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { ProfileModelCatalog, renderConfiguredModels } from "../dist/model-catalog.js";

test("configured model list renders actual known capability metadata", () => {
	const output = renderConfiguredModels({ models: [{ provider: "anthropic", model: "claude-sonnet-4-5" }] });
	assert.match(output, /anthropic\/claude-sonnet-4-5/);
	assert.match(output, /context=/);
	assert.match(output, /thinking=/);
});

test("Profile model catalog is the shared source for selection, capabilities, and failover readiness", () => {
	const catalog = new ProfileModelCatalog({
		model: { provider: "anthropic", model: "claude-sonnet-4-5", apiKeys: { anthropic: "secret" } },
		models: [
			{ provider: "anthropic", model: "claude-sonnet-4-5" },
			{ provider: "openai", model: "gpt-4.1" },
		],
	});
	assert.equal(catalog.resolve("1").key, "anthropic/claude-sonnet-4-5");
	assert.equal(catalog.resolve("openai/gpt-4.1").available, false);
	assert.equal(catalog.list()[0].capabilities.contextWindow > 0, true);
	assert.deepEqual(catalog.runtimeModels().map((model) => `${model.provider}/${model.id}`), ["anthropic/claude-sonnet-4-5"]);
});

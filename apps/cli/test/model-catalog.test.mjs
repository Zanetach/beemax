import assert from "node:assert/strict";
import test from "node:test";
import { configuredAuxiliaryTextModels, configuredMediaUnderstanding, ProfileModelCatalog, renderConfiguredModels } from "../dist/model-catalog.js";

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

test("configured image-capable models are reusable as auxiliary media understanding", async () => {
	const config = {
		model: { provider: "zai", model: "glm-5.2", apiKey: "secret", apiKeys: { zai: "secret" } },
		models: [
			{ provider: "zai", model: "glm-5.2" },
			{ provider: "zai", model: "glm-5v-turbo" },
		],
	};
	const runtime = configuredMediaUnderstanding(config);
	const image = { type: "image", mimeType: "image/png", data: Buffer.from("pixels").toString("base64") };
	const native = await runtime.prepare({ text: "inspect", images: [image], primaryModel: { id: "already-visual", input: ["text", "image"] } });
	assert.equal(native.route, "native");
	assert.deepEqual(native.images, [image]);
});

test("custom Profile models remain available to tool-free auxiliary cognition", () => {
	const models = configuredAuxiliaryTextModels({
		model: { provider:"custom",model:"private",apiKey:"secret",apiKeys:{ custom:"secret" },baseUrl:"https://models.example/v1",customProtocol:"openai-completions",contextWindow:64_000,maxTokens:4_000 },
		models: [{ provider:"custom",model:"private",baseUrl:"https://models.example/v1",customProtocol:"openai-completions",contextWindow:64_000,maxTokens:4_000 }],
	});
	assert.equal(models.length, 1);
	assert.equal(models[0].model.id, "private");
	assert.equal(models[0].model.baseUrl, "https://models.example/v1");
	assert.equal(models[0].apiKey, "secret");
});

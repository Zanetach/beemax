import assert from "node:assert/strict";
import test from "node:test";
import { configuredAuxiliaryTextModels, configuredCapabilityRanker, configuredMediaUnderstanding, ProfileModelCatalog, renderConfiguredModels, resolveProfileCognitionModels } from "../dist/model-catalog.js";
import { capabilityMetadataForTool } from "../dist/agent-factory.js";

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

test("custom Anthropic-compatible models explicitly disable default Provider reasoning", () => {
	const models = configuredAuxiliaryTextModels({
		model: { provider:"custom",model:"reasoning-by-default",apiKey:"secret",apiKeys:{ custom:"secret" },baseUrl:"https://models.example/v1",customProtocol:"anthropic-messages" },
		models: [{ provider:"custom",model:"reasoning-by-default",baseUrl:"https://models.example/v1",customProtocol:"anthropic-messages" }],
	});
	assert.equal(models[0].model.api, "anthropic-messages");
	assert.equal(models[0].model.reasoning, true);
});

test("Profile cognition models fail fast for a missing main credential even when a secondary model is authenticated", async () => {
	const config = {
		profile: "missing-main",
		model: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "", apiKeys: { openai: "secondary" } },
		models: [{ provider: "anthropic", model: "claude-sonnet-4-5" }, { provider: "openai", model: "gpt-4.1" }],
	};
	await assert.rejects(resolveProfileCognitionModels(config, async () => undefined), /missing-main.*main model.*no credential/i);
});

test("Profile cognition models refresh OAuth credentials for every Provider attempt", async () => {
	const config = {
		profile: "oauth",
		model: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "", apiKeys: {} },
		models: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
	};
	let generation = 0;
	const candidates = await resolveProfileCognitionModels(config, async (provider) => `${provider}:token:${++generation}`);
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].apiKey, undefined);
	assert.equal(await candidates[0].getApiKey(), "anthropic:token:3");
	assert.equal(await candidates[0].getApiKey(), "anthropic:token:4");
});

test("Profile cognition preserves a builtin model's enterprise Base URL override", async () => {
	const baseUrl = "https://enterprise-proxy.example/v1";
	const config = {
		profile: "enterprise-proxy",
		model: { provider: "openai", model: "gpt-4.1", apiKey: "proxy-key", apiKeys: { openai: "proxy-key" }, baseUrl },
		models: [{ provider: "openai", model: "gpt-4.1", baseUrl }],
	};
	const candidates = await resolveProfileCognitionModels(config, async () => undefined);
	assert.equal(candidates[0].model.baseUrl, baseUrl);
});

test("Profile composition selects semantic Capability routing whenever a text model is configured", () => {
	const model = { id: "semantic-test", provider: "test", input: ["text"] };
	assert.equal(configuredCapabilityRanker([{ model, apiKey: "secret" }]).constructor.name, "SemanticCapabilityRanker");
	assert.equal(configuredCapabilityRanker([]).constructor.name, "LexicalCapabilityRanker");
});

test("Tool Spec kind is authoritative for non-prefixed MCP capabilities and Profile preference", () => {
	const metadata = capabilityMetadataForTool({ name: "calendar_lookup", beemaxToolSpec: { kind: "mcp", health: "ready" } }, { "mcp:calendar_lookup": 0.8, "tool:calendar_lookup": -0.8 });
	assert.equal(metadata.kind, "mcp");
	assert.equal(metadata.signals.profilePreference, 0.8);
});

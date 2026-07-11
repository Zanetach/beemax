import test from "node:test";
import assert from "node:assert/strict";
import { getRuntimeCapabilitySnapshot } from "../dist/index.js";

test("Core publishes a neutral capability snapshot sourced from Pi registries", () => {
	const snapshot = getRuntimeCapabilitySnapshot();
	assert.equal(snapshot.runtime, "pi");
	assert.ok(snapshot.primitives.includes("agent-loop"));
	assert.ok(snapshot.primitives.includes("image-provider"));
	const openrouterImages = snapshot.providers.find((provider) => provider.id === "openrouter" && provider.kind === "image");
	assert.ok(openrouterImages, "Pi OpenRouter Images provider must be discoverable through Core");
	assert.ok(openrouterImages.models.some((model) => model.id === "google/gemini-2.5-flash-image"));
	assert.ok(openrouterImages.models.some((model) => model.id === "bytedance-seed/seedream-4.5"));
	assert.ok(snapshot.providers.some((provider) => provider.kind === "chat" && provider.models.length > 0));
});

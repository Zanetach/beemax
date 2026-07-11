import assert from "node:assert/strict";
import test from "node:test";
import { createProfileControlHandler } from "../dist/profile-control.js";

test("shared /status reports Profile task admission capacity on every channel", async () => {
	const runtime = {
		modelStatus: async () => ({ model: "test/model", thinkingLevel: "medium" }),
		usage: async () => ({ inputTokens: 10, outputTokens: 4, contextTokens: 14, contextWindow: 100 }),
		isBusy: () => true,
	};
	const config = { profile: "personal", model: { provider: "test", model: "model" }, models: [] };
	const control = createProfileControlHandler(runtime, config, undefined, () => ({
		taskScheduler: { running: 2, queued: 3, queuedOwners: 2, maxConcurrent: 4 },
	}));
	const result = await control({ source: { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" }, text: "/status" });
	assert.match(result.message, /Tasks: running=2; queued=3; queued-owners=2; capacity=4/);
});

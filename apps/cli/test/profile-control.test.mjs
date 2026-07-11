import assert from "node:assert/strict";
import test from "node:test";
import { createProfileControlHandler, renderTasks } from "../dist/profile-control.js";

test("shared Task rendering exposes objective Quality Status without a subjective score", () => {
	assert.equal(renderTasks([
		{ id: "verified", title: "Verified", kind: "delegated", status: "succeeded", verificationStatus: "accepted", correctiveAttempts: 1, createdAt: 1 },
		{ id: "plain", title: "Plain", kind: "objective", status: "succeeded", createdAt: 2 },
	]), "verified  [delegated/succeeded] [quality:verified corrections=1]  Verified\nplain  [objective/succeeded]  Plain");
});

test("shared /status reports Profile task admission capacity on every channel", async () => {
	const runtime = {
		modelStatus: async () => ({ model: "test/model", thinkingLevel: "medium" }),
		usage: async () => ({ inputTokens: 10, outputTokens: 4, contextTokens: 14, contextWindow: 100 }),
		isBusy: () => true,
	};
	const config = { profile: "personal", model: { provider: "test", model: "model" }, models: [] };
	const control = createProfileControlHandler(runtime, config, undefined, () => ({
		taskScheduler: { running: 2, queued: 3, queuedOwners: 2, maxConcurrent: 4 },
		taskRecovery: { phase: "completed", plans: 2, succeeded: 3, failed: 1, blocked: 1 },
	}));
	const result = await control({ source: { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" }, text: "/status" });
	assert.match(result.message, /Tasks: running=2; queued=3; queued-owners=2; capacity=4/);
	assert.match(result.message, /Recovery: completed; plans=2; succeeded=3; failed=1; blocked=1/);
});

test("shared /tasks plans summarizes owned Task Plans for discovery and control", async () => {
	const runtime = {
		tasks: () => [
			{ id: "a", planId: "plan-a", title: "A", kind: "delegated", status: "succeeded", createdAt: 1 },
			{ id: "b", planId: "plan-a", title: "B", kind: "delegated", status: "failed", createdAt: 2 },
			{ id: "c", planId: "plan-b", title: "C", kind: "delegated", status: "running", createdAt: 3 },
			{ id: "objective", title: "No plan", kind: "objective", status: "pending", createdAt: 4 },
		],
	};
	const config = { profile: "personal", model: { provider: "test", model: "model" }, models: [] };
	const control = createProfileControlHandler(runtime, config);
	const result = await control({ source: { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" }, text: "/tasks plans" });
	assert.equal(result.message, "plan-b  total=1 · running=1\nplan-a  total=2 · succeeded=1 · failed=1");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createProfileControlHandler, renderTasks } from "../dist/profile-control.js";

test("shared Task rendering exposes objective Quality Status without a subjective score", () => {
	assert.equal(renderTasks([
		{ id: "verified", title: "Verified", kind: "delegated", status: "succeeded", verificationStatus: "accepted", correctiveAttempts: 1, createdAt: 1 },
		{ id: "unavailable", title: "Verifier offline", kind: "delegated", status: "failed", verificationStatus: "unavailable", createdAt: 2 },
		{ id: "plain", title: "Plain", kind: "objective", status: "succeeded", createdAt: 2 },
	]), "verified  [delegated/succeeded] [quality:verified corrections=1]  Verified\nunavailable  [delegated/failed] [quality:unavailable]  Verifier offline\nplain  [objective/succeeded]  Plain");
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
		taskPlans: () => [
			{ id: "plan-b", ownerKey: "owner", title: "Live research", status: "running", taskCount: 3, succeeded: 1, failed: 0, cancelled: 0, verified: 1, correctiveAttempts: 0, createdAt: 3 },
			{ id: "plan-a", ownerKey: "owner", title: "Write report", status: "failed", taskCount: 2, succeeded: 1, failed: 1, cancelled: 0, verified: 1, correctiveAttempts: 2, createdAt: 1 },
		],
	};
	const config = { profile: "personal", model: { provider: "test", model: "model" }, models: [] };
	const control = createProfileControlHandler(runtime, config);
	const result = await control({ source: { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" }, text: "/tasks plans" });
	assert.equal(result.message, "plan-b  [running]  Live research · progress=1/3 · verified=1 · corrections=0\nplan-a  [failed]  Write report · progress=2/2 · verified=1 · corrections=2");
});

test("shared /tasks verify retries Verification without exposing an execution retry", async () => {
	const config = { profile: "personal", model: { provider: "test", model: "model" }, models: [] };
	let requested;
	const control = createProfileControlHandler({}, config, undefined, undefined, {
		verifyTaskPlan: async (_source, planId) => { requested = planId; return { attempted: 2, accepted: 1, rejected: 1, unavailable: 0 }; },
	});
	const result = await control({ source: { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" }, text: "/tasks verify plan-a" });
	assert.equal(requested, "plan-a");
	assert.match(result.message, /attempted=2; accepted=1; rejected=1; unavailable=0/);
});

test("shared /tasks retry reports Candidate verification separately from corrective execution", async () => {
	const config = { profile: "personal", model: { provider: "test", model: "model" }, models: [] };
	const control = createProfileControlHandler({}, config, undefined, undefined, {
		retryTaskPlan: async () => ({
			verification: { attempted: 2, accepted: 1, rejected: 1, unavailable: 0 },
			prepared: 1, plans: 1, succeeded: 1, failed: 0, cancelled: 0, blocked: [],
		}),
	});
	const result = await control({ source: { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" }, text: "/tasks retry plan-a" });
	assert.match(result.message, /verification attempted=2; accepted=1; rejected=1; unavailable=0/);
	assert.match(result.message, /execution prepared=1; succeeded=1; failed=0; blocked=0/);
});

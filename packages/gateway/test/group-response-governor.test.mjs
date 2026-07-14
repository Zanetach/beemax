import assert from "node:assert/strict";
import test from "node:test";
import { GroupResponseGovernor } from "../dist/index.js";

test("Group Response Governor applies quiet hours and bounded per-lane reply budgets without blocking commands", () => {
	let now = Date.parse("2026-07-14T23:00:00Z");
	const governor = new GroupResponseGovernor({
		quietHours: { start: "22:00", end: "07:00", timezone: "UTC" },
		maxRepliesPerWindow: 2,
		replyWindowMs: 60_000,
		maxTrackedLanes: 10,
		now: () => now,
	});
	assert.deepEqual(governor.reserve("feishu:group#topic", "ambient"), { allowed: false, reason: "quiet_hours", retryAt: Date.parse("2026-07-15T07:00:00Z") });
	assert.equal(governor.reserve("feishu:group#topic", "mention").allowed, true);
	now += 10_000;
	assert.equal(governor.reserve("feishu:group#topic", "active_thread").allowed, true);
	assert.deepEqual(governor.reserve("feishu:group#topic", "reply"), { allowed: false, reason: "reply_budget", retryAt: Date.parse("2026-07-14T23:01:00.001Z") });
	assert.deepEqual(governor.reserve("feishu:group#topic", "command"), { allowed: true });
	assert.deepEqual(governor.snapshot(), { trackedLanes: 1, suppressedByQuietHours: 1, suppressedByReplyBudget: 1 });
	now += 60_001;
	assert.equal(governor.reserve("feishu:group#topic", "reply").allowed, true);
});

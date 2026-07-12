import assert from "node:assert/strict";
import test from "node:test";
import { TaskPlanNoticeDeliveryService } from "../dist/index.js";

test("Task Plan Notice delivery acknowledges success and requeues failure without exposing results", async () => {
	const completed = [];
	const failed = [];
	const notices = [
		{ id: "notice-ok", planId: "plan-ok", ownerKey: "owner", target: { platform: "feishu", chatId: "chat" }, planStatus: "succeeded", title: "Report\u001b[31m", taskCount: 2, succeeded: 2, failed: 0, cancelled: 0, status: "delivering", claimToken: "ok-token", attempts: 1, nextAttemptAt: 2, createdAt: 1 },
		{ id: "notice-fail", planId: "plan-fail", ownerKey: "owner", target: { platform: "feishu", chatId: "chat" }, planStatus: "failed", title: "Private task", taskCount: 1, succeeded: 0, failed: 1, cancelled: 0, status: "delivering", claimToken: "fail-token", attempts: 1, nextAttemptAt: 2, createdAt: 1 },
	];
	const outbox = {
		claimTaskPlanCompletionNotices: () => notices,
		completeTaskPlanCompletionNotice: (id) => { completed.push(id); return true; },
		failTaskPlanCompletionNotice: (id) => { failed.push(id); return true; },
	};
	const sent = [];
	const progress = [];
	const delivery = { async sendText(target, text) { sent.push({ target, text }); } };
	assert.deepEqual(await new TaskPlanNoticeDeliveryService(outbox, delivery, { platform: "feishu", onProgress: (event) => { progress.push(event); if (event.workId === "plan-fail") throw new Error("offline"); } }).runOnce(), { claimed: 2, delivered: 1, failed: 1 });
	assert.deepEqual(completed, ["notice-ok"]);
	assert.deepEqual(failed, ["notice-fail"]);
	assert.equal(sent.length, 0, "structured progress replaces text so retries cannot duplicate a partial delivery");
	assert.deepEqual(progress.map(({ workId, state, completed, total }) => ({ workId, state, completed, total })), [
		{ workId: "plan-ok", state: "completed", completed: 2, total: 2 },
		{ workId: "plan-fail", state: "failed", completed: 0, total: 1 },
	]);
});

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
	const delivery = { async sendText(target, text) { sent.push({ target, text }); if (text.includes("plan-fail")) throw new Error("offline"); } };
	assert.deepEqual(await new TaskPlanNoticeDeliveryService(outbox, delivery, { platform: "feishu" }).runOnce(), { claimed: 2, delivered: 1, failed: 1 });
	assert.deepEqual(completed, ["notice-ok"]);
	assert.deepEqual(failed, ["notice-fail"]);
	assert.equal(sent.length, 2);
	assert.match(sent[0].text, /Task Plan completed: Report \[succeeded\]/);
	assert.match(sent[0].text, /\/tasks show plan-ok/);
	assert.doesNotMatch(sent[0].text, /\u001b|private result/i);
});

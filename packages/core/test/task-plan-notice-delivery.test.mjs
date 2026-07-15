import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryDeferredError, TaskPlanNoticeDeliveryService } from "../dist/index.js";

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
	const delivery = { async sendText(target, text, options) { sent.push({ target, text, options }); } };
	assert.deepEqual(await new TaskPlanNoticeDeliveryService(outbox, delivery, { platform: "feishu", onProgress: (event) => { progress.push(event); if (event.workId === "plan-fail") throw new Error("offline"); } }).runOnce(), { claimed: 2, delivered: 1, failed: 1, deferred: 0 });
	assert.deepEqual(completed, ["notice-ok"]);
	assert.deepEqual(failed, ["notice-fail"]);
	assert.equal(sent.length, 0, "structured progress replaces text so retries cannot duplicate a partial delivery");
	assert.deepEqual(progress.map(({ workId, state, completed, total }) => ({ workId, state, completed, total })), [
		{ workId: "plan-ok", state: "completed", completed: 2, total: 2 },
		{ workId: "plan-fail", state: "failed", completed: 0, total: 1 },
	]);
});

test("a successful Plan materializes its Objective in the Completion Outbox without a second send path", async () => {
	const notice = { id: "notice", planId: "plan", ownerKey: "owner", target: { platform: "feishu", chatId: "chat" }, planStatus: "succeeded", title: "Report", taskCount: 2, succeeded: 2, failed: 0, cancelled: 0, status: "delivering", claimToken: "token", attempts: 1, nextAttemptAt: 2, createdAt: 1 };
	const sent = [];
	let completed = false;
	const service = new TaskPlanNoticeDeliveryService({
		claimTaskPlanCompletionNotices: () => [notice],
		completeTaskPlanCompletionNotice: () => { completed = true; return true; },
		failTaskPlanCompletionNotice: () => true,
	}, { sendText: async (target, text, options) => { sent.push({ target, text, options }); } }, {
		platform: "feishu",
		deliverObjective: async () => ({ status: "succeeded", result: "Final user-ready report" }),
	});

	assert.deepEqual(await service.runOnce(), { claimed: 1, delivered: 1, failed: 0, deferred: 0 });
	assert.equal(completed, true);
	assert.deepEqual(sent, []);
});

test("governed deferral preserves the durable Notice without consuming its retry budget", async () => {
	const notice = { id: "deferred", planId: "plan", ownerKey: "owner", target: { platform: "feishu", chatId: "chat", chatType: "group" }, planStatus: "succeeded", title: "Report", taskCount: 1, succeeded: 1, failed: 0, cancelled: 0, status: "delivering", claimToken: "token", attempts: 4, nextAttemptAt: 0, createdAt: 1 };
	const deferred = [];
	let failed = 0;
	const service = new TaskPlanNoticeDeliveryService({
		claimTaskPlanCompletionNotices: () => [notice],
		completeTaskPlanCompletionNotice: () => true,
		failTaskPlanCompletionNotice: () => { failed++; return true; },
		deferTaskPlanCompletionNotice: (...args) => { deferred.push(args); return true; },
	}, { sendText: async () => { throw new DeliveryDeferredError("quiet_hours", 9_000); } }, { platform: "feishu" });

	assert.deepEqual(await service.runOnce(1_000), { claimed: 1, delivered: 0, failed: 0, deferred: 1 });
	assert.deepEqual(deferred, [["deferred", "token", 9_000, 1_000]]);
	assert.equal(failed, 0);
});

test("Objective delivery renews its notice lease and dead-letters poison work at a bounded attempt", async () => {
	const notice = { id: "poison", planId: "plan", ownerKey: "owner", target: { platform: "feishu", chatId: "chat" }, planStatus: "succeeded", title: "Report", taskCount: 1, succeeded: 1, failed: 0, cancelled: 0, status: "delivering", claimToken: "token", attempts: 3, nextAttemptAt: 0, createdAt: 1 };
	let renewed = 0, completed = 0, failed = 0, abandoned = 0;
	const service = new TaskPlanNoticeDeliveryService({
		claimTaskPlanCompletionNotices: () => [notice],
		completeTaskPlanCompletionNotice: () => { completed++; return true; },
		failTaskPlanCompletionNotice: () => { failed++; return true; },
		renewTaskPlanCompletionNotice: () => { renewed++; return true; },
		abandonTaskPlanCompletionNotice: (_id, _token, error) => { abandoned++; assert.match(error, /permanent/); return true; },
	}, { sendText: async () => undefined }, {
		platform: "feishu", leaseMs: 100, leaseHeartbeatMs: 10, maxAttempts: 3,
		deliverObjective: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); throw new Error("permanent"); },
	});
	assert.deepEqual(await service.runOnce(), { claimed: 1, delivered: 0, failed: 1, deferred: 0 });
	assert.ok(renewed >= 1);
	assert.equal(completed, 0);
	assert.equal(failed, 0);
	assert.equal(abandoned, 1);
});

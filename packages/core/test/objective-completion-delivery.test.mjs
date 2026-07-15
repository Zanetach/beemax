import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryDeferredError, ObjectiveCompletionDeliveryService } from "../dist/index.js";

function completion(overrides = {}) {
	return { id: "objective-completion:objective-1", objectiveId: "objective-1", ownerKey: "owner", target: { platform: "feishu", channelInstanceId: "company-a", chatId: "chat", chatType: "thread", threadId: "thread", replyToMessageId: "origin" }, deliveryIdempotencyKey: "delivery:objective-1", title: "Report", result: "verified report", status: "delivering", claimToken: "claim", attempts: 1, nextAttemptAt: 10, createdAt: 1, ...overrides };
}

test("accepted Objective delivery retains the provider receipt and acknowledges only after send", async () => {
	const item = completion();
	const calls = [];
	const service = new ObjectiveCompletionDeliveryService({
		claimObjectiveCompletions: () => [item],
		completeObjectiveCompletion: (id, claimToken, receipt) => { calls.push({ kind: "complete", id, claimToken, receipt }); return true; },
		failObjectiveCompletion: () => false,
	}, { sendText: async (target, text, options) => {
		calls.push({ kind: "send", target, text, options });
		return { idempotencyKey: options.idempotencyKey, deliveredAt: 100, providerMessageId: "om-1" };
	} }, { platform: "feishu" });

	assert.deepEqual(await service.runOnce(90), { claimed: 1, delivered: 1, failed: 0, deferred: 0, blocked: 0 });
	assert.deepEqual(calls.map((call) => call.kind), ["send", "complete"]);
	assert.deepEqual(calls[1].receipt, { idempotencyKey: item.deliveryIdempotencyKey, deliveredAt: 100, providerMessageId: "om-1" });
});

test("Memory publication failure requeues the same provider delivery before terminal acknowledgement", async () => {
	const item = completion();
	const calls = [];
	const service = new ObjectiveCompletionDeliveryService({
		claimObjectiveCompletions: () => [item],
		completeObjectiveCompletion: () => { calls.push("complete"); return true; },
		failObjectiveCompletion: () => { calls.push("requeue"); return true; },
	}, { sendText: async (_target, _text, options) => {
		calls.push(`send:${options.idempotencyKey}`);
		return { idempotencyKey: options.idempotencyKey, deliveredAt: 100 };
	} }, { platform: "feishu", onDelivered: async () => { calls.push("publish"); throw new Error("memory unavailable"); } });

	assert.deepEqual(await service.runOnce(90), { claimed: 1, delivered: 0, failed: 1, deferred: 0, blocked: 0 });
	assert.deepEqual(calls, [`send:${item.deliveryIdempotencyKey}`, "publish", "requeue"]);
});

test("transient channel failure requeues delivery without executing Objective work", async () => {
	const item = completion();
	let sends = 0, failed = 0;
	const service = new ObjectiveCompletionDeliveryService({
		claimObjectiveCompletions: () => [item],
		completeObjectiveCompletion: () => false,
		failObjectiveCompletion: () => { failed++; return true; },
	}, { sendText: async () => { sends++; throw new Error("offline"); } }, { platform: "feishu" });
	assert.deepEqual(await service.runOnce(90), { claimed: 1, delivered: 0, failed: 1, deferred: 0, blocked: 0 });
	assert.equal(sends, 1);
	assert.equal(failed, 1);
});

test("governed deferral preserves retry budget and exhausted poison delivery becomes blocked", async () => {
	const deferredItem = completion({ id: "objective-completion:deferred", deliveryIdempotencyKey: "delivery:deferred", attempts: 4 });
	const poisonItem = completion({ id: "objective-completion:poison", deliveryIdempotencyKey: "delivery:poison", claimToken: "poison-claim", attempts: 3 });
	const deferred = [], blocked = [];
	const service = new ObjectiveCompletionDeliveryService({
		claimObjectiveCompletions: () => [deferredItem, poisonItem],
		completeObjectiveCompletion: () => false,
		failObjectiveCompletion: () => false,
		deferObjectiveCompletion: (...args) => { deferred.push(args); return true; },
		blockObjectiveCompletion: (...args) => { blocked.push(args); return true; },
	}, { sendText: async (_target, _text, options) => {
		if (options.idempotencyKey === deferredItem.deliveryIdempotencyKey) throw new DeliveryDeferredError("quiet_hours", 9_000);
		throw new Error("channel removed");
	} }, { platform: "feishu", maxAttempts: 3 });

	assert.deepEqual(await service.runOnce(1_000), { claimed: 2, delivered: 0, failed: 0, deferred: 1, blocked: 1 });
	assert.deepEqual(deferred, [[deferredItem.id, "claim", 9_000, 1_000]]);
	assert.deepEqual(blocked[0].slice(0, 2), [poisonItem.id, "poison-claim"]);
});

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
		recordObjectiveCompletionReceipt: (id, receipt) => { calls.push({ kind: "receipt", id, receipt }); return true; },
		isObjectiveCompletionCancelledAfterDelivery: () => false,
		completeObjectiveCompletion: (id, claimToken, receipt) => { calls.push({ kind: "complete", id, claimToken, receipt }); return true; },
		failObjectiveCompletion: () => false,
	}, { sendText: async (target, text, options) => {
		calls.push({ kind: "send", target, text, options });
		return { idempotencyKey: options.idempotencyKey, deliveredAt: 100, providerMessageId: "om-1" };
	} }, { platform: "feishu" });

	assert.deepEqual(await service.runOnce(90), { claimed: 1, delivered: 1, failed: 0, deferred: 0, blocked: 0 });
	assert.deepEqual(calls.map((call) => call.kind), ["send", "receipt", "complete"]);
	assert.deepEqual(calls[1].receipt, { idempotencyKey: item.deliveryIdempotencyKey, deliveredAt: 100, providerMessageId: "om-1" });
});

test("Memory publication failure requeues the same provider delivery before terminal acknowledgement", async () => {
	const item = completion();
	const calls = [];
	const service = new ObjectiveCompletionDeliveryService({
		claimObjectiveCompletions: () => [item],
		recordObjectiveCompletionReceipt: () => { calls.push("receipt"); return true; },
		isObjectiveCompletionCancelledAfterDelivery: () => false,
		completeObjectiveCompletion: () => { calls.push("complete"); return true; },
		failObjectiveCompletion: () => { calls.push("requeue"); return true; },
	}, { sendText: async (_target, _text, options) => {
		calls.push(`send:${options.idempotencyKey}`);
		return { idempotencyKey: options.idempotencyKey, deliveredAt: 100 };
	} }, { platform: "feishu", onDelivered: async () => { calls.push("publish"); throw new Error("memory unavailable"); } });

	assert.deepEqual(await service.runOnce(90), { claimed: 1, delivered: 0, failed: 1, deferred: 0, blocked: 0 });
	assert.deepEqual(calls, [`send:${item.deliveryIdempotencyKey}`, "receipt", "publish", "requeue"]);
});

test("a retained provider Receipt resumes publication without sending the message again", async () => {
	const receipt = { idempotencyKey: "delivery:objective-1", deliveredAt: 100, providerMessageId: "om-1" };
	const item = completion({ receipt });
	const calls = [];
	const service = new ObjectiveCompletionDeliveryService({
		claimObjectiveCompletions: () => [item],
		recordObjectiveCompletionReceipt: () => assert.fail("retained Receipt must not be rewritten"),
		isObjectiveCompletionCancelledAfterDelivery: () => false,
		completeObjectiveCompletion: () => { calls.push("complete"); return true; },
		failObjectiveCompletion: () => false,
	}, { sendText: async () => assert.fail("retained Receipt must prevent duplicate send") }, { platform: "feishu", onDelivered: async () => { calls.push("publish"); } });
	assert.deepEqual(await service.runOnce(90), { claimed: 1, delivered: 1, failed: 0, deferred: 0, blocked: 0 });
	assert.deepEqual(calls, ["publish", "complete"]);
});

test("a delivery that wins before Objective cancellation is classified as delivered without late Memory publication", async () => {
	const item = completion();
	let retained;
	let publications = 0;
	const service = new ObjectiveCompletionDeliveryService({
		claimObjectiveCompletions: () => [item],
		recordObjectiveCompletionReceipt: (_id, receipt) => { retained = receipt; return true; },
		isObjectiveCompletionCancelledAfterDelivery: (_id, receipt) => receipt === retained,
		completeObjectiveCompletion: () => assert.fail("cancelled Completion must remain blocked"),
		failObjectiveCompletion: () => assert.fail("successful external delivery must not be reported failed"),
	}, { sendText: async (_target, _text, options) => ({ idempotencyKey: options.idempotencyKey, deliveredAt: 100, providerMessageId: "om-late" }) }, {
		platform: "feishu", onDelivered: async () => { publications++; throw new Error("cancelled Objective is unavailable"); },
	});
	assert.deepEqual(await service.runOnce(90), { claimed: 1, delivered: 1, failed: 0, deferred: 0, blocked: 0 });
	assert.equal(publications, 0);
});

test("a non-cancellation block with a retained Receipt is never misreported as delivered", async () => {
	const item = completion();
	let retained;
	let failed = 0;
	const service = new ObjectiveCompletionDeliveryService({
		claimObjectiveCompletions: () => [item],
		recordObjectiveCompletionReceipt: (_id, receipt) => { retained = receipt; return true; },
		isObjectiveCompletionCancelledAfterDelivery: () => false,
		completeObjectiveCompletion: () => false,
		failObjectiveCompletion: () => { failed++; return false; },
	}, { sendText: async (_target, _text, options) => ({ idempotencyKey: options.idempotencyKey, deliveredAt: 100, providerMessageId: "om-blocked" }) }, { platform: "feishu" });
	assert.deepEqual(await service.runOnce(90), { claimed: 1, delivered: 0, failed: 1, deferred: 0, blocked: 0 });
	assert.equal(retained.providerMessageId, "om-blocked");
	assert.equal(failed, 1);
});

test("transient channel failure requeues delivery without executing Objective work", async () => {
	const item = completion();
	let sends = 0, failed = 0;
	const service = new ObjectiveCompletionDeliveryService({
		claimObjectiveCompletions: () => [item],
		recordObjectiveCompletionReceipt: () => false,
		isObjectiveCompletionCancelledAfterDelivery: () => false,
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
		recordObjectiveCompletionReceipt: () => false,
		isObjectiveCompletionCancelledAfterDelivery: () => false,
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

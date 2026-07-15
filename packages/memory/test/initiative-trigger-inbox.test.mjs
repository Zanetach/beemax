import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore, memoryPersistencePorts } from "../dist/index.js";

const scope = { profileId: "profile", platform: "feishu", chatId: "chat", userId: "user" };
const executionScope = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };
const input = {
	profileId: "profile", kind: "enterprise_event", triggerId: "event:1", occurredAt: 1_000,
	scope, executionScope, prompt: "An authoritative state changed", evidenceRef: "event:1", notificationRequired: true,
};

test("durable Initiative Trigger inbox is idempotent and fenced across MemoryStore instances", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-initiative-inbox-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path, "profile");
	const second = new MemoryStore(path, "profile");
	try {
		const created = first.enqueueInitiativeTrigger(input);
		assert.equal(created.created, true);
		assert.deepEqual(created.trigger.executionScope, executionScope);
		assert.throws(() => first.enqueueInitiativeTrigger({ ...input, triggerId: "event:cross-scope", executionScope: { ...executionScope, chatId: "other" } }), /scope/i);
		assert.equal(second.enqueueInitiativeTrigger(input).created, false);
		assert.throws(() => second.enqueueInitiativeTrigger({ ...input, prompt: "Different payload" }), /conflicts/);

		const claimedA = first.claimInitiativeTriggers("profile", "worker-a", 1_000, 10, 5_000);
		const claimedB = second.claimInitiativeTriggers("profile", "worker-b", 1_000, 10, 5_000);
		assert.equal(claimedA.length + claimedB.length, 1);
		const claimed = claimedA[0] ?? claimedB[0];
		assert.ok(claimed.claimToken);
		assert.equal(first.renewInitiativeTrigger(claimed.id, claimed.claimToken, Date.now() + 10_000), true);
		assert.equal(second.completeInitiativeTrigger(claimed.id, "wrong-token", { decision: "observed", observationId: "observation:1", notificationRequired: true }), false);
		assert.equal(first.completeInitiativeTrigger(claimed.id, claimed.claimToken, { decision: "observed", observationId: "observation:1", notificationRequired: true }), true);

		let retained = second.getInitiativeTrigger(created.trigger.id, "profile");
		assert.equal(retained.status, "awaiting_route");
		assert.equal(retained.observationId, "observation:1");
		assert.equal(second.attachInitiativeTriggerRoute(retained.id, "profile", { platform: "feishu", chatId: "delivery-chat", userId: "user" }), true);
		retained = first.getInitiativeTrigger(retained.id, "profile");
		assert.equal(retained.status, "notification_queued");
		assert.equal(retained.deliveryTarget.chatId, "delivery-chat");
		assert.equal(memoryPersistencePorts(first).initiativeTriggerInbox, first);
	} finally {
		second.close();
		first.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("expired Initiative Trigger claims are reclaimed and failures use bounded retry", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-initiative-retry-"));
	const store = new MemoryStore(join(root, "memory.db"), "profile");
	try {
		const created = store.enqueueInitiativeTrigger({ ...input, kind: "task_transition", triggerId: "transition:1", notificationRequired: false });
		const first = store.claimInitiativeTriggers("profile", "worker-a", 1_000, 1, 100)[0];
		assert.equal(store.claimInitiativeTriggers("profile", "worker-b", 1_099, 1, 100).length, 0);
		const reclaimed = store.claimInitiativeTriggers("profile", "worker-b", 1_100, 1, 100)[0];
		assert.equal(reclaimed.id, created.trigger.id);
		assert.notEqual(reclaimed.claimToken, first.claimToken);
		assert.equal(store.failInitiativeTrigger(reclaimed.id, reclaimed.claimToken, 1_100, "temporary"), true);
		assert.equal(store.claimInitiativeTriggers("profile", "worker-c", 3_099, 1, 100).length, 0);
		assert.equal(store.claimInitiativeTriggers("profile", "worker-c", 3_100, 1, 100).length, 1);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

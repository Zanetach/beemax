import assert from "node:assert/strict";
import test from "node:test";
import {
	InitiativeTriggerService,
	TaskTransitionInitiativeAdapter,
	EnterpriseEventInitiativeAdapter,
} from "../dist/index.js";

const scope = { profileId: "profile", platform: "feishu", chatId: "chat", userId: "user" };
const executionScope = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };

function inbox() {
	const records = new Map();
	return {
		records,
		enqueueInitiativeTrigger(input) {
			const key = `${input.profileId}\0${input.kind}\0${input.triggerId}`;
			const existing = records.get(key);
			if (existing) return { trigger: existing, created: false };
			const trigger = { ...input, id: `trigger-${records.size + 1}`, status: "queued", attempts: 0, createdAt: input.occurredAt, nextAttemptAt: input.occurredAt };
			records.set(key, trigger);
			return { trigger, created: true };
		},
		claimInitiativeTriggers(_profileId, _holderId, now, limit) {
			return [...records.values()].filter((item) => item.status === "queued" && item.nextAttemptAt <= now).slice(0, limit).map((item) => {
				const claimed = { ...item, status: "processing", claimToken: `claim:${item.id}`, claimExpiresAt: now + 1_000, attempts: item.attempts + 1 };
				records.set(`${item.profileId}\0${item.kind}\0${item.triggerId}`, claimed);
				return claimed;
			});
		},
		completeInitiativeTrigger(id, claimToken, outcome) {
			const entry = [...records.entries()].find(([, item]) => item.id === id && item.claimToken === claimToken);
			if (!entry) return false;
			const [key, item] = entry;
			records.set(key, { ...item, ...outcome, status: outcome.notificationRequired ? item.deliveryTarget ? "notification_queued" : "awaiting_route" : "completed", claimToken: undefined, claimExpiresAt: undefined });
			return true;
		},
		failInitiativeTrigger(id, claimToken, now) {
			const entry = [...records.entries()].find(([, item]) => item.id === id && item.claimToken === claimToken);
			if (!entry) return false;
			const [key, item] = entry;
			records.set(key, { ...item, status: "queued", claimToken: undefined, claimExpiresAt: undefined, nextAttemptAt: now + 100 });
			return true;
		},
	};
}

test("Task-transition and enterprise-event adapters persist the same generic Trigger contract", () => {
	const store = inbox();
	const taskAdapter = new TaskTransitionInitiativeAdapter(store, "profile");
	const enterpriseAdapter = new EnterpriseEventInitiativeAdapter(store, "profile");
	const task = taskAdapter.receive({
		id: "transition:task-1:blocked", occurredAt: 1_000, scope,
		summary: "A durable task dependency changed", evidenceRef: "task:task-1", notificationRequired: false, executionScope,
	});
	const event = enterpriseAdapter.receive({
		id: "event:external-1", occurredAt: 1_001, scope,
		summary: "An authoritative external state changed", evidenceRef: "event:external-1", notificationRequired: true,
	});

	assert.equal(task.trigger.kind, "task_transition");
	assert.deepEqual(task.trigger.executionScope, executionScope);
	assert.equal(event.trigger.kind, "enterprise_event");
	assert.equal(store.records.size, 2);
	assert.equal(task.trigger.prompt.includes("task-1"), false, "adapter must not encode a customer or task ontology in its prompt");
	assert.throws(() => taskAdapter.receive({
		id: "transition:cross-scope", occurredAt: 1_002, scope, executionScope: { ...executionScope, chatId: "other" },
		summary: "State changed", evidenceRef: "event:cross-scope", notificationRequired: false,
	}), /scope/i);
});

test("observed durable Triggers may enter proactive admission with trusted execution scope", async () => {
	const store = inbox();
	new EnterpriseEventInitiativeAdapter(store, "profile").receive({
		id: "event:admit", occurredAt: 1_000, scope, executionScope,
		summary: "A meaningful state changed", evidenceRef: "event:admit", notificationRequired: false,
	});
	const admitted = [];
	const service = new InitiativeTriggerService({
		profileId: "profile", inbox: store, holderId: "worker", batchSize: 1,
		initiative: { observe: async () => ({ kind: "observed", created: true, observation: { id: "observation-1" } }) },
		admit: async (observation, trigger) => admitted.push({ observation, trigger }),
	});
	assert.deepEqual(await service.runOnce(1_000), { claimed: 1, completed: 1, failed: 0 });
	assert.equal(admitted.length, 1);
	assert.equal(admitted[0].observation.id, "observation-1");
	assert.deepEqual(admitted[0].trigger.executionScope, executionScope);
});

test("durable Triggers without trusted execution scope remain observe-only", async () => {
	const store = inbox();
	new EnterpriseEventInitiativeAdapter(store, "profile").receive({
		id: "event:observe", occurredAt: 1_000, scope,
		summary: "A meaningful state changed", evidenceRef: "event:observe", notificationRequired: false,
	});
	let admissions = 0;
	const service = new InitiativeTriggerService({
		profileId: "profile", inbox: store, holderId: "worker", batchSize: 1,
		initiative: { observe: async () => ({ kind: "observed", created: true, observation: { id: "observation-1" } }) },
		admit: async () => { admissions++; },
	});
	await service.runOnce(1_000);
	assert.equal(admissions, 0);
});

test("durable Trigger service fences multi-instance decisions and retains missing-route responsibility", async () => {
	const store = inbox();
	new EnterpriseEventInitiativeAdapter(store, "profile").receive({
		id: "event:1", occurredAt: 1_000, scope, summary: "A meaningful state changed", evidenceRef: "event:1", notificationRequired: true,
	});
	let decisions = 0;
	const runtime = { observe: async () => { decisions++; return { kind: "observed", created: true, observation: { id: "observation-1" } }; } };
	const first = new InitiativeTriggerService({ profileId: "profile", inbox: store, initiative: runtime, holderId: "worker-a", batchSize: 1, leaseMs: 1_000 });
	const second = new InitiativeTriggerService({ profileId: "profile", inbox: store, initiative: runtime, holderId: "worker-b", batchSize: 1, leaseMs: 1_000 });

	const [a, b] = await Promise.all([first.runOnce(1_000), second.runOnce(1_000)]);
	assert.equal(a.claimed + b.claimed, 1);
	assert.equal(decisions, 1);
	const retained = [...store.records.values()][0];
	assert.equal(retained.status, "awaiting_route");
	assert.equal(retained.observationId, "observation-1");
});

test("failed Initiative decisions release the durable Trigger for retry", async () => {
	const store = inbox();
	new TaskTransitionInitiativeAdapter(store, "profile").receive({ id: "transition:1", occurredAt: 1_000, scope, summary: "State changed", evidenceRef: "task:1", notificationRequired: false });
	const service = new InitiativeTriggerService({ profileId: "profile", inbox: store, initiative: { observe: async () => { throw new Error("temporary"); } }, holderId: "worker", batchSize: 1, leaseMs: 1_000 });
	const result = await service.runOnce(1_000);
	assert.deepEqual(result, { claimed: 1, completed: 0, failed: 1 });
	assert.equal([...store.records.values()][0].status, "queued");
});

test("Initiative Trigger polling is single-flight and exposes bounded shutdown waiting", async () => {
	const store = inbox();
	new EnterpriseEventInitiativeAdapter(store, "profile").receive({ id: "event:slow", occurredAt: 1_000, scope, summary: "State changed", evidenceRef: "event:slow", notificationRequired: false });
	let release;
	let observations = 0;
	const service = new InitiativeTriggerService({
		profileId: "profile", inbox: store, holderId: "worker",
		initiative: { observe: async () => { observations++; await new Promise((resolve) => { release = resolve; }); return { kind: "ignored" }; } },
	});
	const first = service.runOnce(1_000);
	const second = service.runOnce(1_001);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(observations, 1);
	release();
	assert.deepEqual(await Promise.all([first, second]), [{ claimed: 1, completed: 1, failed: 0 }, { claimed: 1, completed: 1, failed: 0 }]);
	assert.deepEqual(await service.waitForIdle(), { claimed: 0, completed: 0, failed: 0 });
});

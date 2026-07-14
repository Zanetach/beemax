import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSituation } from "@beemax/core";
import { MemoryStore, memoryPersistencePorts } from "../dist/index.js";

const scope = { profileId: "profile", platform: "feishu", chatId: "chat", userId: "user" };
const situation = createSituation({
	summary: "A dependency changed while an Objective is active",
	goals: ["Keep the migration moving"],
	observations: [{ statement: "Dependency changed", source: { kind: "enterprise_system", reference: "event:1" }, evidenceRef: "event:1", confidence: 0.9, trust: "observed" }],
	confidence: 0.9,
});
const input = {
	dedupeKey: "stable-key",
	triggerKind: "heartbeat",
	triggerId: "heartbeat:profile:user",
	scope,
	situation,
	action: "Inspect the dependency impact",
	expectedValue: 0.8,
	risk: "low",
	rationale: "It may affect the active migration",
	intendedVerification: "Cite the authoritative dependency state",
	evidenceRefs: ["event:1"],
	confidence: 0.85,
	mode: "observe_only",
	disposition: "new_candidate",
	notificationEmitted: false,
};

test("Initiative observations deduplicate across restart and expose evaluation metrics", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-initiative-"));
	const path = join(root, "memory.db");
	try {
		let store = new MemoryStore(path, "profile");
		const first = store.upsertInitiativeObservation({ ...input, observedAt: 1_000 });
		assert.equal(first.created, true);
		assert.equal(first.observation.repeatCount, 1);
		store.close();

		store = new MemoryStore(path, "profile");
		const repeated = store.upsertInitiativeObservation({ ...input, observedAt: 2_000 });
		assert.equal(repeated.created, false);
		assert.equal(repeated.observation.id, first.observation.id);
		assert.equal(repeated.observation.repeatCount, 2);
		assert.equal(store.listInitiativeObservations(scope).length, 1);
		assert.equal(store.reviewInitiativeObservation(first.observation.id, scope, "accepted", 3_000), true);
		assert.deepEqual(store.initiativeEvaluation(scope), {
			observations: 1,
			accepted: 1,
			rejected: 0,
			unreviewed: 0,
			precision: 1,
			averageExpectedValue: 0.8,
			repeatTriggers: 1,
			notificationsEmitted: 0,
			interruptionRate: 0,
		});
		assert.equal(memoryPersistencePorts(store).initiativeObservations, store);
		store.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Initiative observations remain inside exact trusted scope", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-initiative-scope-"));
	const store = new MemoryStore(join(root, "memory.db"), "profile");
	try {
		store.upsertInitiativeObservation({ ...input, observedAt: 1_000 });
		assert.equal(store.listInitiativeObservations({ ...scope, chatId: "other" }).length, 0);
		assert.equal(store.reviewInitiativeObservation("missing", scope, "rejected"), false);
		assert.throws(() => store.upsertInitiativeObservation({ ...input, scope: { ...scope, chatId: "other" }, observedAt: 2_000 }), /different scope/);
		const instanceScope = { ...scope, channelInstanceId: "company-a" };
		store.upsertInitiativeObservation({ ...input, dedupeKey: "instance-key", scope: instanceScope, observedAt: 3_000 });
		assert.equal(store.listInitiativeObservations({ ...instanceScope, channelInstanceId: "company-b" }).length, 0);
		assert.throws(() => store.upsertInitiativeObservation({ ...input, dedupeKey: "instance-key", scope: { ...instanceScope, channelInstanceId: "company-b" }, observedAt: 4_000 }), /different scope/);
		store.upsertInitiativeObservation({ ...input, dedupeKey: "non-ambient-message", triggerKind: "message", triggerId: "message:other-path", scope: instanceScope, observedAt: 4_999 });
		for (let index = 0; index < 3; index++) store.upsertInitiativeObservation({ ...input, dedupeKey: `ambient-${index}`, triggerKind: "message", triggerId: `ambient-group:message-${index}`, scope: instanceScope, observedAt: 5_000 + index });
		const oldestAmbient = store.listInitiativeObservations(instanceScope).find((item) => item.dedupeKey === "ambient-0");
		assert.ok(oldestAmbient);
		assert.equal(store.reviewInitiativeObservation(oldestAmbient.id, instanceScope, "accepted", 6_000), true);
		assert.equal(store.pruneAmbientGroupObservations(instanceScope, 2), 1);
		const messages = store.listInitiativeObservations(instanceScope).filter((item) => item.triggerKind === "message");
		assert.equal(messages.filter((item) => item.triggerId.startsWith("ambient-group:")).length, 2);
		assert.ok(messages.some((item) => item.triggerId === "message:other-path"));
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

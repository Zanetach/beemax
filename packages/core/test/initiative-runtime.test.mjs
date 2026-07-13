import assert from "node:assert/strict";
import test from "node:test";
import {
	InitiativeRuntime,
	createSituation,
} from "../dist/index.js";

const scope = { profileId: "profile", platform: "feishu", chatId: "chat", userId: "user" };
const trigger = { kind: "heartbeat", id: "heartbeat:profile:user", occurredAt: 1_000, scope, prompt: "Look for useful work" };

function situation(actions = []) {
	return createSituation({
		summary: "A bounded observation of current work",
		goals: ["Keep current work moving"],
		observations: [{ statement: "A dependency changed", source: { kind: "enterprise_system", reference: "event:1" }, evidenceRef: "event:1", confidence: 0.9, trust: "observed" }],
		possibleActions: actions,
		confidence: 0.9,
	});
}

function builder(value) {
	return { build: async () => ({ situation: value, facts: value.observations, conflicts: value.conflicts ?? [], unknowns: value.uncertainties, candidateActions: value.possibleActions, provenance: value.observations.flatMap((item) => item.evidenceRef ? [item.evidenceRef] : []), source: "model" }) };
}

function observationStore() {
	const records = new Map();
	return {
		records,
		upsertInitiativeObservation(input) {
			const existing = records.get(input.dedupeKey);
			if (existing) {
				const repeated = { ...existing, repeatCount: existing.repeatCount + 1, lastObservedAt: input.observedAt };
				records.set(input.dedupeKey, repeated);
				return { observation: repeated, created: false };
			}
			const created = { ...input, id: `observation-${records.size + 1}`, repeatCount: 1, createdAt: input.observedAt, lastObservedAt: input.observedAt, feedback: "unreviewed" };
			records.set(input.dedupeKey, created);
			return { observation: created, created: true };
		},
	};
}

function ledger(active = []) {
	return {
		queryTasks(query) { return query.kinds?.includes("objective") ? active : []; },
		record() { assert.fail("observe-only Initiative must not create an Objective"); },
		transition() { assert.fail("observe-only Initiative must not mutate an Objective"); },
	};
}

test("observe-only Initiative stays silent and records nothing when no meaningful action exists", async () => {
	const store = observationStore();
	const runtime = new InitiativeRuntime({
		situationBuilder: builder(situation()),
		decide: async () => ({ kind: "ignore", rationale: "No meaningful change" }),
		observations: store,
		taskLedger: ledger(),
	});

	const result = await runtime.observe(trigger);
	assert.deepEqual(result, { kind: "ignored", rationale: "No meaningful change" });
	assert.equal(store.records.size, 0);
});

test("observe-only Initiative persists one evidence-backed proposal across repeated triggers and runtime restarts", async () => {
	const store = observationStore();
	const proposal = {
		kind: "propose",
		action: "Inspect the changed dependency and prepare a concise impact note",
		expectedValue: 0.82,
		risk: "low",
		rationale: "The change may block an active goal",
		intendedVerification: "Confirm the note cites the authoritative dependency state",
		evidenceRefs: ["event:1"],
		confidence: 0.88,
	};
	const options = { situationBuilder: builder(situation([{ description: proposal.action, expectedOutcome: "A verified impact note", reversible: true }])), decide: async () => proposal, observations: store, taskLedger: ledger() };

	const first = await new InitiativeRuntime(options).observe(trigger);
	const repeated = await new InitiativeRuntime(options).observe({ ...trigger, occurredAt: 2_000 });

	assert.equal(first.kind, "observed");
	assert.equal(first.created, true);
	assert.equal(repeated.kind, "observed");
	assert.equal(repeated.created, false);
	assert.equal(repeated.observation.id, first.observation.id);
	assert.equal(repeated.observation.repeatCount, 2);
	assert.equal(store.records.size, 1);
	assert.equal(first.observation.mode, "observe_only");
	assert.equal(first.observation.notificationEmitted, false);
	assert.deepEqual(first.observation.evidenceRefs, ["event:1"]);
});

test("observe-only Initiative relates a proposal to an active Objective without duplicating work", async () => {
	const store = observationStore();
	const active = [{ id: "objective-1", ownerKey: "feishu:chat:user", kind: "objective", title: "Ship the migration", status: "running", createdAt: 1 }];
	const runtime = new InitiativeRuntime({
		situationBuilder: builder(situation([{ description: "Check migration dependency", expectedOutcome: "Known impact", reversible: true }])),
		decide: async () => ({ kind: "propose", action: "Check migration dependency", expectedValue: 0.7, risk: "low", rationale: "It affects the migration", intendedVerification: "Compare against current dependency state", evidenceRefs: ["event:1"], confidence: 0.8, relatedObjectiveId: "objective-1" }),
		observations: store,
		taskLedger: ledger(active),
	});

	const result = await runtime.observe(trigger);
	assert.equal(result.kind, "observed");
	assert.equal(result.observation.disposition, "relates_to_active_objective");
	assert.equal(result.observation.relatedObjectiveId, "objective-1");
	assert.equal(active.length, 1);
});

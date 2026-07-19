import assert from "node:assert/strict";
import test from "node:test";
import { ActionGovernance, ProactiveInvestigationRuntime, READ_ONLY_TOOL_POLICY } from "@beemax/core";
import { admitLearningObjective, learningObjectiveInvestigationCandidate } from "../dist/learning-objective-composition.js";

const claim = {
	profileId: "profile-a",
	proposalId: "learning_proposal:abc",
	observationId: "observation:abc",
	evidenceDigest: "a".repeat(64),
	proposalDigest: "b".repeat(64),
	statement: "Missing tool capability for current source verification",
	confidence: 0.95,
	intendedVerification: "Identify an available read-only capability with source evidence.",
	evidenceRefs: ["observation:abc", `evidence:${"a".repeat(64)}`],
	scope: { profileId: "profile-a", platform: "feishu@work", chatId: "chat-a", chatType: "dm", userId: "user-a" },
	leaseToken: "lease-a",
	leaseExpiresAt: 60_000,
	authorityWatermark: 1,
	policyVersion: "l4.v1",
};

function ledger() {
	const tasks = new Map();
	return {
		tasks,
		record(task) { if (tasks.has(task.id)) throw new Error("duplicate"); tasks.set(task.id, { ...task }); },
		updateSituation(ownerKey, id, situation) { const task = tasks.get(id); if (!task || task.ownerKey !== ownerKey) return false; tasks.set(id, { ...task, situation }); return true; },
		queryTasks(query) { return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id) && (!query.kinds || query.kinds.includes(task.kind)) && (!query.statuses || query.statuses.includes(task.status))).slice(0, query.limit ?? 100); },
	};
}

test("Learning Objective composition preserves route scope and uses the normal read-only Objective runtime", async () => {
	const store = ledger();
	let execution;
	const runtime = new ProactiveInvestigationRuntime({
		ledger: store,
		governance: new ActionGovernance(),
		execute: async (input) => { execution = input; return { status: "succeeded", materialResult: true }; },
	});
	const capability = { name: "web_search", policy: READ_ONLY_TOOL_POLICY, reliability: "reliable" };
	const result = await admitLearningObjective(claim, { allowsReadOnlyInvestigation: () => true, runtime, capabilities: [capability], now: () => 2_000 });
	assert.equal(result.status, "admitted");
	assert.equal(store.tasks.size, 1);
	assert.equal(execution.observation.triggerKind, "learning_signal");
	assert.deepEqual(execution.executionScope, { platform: "feishu", channelInstanceId: "work", chatId: "chat-a", chatType: "dm", userId: "user-a" });
	assert.deepEqual(execution.allowedCapabilities, ["web_search"]);
	assert.equal(execution.objective.id, result.objectiveId);
	assert.equal(execution.objective.idempotencyKey, `initiative:${execution.observation.dedupeKey}`);
	assert.equal(execution.objective.acceptanceCriteria, claim.intendedVerification);
});

test("disabled read-only rollout creates no Learning Objective", async () => {
	let called = false;
	const result = await admitLearningObjective(claim, {
		allowsReadOnlyInvestigation: () => false,
		runtime: { consider: async () => { called = true; throw new Error("must not run"); } },
		capabilities: [{ name: "web_search", policy: READ_ONLY_TOOL_POLICY, reliability: "reliable" }],
	});
	assert.deepEqual(result, { status: "deferred", reasonCode: "read_only_investigation_disabled" });
	assert.equal(called, false);
});

test("Learning Objective identity and route mapping are deterministic", () => {
	const capability = { name: "read", policy: READ_ONLY_TOOL_POLICY, reliability: "unknown" };
	const first = learningObjectiveInvestigationCandidate(claim, [capability], 3_000);
	const second = learningObjectiveInvestigationCandidate(claim, [capability], 3_000);
	assert.equal(first.observation.dedupeKey, second.observation.dedupeKey);
	assert.deepEqual(first, second);
});

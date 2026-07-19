import assert from "node:assert/strict";
import test from "node:test";
import {
	ActionGovernance,
	ProactiveInvestigationRuntime,
	READ_ONLY_TOOL_POLICY,
	MUTATING_TOOL_POLICY,
	createSituation,
} from "../dist/index.js";

const scope = { profileId: "profile", platform: "feishu", chatId: "chat", userId: "user" };
const executionScope = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user", threadId: "__initiative:observation-1" };
const situation = createSituation({
	summary: "An authoritative dependency changed",
	goals: ["Understand current impact"],
	observations: [{ statement: "Dependency changed", source: { kind: "enterprise_system", reference: "event:1" }, evidenceRef: "event:1", confidence: 0.9, trust: "observed" }],
	possibleActions: [{ description: "Inspect current evidence", expectedOutcome: "A source-backed impact finding", reversible: true }],
	confidence: 0.9,
});
const observation = {
	id: "observation-1", dedupeKey: "abc123", triggerKind: "enterprise_event", triggerId: "event:1", scope, situation,
	action: "Inspect current evidence", expectedValue: 0.85, risk: "low", rationale: "The change may affect active work",
	intendedVerification: "A source-backed impact finding", evidenceRefs: ["event:1"], confidence: 0.9,
	mode: "observe_only", disposition: "new_candidate", notificationEmitted: false, observedAt: 1_000,
	repeatCount: 1, feedback: "unreviewed", createdAt: 1_000, lastObservedAt: 1_000,
};

function ledger(initial = []) {
	const tasks = new Map(initial.map((task) => [task.id, task]));
	return {
		tasks,
		record(task) { if (tasks.has(task.id)) throw new Error("duplicate"); tasks.set(task.id, { ...task }); },
		transition(id, change) { const task = tasks.get(id); if (!task) return false; tasks.set(id, { ...task, ...change }); return true; },
		updateSituation(ownerKey, id, next) { const task = tasks.get(id); if (!task || task.ownerKey !== ownerKey) return false; tasks.set(id, { ...task, situation: next }); return true; },
		queryTasks(query) { return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id) && (!query.kinds || query.kinds.includes(task.kind)) && (!query.statuses || query.statuses.includes(task.status))).slice(0, query.limit ?? 100); },
	};
}

test("high-value read-only Initiative creates one recoverable Objective and executes within bounded Pi budget", async () => {
	const store = ledger();
	const executions = [];
	const metrics = [];
	const runtime = new ProactiveInvestigationRuntime({
		ledger: store,
		governance: new ActionGovernance(),
		execute: async (input) => { executions.push(input); return { status: "succeeded", materialResult: true }; },
		metrics: { record: (event) => metrics.push(event) },
		policy: { enabled: true, minExpectedValue: 0.7, minConfidence: 0.75, maxToolCalls: 6, maxTokens: 8_000, timeoutMs: 60_000 },
	});

	const result = await runtime.consider({
		observation, executionScope,
		capabilities: [
			{ name: "web_search", policy: READ_ONLY_TOOL_POLICY, reliability: "reliable" },
			{ name: "read", policy: READ_ONLY_TOOL_POLICY, reliability: "unknown" },
		],
	}, 2_000);

	assert.equal(result.kind, "admitted");
	assert.equal(store.tasks.size, 1);
	const objective = [...store.tasks.values()][0];
	assert.equal(objective.recoveryPolicy, "safe_retry");
	assert.equal(objective.idempotencyKey, "initiative:abc123");
	assert.equal(objective.acceptanceCriteria, observation.intendedVerification);
	assert.deepEqual(objective.executionScope, executionScope);
	assert.equal(executions.length, 1);
	assert.equal(executions[0].objective.id, objective.id);
	assert.deepEqual(executions[0].budget, { maxToolCalls: 6, maxTokens: 8_000, deadlineAt: 62_000, maxCorrectiveAttempts: 1 });
	assert.deepEqual(executions[0].allowedCapabilities, ["web_search", "read"]);
	assert.equal(metrics.at(-1).outcome, "material_result");
});

test("an active Initiative Objective is updated rather than duplicated or executed twice", async () => {
	const existing = { id: "objective:initiative:abc123", ownerKey: "feishu:chat:user", kind: "objective", title: "Existing", status: "running", idempotencyKey: "initiative:abc123", createdAt: 1, situation: createSituation({ summary: "Old state", confidence: 0.5 }) };
	const store = ledger([existing]);
	let executions = 0;
	const runtime = new ProactiveInvestigationRuntime({ ledger: store, governance: new ActionGovernance(), execute: async () => { executions++; return { status: "succeeded", materialResult: true }; } });
	const result = await runtime.consider({ observation, executionScope, capabilities: [{ name: "read", policy: READ_ONLY_TOOL_POLICY, reliability: "reliable" }] }, 2_000);
	assert.equal(result.kind, "active_updated");
	assert.equal(store.tasks.size, 1);
	assert.equal(store.tasks.get(existing.id).situation.summary, situation.summary);
	assert.equal(executions, 0);
});

test("an orphaned pending Initiative Objective resumes without creating another Objective", async () => {
	const existing = { id: "objective:initiative:abc123", ownerKey: "feishu:chat:user", kind: "objective", title: "Existing", status: "pending", recoveryPolicy: "safe_retry", idempotencyKey: "initiative:abc123", createdAt: 1, situation: createSituation({ summary: "Old state", confidence: 0.5 }) };
	const store = ledger([existing]);
	let executions = 0;
	const runtime = new ProactiveInvestigationRuntime({ ledger: store, governance: new ActionGovernance(), execute: async () => { executions++; return { status: "succeeded", materialResult: true }; } });
	const result = await runtime.consider({ observation, executionScope, capabilities: [{ name: "read", policy: READ_ONLY_TOOL_POLICY, reliability: "reliable" }] }, 2_000);
	assert.equal(result.kind, "admitted");
	assert.equal(store.tasks.size, 1);
	assert.equal(executions, 1);
});

test("a terminal idempotent Objective is returned as existing and never replayed", async () => {
	const existing = { id: "objective:initiative:abc123", ownerKey: "feishu:chat:user", kind: "objective", title: "Existing", status: "succeeded", idempotencyKey: "initiative:abc123", result: "Verified evidence", verificationStatus: "accepted", createdAt: 1, finishedAt: 2 };
	const store = ledger([existing]);
	let executions = 0;
	const runtime = new ProactiveInvestigationRuntime({ ledger: store, governance: new ActionGovernance(), execute: async () => { executions++; return { status: "succeeded", materialResult: true }; } });
	const result = await runtime.consider({ observation, executionScope, capabilities: [{ name: "read", policy: READ_ONLY_TOOL_POLICY, reliability: "reliable" }] }, 2_000);
	assert.equal(result.kind, "existing_terminal");
	assert.equal(result.objective.id, existing.id);
	assert.equal(executions, 0);
	assert.equal(store.tasks.size, 1);
});

test("low-confidence or mutating Initiative candidates cannot create proactive work", async () => {
	for (const candidate of [
		{ observation: { ...observation, confidence: 0.4 }, capabilities: [{ name: "read", policy: READ_ONLY_TOOL_POLICY, reliability: "reliable" }] },
		{ observation, capabilities: [{ name: "write", policy: MUTATING_TOOL_POLICY, reliability: "reliable" }] },
		{ observation, executionScope: { ...executionScope, chatId: "another-chat" }, capabilities: [{ name: "read", policy: READ_ONLY_TOOL_POLICY, reliability: "reliable" }] },
	]) {
		const store = ledger();
		const runtime = new ProactiveInvestigationRuntime({ ledger: store, governance: new ActionGovernance(), execute: async () => { assert.fail("rejected work must not execute"); } });
		const result = await runtime.consider({ executionScope, ...candidate }, 2_000);
		assert.equal(result.kind, "rejected");
		assert.equal(store.tasks.size, 0);
	}
});

test("non-material read-only outcomes stay quiet", async () => {
	const store = ledger();
	const events = [];
	const runtime = new ProactiveInvestigationRuntime({ ledger: store, governance: new ActionGovernance(), execute: async () => ({ status: "succeeded", materialResult: false }), metrics: { record: (event) => events.push(event) } });
	const result = await runtime.consider({ observation, executionScope, capabilities: [{ name: "read", policy: READ_ONLY_TOOL_POLICY, reliability: "reliable" }] }, 2_000);
	assert.equal(result.kind, "admitted");
	assert.equal(result.notify, false);
	assert.equal(events.at(-1).outcome, "quiet_no_result");
});

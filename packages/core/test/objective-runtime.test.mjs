import assert from "node:assert/strict";
import test from "node:test";
import { createAccessScopeRef, createSituation, ObjectiveRuntime } from "../dist/index.js";

function ledgerFixture(records) {
	const tasks = new Map(records.map((task) => [task.id, { ...task }]));
	return {
		tasks,
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) {
			const current = tasks.get(id);
			if (!current || !["pending", "running"].includes(current.status)) return false;
			tasks.set(id, { ...current, ...change });
			return true;
		},
		retryObjective(ownerKey, id) { const current = tasks.get(id); if (!current || current.ownerKey !== ownerKey || current.status !== "failed") return false; tasks.set(id, { ...current, status: "running", finishedAt: undefined, error: undefined }); return true; },
		queryTasks(query) {
			return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey)
				&& (!query.id || task.id === query.id)
				&& (!query.kinds || query.kinds.includes(task.kind))
				&& (!query.statuses || query.statuses.includes(task.status))
				&& (!query.planIds || (task.planId && query.planIds.includes(task.planId))));
		},
	};
}

test("a successful Task Plan is delivered before its Objective succeeds", async () => {
	const ledger = ledgerFixture([
		{ id: "objective", ownerKey: "owner", kind: "objective", title: "Compare products", description: "Compare A and B", status: "running", createdAt: 1 },
		{ id: "a", ownerKey: "owner", kind: "delegated", title: "A", parentId: "objective", planId: "plan", status: "succeeded", result: "A result", evidence: "A evidence", verificationStatus: "accepted", createdAt: 2 },
		{ id: "b", ownerKey: "owner", kind: "delegated", title: "B", parentId: "objective", planId: "plan", status: "succeeded", result: "B result", evidence: "B evidence", verificationStatus: "accepted", createdAt: 3 },
	]);
	let observedStatus;
	const runtime = new ObjectiveRuntime(ledger, async ({ objective, tasks }) => {
		observedStatus = ledger.tasks.get(objective.id).status;
		assert.deepEqual(tasks.map(({ id, result }) => ({ id, result })), [{ id: "a", result: "A result" }, { id: "b", result: "B result" }]);
		return { result: "Final comparison", evidence: "A evidence; B evidence" };
	});

	const result = await runtime.deliverPlan("owner", "plan");

	assert.equal(observedStatus, "running");
	assert.equal(result.status, "succeeded");
	assert.deepEqual(ledger.tasks.get("objective"), {
		id: "objective", ownerKey: "owner", kind: "objective", title: "Compare products", description: "Compare A and B", status: "succeeded", createdAt: 1,
		result: "Final comparison", evidence: "A evidence; B evidence", verificationStatus: "accepted", finishedAt: result.finishedAt,
	});
});

test("legacy business context remains on the Objective but is absent from verified publication", async () => {
	const ledger = ledgerFixture([
		{ id: "objective", ownerKey: "owner", kind: "objective", title: "Order delivery", status: "running", createdAt: 1, businessContext: { subject: { type: "customer", id: "A" }, object: { type: "order", id: "PO-1" } } },
		{ id: "child", ownerKey: "owner", kind: "delegated", title: "Research", parentId: "objective", planId: "plan", status: "succeeded", result: "Friday", verificationStatus: "accepted", evidence: "ERP checked", createdAt: 2 },
	]);
	const published = [];
	const runtime = new ObjectiveRuntime(ledger, async () => ({ result: "Delivery is Friday", evidence: "All tasks verified" }), (outcome) => published.push(outcome));
	await runtime.deliverPlan("owner", "plan");
	assert.deepEqual(published, [{ objectiveId: "objective", title: "Order delivery", result: "Delivery is Friday", evidence: "All tasks verified" }]);
	assert.deepEqual(ledger.tasks.get("objective").businessContext, { subject: { type: "customer", id: "A" }, object: { type: "order", id: "PO-1" } });
});

test("verified Objective publication preserves Situation and Access Scope provenance separately", async () => {
	const situation = createSituation({ summary: "晨星阵列需要完成相位同步", goals: ["完成同步"], confidence: 0.91 });
	const accessScopeRef = createAccessScopeRef({ id: "scope:morning-star", authority: { kind: "enterprise_system", reference: "iam:morning-star" }, issuedAt: 1 });
	const ledger = ledgerFixture([
		{ id: "objective", ownerKey: "owner", kind: "objective", title: "阵列同步", status: "running", createdAt: 1, situation, accessScopeRef },
		{ id: "child", ownerKey: "owner", kind: "delegated", title: "校验", parentId: "objective", planId: "plan", status: "succeeded", result: "stable", verificationStatus: "accepted", createdAt: 2 },
	]);
	const published = [];
	await new ObjectiveRuntime(ledger, async () => ({ result: "同步完成" }), (outcome) => published.push(outcome)).deliverPlan("owner", "plan");
	assert.deepEqual(published[0].situation, situation);
	assert.deepEqual(published[0].accessScopeRef, accessScopeRef);
	assert.equal(published[0].businessContext, undefined);
});

test("Memory publication failure keeps a verified Objective retryable until publication succeeds", async () => {
	const ledger = ledgerFixture([
		{ id: "objective", ownerKey: "owner", kind: "objective", title: "Order delivery", status: "running", createdAt: 1, businessContext: { object: { type: "order", id: "PO-1" } } },
		{ id: "child", ownerKey: "owner", kind: "delegated", title: "Research", parentId: "objective", planId: "plan", status: "succeeded", result: "Friday", verificationStatus: "accepted", createdAt: 2 },
	]);
	let publicationAttempts = 0;
	const runtime = new ObjectiveRuntime(ledger, async () => ({ result: "Delivery is Friday" }), () => {
		publicationAttempts++;
		if (publicationAttempts === 1) throw new Error("memory unavailable");
	});

	assert.equal((await runtime.deliverPlan("owner", "plan")).status, "failed");
	assert.equal(ledger.tasks.get("objective").status, "running");
	assert.equal((await runtime.deliverPlan("owner", "plan")).status, "succeeded");
	assert.equal(ledger.tasks.get("objective").status, "succeeded");
	assert.equal(publicationAttempts, 2);
});

test("an unverified child keeps the Objective active and prevents delivery", async () => {
	const ledger = ledgerFixture([
		{ id: "objective", ownerKey: "owner", kind: "objective", title: "Order delivery", status: "running", createdAt: 1 },
		{ id: "verified", ownerKey: "owner", kind: "delegated", title: "Verified", parentId: "objective", planId: "plan", status: "succeeded", result: "Friday", verificationStatus: "accepted", createdAt: 2 },
		{ id: "unchecked", ownerKey: "owner", kind: "delegated", title: "Unchecked", parentId: "objective", planId: "plan", status: "succeeded", result: "Maybe", createdAt: 3 },
	]);
	const published = [];
	let deliveries = 0;
	const runtime = new ObjectiveRuntime(ledger, async () => { deliveries++; return { result: "Delivered" }; }, (outcome) => published.push(outcome));
	assert.equal((await runtime.deliverPlan("owner", "plan")).status, "awaiting_verification");
	assert.equal(deliveries, 0);
	assert.equal(ledger.tasks.get("objective").status, "running");
	assert.deepEqual(published, []);
});

test("a failed delivery leaves the Objective retryable without replacing verified Task results", async () => {
	const ledger = ledgerFixture([
		{ id: "objective", ownerKey: "owner", kind: "objective", title: "Report", status: "running", createdAt: 1 },
		{ id: "child", ownerKey: "owner", kind: "delegated", title: "Research", parentId: "objective", planId: "plan", status: "succeeded", result: "verified", verificationStatus: "accepted", createdAt: 2 },
	]);
	const runtime = new ObjectiveRuntime(ledger, async () => { throw new Error("delivery unavailable"); });

	const result = await runtime.deliverPlan("owner", "plan");

	assert.equal(result.status, "failed");
	assert.equal(ledger.tasks.get("objective").status, "running");
	assert.equal(ledger.tasks.get("child").result, "verified");
});

test("failed and cancelled Plans propagate their outcome to the parent Objective", async () => {
	for (const [planStatus, objectiveStatus] of [["failed", "failed"], ["cancelled", "cancelled"]]) {
		const ledger = ledgerFixture([
			{ id: "objective", ownerKey: "owner", kind: "objective", title: "Report", status: "running", createdAt: 1 },
			{ id: "child", ownerKey: "owner", kind: "delegated", title: "Research", parentId: "objective", planId: "plan", status: planStatus, createdAt: 2 },
		]);
		const runtime = new ObjectiveRuntime(ledger, async () => { throw new Error("must not deliver"); });
		const result = await runtime.settlePlan("owner", "plan", planStatus);
		assert.equal(result.status, objectiveStatus);
		assert.equal(ledger.tasks.get("objective").status, objectiveStatus);
	}
});

test("cancelling a conversation cancels every active Objective owned by it", () => {
	const ledger = ledgerFixture([
		{ id: "one", ownerKey: "owner", kind: "objective", title: "One", status: "running", createdAt: 1 },
		{ id: "two", ownerKey: "owner", kind: "objective", title: "Two", status: "pending", createdAt: 2 },
		{ id: "done", ownerKey: "owner", kind: "objective", title: "Done", status: "succeeded", createdAt: 3 },
	]);
	const runtime = new ObjectiveRuntime(ledger, async () => ({ result: "unused" }));
	assert.equal(runtime.cancelOwner("owner"), 2);
	assert.equal(ledger.tasks.get("one").status, "cancelled");
	assert.equal(ledger.tasks.get("two").status, "cancelled");
	assert.equal(ledger.tasks.get("done").status, "succeeded");
});

test("Objective delivery is single-flight and cancellation aborts the in-flight deliverer", async () => {
	const ledger = ledgerFixture([
		{ id: "objective", ownerKey: "owner", kind: "objective", title: "Report", status: "running", createdAt: 1 },
		{ id: "child", ownerKey: "owner", kind: "delegated", title: "Research", parentId: "objective", planId: "plan", status: "succeeded", result: "done", verificationStatus: "accepted", createdAt: 2 },
	]);
	let calls = 0;
	const runtime = new ObjectiveRuntime(ledger, async (_input, signal) => {
		calls++;
		await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		return { result: "unreachable" };
	});
	const first = runtime.deliverPlan("owner", "plan");
	const second = runtime.deliverPlan("owner", "plan");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls, 1);
	assert.equal(runtime.cancelOwner("owner"), 1);
	assert.equal((await first).status, "failed");
	assert.equal((await second).status, "failed");
	assert.equal(ledger.tasks.get("objective").status, "cancelled");
});

test("a retried successful Plan reopens and delivers its failed parent Objective", async () => {
	const ledger = ledgerFixture([
		{ id: "objective", ownerKey: "owner", kind: "objective", title: "Report", status: "failed", error: "old failure", createdAt: 1, finishedAt: 2 },
		{ id: "child", ownerKey: "owner", kind: "delegated", title: "Research", parentId: "objective", planId: "plan", status: "succeeded", result: "done", verificationStatus: "accepted", createdAt: 2 },
	]);
	const runtime = new ObjectiveRuntime(ledger, async () => ({ result: "final" }));
	assert.equal((await runtime.deliverPlan("owner", "plan")).status, "succeeded");
	assert.equal(ledger.tasks.get("objective").status, "succeeded");
});

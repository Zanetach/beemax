import assert from "node:assert/strict";
import test from "node:test";
import { SubagentManager } from "../dist/index.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("delegated work records one durable Task and advances its lifecycle", async () => {
	const records = new Map();
	const ledger = {
		record(task) { records.set(task.id, { ...task }); },
		transition(id, change) { records.set(id, { ...records.get(id), ...change }); },
	};
	const manager = new SubagentManager({ taskLedger: ledger, execute: async () => "verified result" });
	const delegated = manager.spawn(source, { goal: "Review the release", name: "release-review" });
	const completed = await manager.wait(source, delegated.id, 1_000);
	assert.equal(completed.status, "completed");
	assert.deepEqual(records.get(delegated.id), {
		id: delegated.id,
		ownerKey: "cli:local:local",
		kind: "delegated",
		title: "release-review",
		status: "succeeded",
		createdAt: delegated.createdAt,
		startedAt: records.get(delegated.id).startedAt,
		finishedAt: completed.finishedAt,
		result: "verified result",
	});
	assert.equal(typeof records.get(delegated.id).startedAt, "number");
	await manager.dispose();
});

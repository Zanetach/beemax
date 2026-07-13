import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@beemax/memory";
import { createProfileWorkRuntime } from "../dist/profile-work-runtime.js";

test("Profile Work Runtime composes one channel-neutral Task, Recovery, Verification and Effect graph", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-work-runtime-"));
	const memory = new MemoryStore(join(root, "memory.db"), "personal");
	const work = createProfileWorkRuntime({
		agentDir: root,
		ledger: memory,
		maxConcurrent: 1,
		maxSubagents: 3,
		taskTimeoutMs: 1_000,
		subagentsEnabled: true,
		executeTask: async () => ({ output: "done" }),
		verifyTaskCandidate: async () => ({ accepted: true }),
		deliverObjective: async () => ({ result: "delivered" }),
		executeSubagent: async () => "done",
	});
	try {
		assert.deepEqual(work.resources.map((resource) => resource.name), ["effects", "task-plan", "recovery", "subagents"]);
		assert.equal(work.recoveryStatus().phase, "running");
		assert.equal(work.taskScheduler.snapshot().maxConcurrent, 1);
		assert.equal(typeof work.taskRecovery.resume, "function");
		assert.equal(typeof work.objectiveRuntime.deliverPlan, "function");
		const delegated = work.subagents.spawn({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, { goal: "Inspect the release", acceptanceCriteria: "The release finding is independently checked" });
		assert.equal((await work.subagents.wait({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, delegated.id, 1_000)).status, "completed");
		const durable = memory.queryTasks({ ownerKeys: ["cli:local:local"], id: delegated.id, limit: 1 })[0];
		assert.equal(durable.verificationStatus, "accepted");
		assert.equal(memory.taskRuns(delegated.id).length, 1);
	} finally {
		for (const resource of [...work.resources].reverse()) await resource.dispose();
		memory.close();
		await rm(root, { recursive: true, force: true });
	}
});

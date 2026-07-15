import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore, memoryPersistencePorts } from "../dist/index.js";

test("focused persistence ports are capability views over one SQLite Memory authority", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-memory-ports-"));
	try {
		const store = new MemoryStore(join(root, "memory.db"), "profile-a");
		const ports = memoryPersistencePorts(store);
		assert.equal(ports.organizationMemory, store);
		assert.equal(ports.conversationMemory, store);
		assert.equal(ports.taskLedger, store);
		assert.equal(ports.recoveryQueue, store);
		assert.equal(ports.completionOutbox, store);
		assert.equal(typeof ports.organizationMemory.upsertEpisode, "function");
		assert.equal(typeof ports.recoveryQueue.reconcileExpiredTaskRuns, "function");
		assert.equal(typeof ports.completionOutbox.claimTaskPlanCompletionNotices, "function");
		assert.equal(typeof ports.completionOutbox.claimObjectiveCompletions, "function");
		assert.equal(typeof ports.completionOutbox.getObjectiveCompletion, "function");
		assert.equal(typeof ports.completionOutbox.acknowledgeObjectiveCompletion, "function");
		store.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

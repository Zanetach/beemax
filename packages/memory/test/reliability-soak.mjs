import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../dist/index.js";
import { TaskGraph, TaskRecoveryRunner } from "@thruvera/core";

const configuredDuration = process.env.THRUVERA_RELIABILITY_DURATION_MS ?? "60000";
const durationMs = Number(configuredDuration);
if (!Number.isSafeInteger(durationMs) || durationMs < 1_000) throw new Error("THRUVERA_RELIABILITY_DURATION_MS must be an integer of at least 1000");

test("Agent core remains stable under sustained durable recovery load", { timeout: durationMs + 30_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-reliability-soak-"));
	const store = new MemoryStore(join(root, "memory.db"));
	const scope = { platform: "cli", chatId: "soak", chatType: "dm", userId: "soak" };
	let batch = 0;
	let executions = 0;
	const deadline = Date.now() + durationMs;
	try {
		while (Date.now() < deadline) {
			const graph = new TaskGraph(store);
			for (let index = 0; index < 8; index++) {
				const planId = `soak-${batch}-${index}`;
				graph.createPlan({ id: planId, ownerKey: "owner", tasks: [{ id: `${planId}-task`, title: "Soak task", recoveryPolicy: "safe_retry", idempotencyKey: planId, executionScope: scope }] });
			}
			const result = await new TaskRecoveryRunner(store, async () => { executions++; return { output: "ok" }; }).run({ maxConcurrent: 8 });
			assert.equal(result.failed, 0);
			batch++;
		}
		assert.ok(batch > 0);
		assert.equal(executions, batch * 8);
		assert.equal(store.queryTaskPlans({ ownerKeys: ["owner"], statuses: ["failed", "running", "pending"] }).length, 0);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

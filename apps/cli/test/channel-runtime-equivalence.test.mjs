import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MUTATING_TOOL_POLICY, TaskGraph, responsibilityOwnerKey, responsibilityOwnerKeys } from "@beemax/core";
import { MemoryStore } from "@beemax/memory";
import { attestAgentFactorySecurity } from "../dist/agent-factory.js";
import { createProfileRuntime } from "../dist/runtime-composition.js";

test("one channel-neutral contract preserves Task, Effect, Verification, cancellation, and recovery semantics", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-channel-equivalence-"));
	const memory = new MemoryStore(join(root, "memory.db"), "personal");
	const cli = { platform: "cli", chatId: "local", chatType: "dm", userId: "local", userIdAlt: "employee-7" };
	const feishu = { platform: "feishu", chatId: "oc-chat", chatType: "dm", userId: "ou-app", userIdAlt: "employee-7" };
	const future = { platform: "future-channel", chatId: "conversation", chatType: "dm", userId: "adapter-user", userIdAlt: "employee-7" };
	const ownerKey = responsibilityOwnerKey(cli);
	const profile = await createProfileRuntime({
		work: {
			agentDir: root, ledger: memory, maxConcurrent: 2, maxSubagents: 2, taskTimeoutMs: 1_000, subagentsEnabled: false,
			executeTask: async (task) => ({ output: `recovered:${task.id}`, evidence: "channel-neutral execution" }),
			verifyTaskCandidate: async () => ({ accepted: true, evidence: "channel-neutral verification" }),
			deliverObjective: async () => ({ result: "delivered" }), executeSubagent: async () => "done",
		},
		resources: [{ name: "memory", dispose: () => memory.close() }],
		compose: (work) => ({
			profileId: "personal", agentDir: root, policy: {},
			runtime: { createAgent: attestAgentFactorySecurity(async () => ({ agent: { state: { model: { id: "test" }, messages: [] } }, subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined }), work.toolEffects) },
		}),
	});
	try {
		const graph = new TaskGraph(memory);
		graph.createPlan({ id: "active-plan", ownerKey, tasks: [{ id: "active-task", title: "Continue responsibility", recoveryPolicy: "safe_retry", idempotencyKey: "active-plan:task", executionScope: cli }] }, 1);
		assert.deepEqual(profile.runtime.tasks(feishu, { planId: "active-plan" }).map((task) => task.id), ["active-task"]);
		assert.deepEqual(profile.runtime.tasks(future, { planId: "active-plan" }).map((task) => task.id), ["active-task"]);
		assert.deepEqual(profile.runtime.taskPlans(feishu, { id: "active-plan" }).map((plan) => plan.id), ["active-plan"]);
		const memoryId = memory.remember({ platform: cli.platform, chatId: cli.chatId, userId: cli.userIdAlt, role: "memory", content: "Channel-local conversation evidence" });
		assert.equal(memory.recall("conversation evidence", { platform: future.platform, chatId: future.chatId, userId: future.userIdAlt, limit: 10 }).some((item) => item.id === memoryId), false);

		const policy = { ...MUTATING_TOOL_POLICY, sideEffect: "local" };
		profile.work.toolEffects.begin({ source: cli, taskId: "active-task", toolCallId: "call:cli", toolName: "write", args: { idempotencyKey: "shared-mutation" }, policy });
		profile.work.toolEffects.finish({ source: cli, toolCallId: "call:cli", toolName: "write", policy, isError: false });
		assert.throws(() => profile.work.toolEffects.begin({ source: feishu, taskId: "active-task", toolCallId: "call:feishu", toolName: "write", args: { idempotencyKey: "shared-mutation" }, policy }), /already committed/i);
		assert.throws(() => profile.work.toolEffects.begin({ source: future, taskId: "active-task", toolCallId: "call:future", toolName: "write", args: { idempotencyKey: "shared-mutation" }, policy }), /already committed/i);

		assert.equal(profile.work.taskRecovery.cancel(responsibilityOwnerKeys(feishu), "active-plan").tasks, 1);
		assert.equal(profile.runtime.tasks(cli, { planId: "active-plan" })[0].status, "cancelled");

		graph.createPlan({ id: "verify-plan", ownerKey, tasks: [{ id: "verify-task", title: "Verify retained candidate", acceptanceCriteria: "Candidate passes an independent check", recoveryPolicy: "safe_retry", idempotencyKey: "verify-plan:task", executionScope: cli }] }, 2);
		await graph.run([ownerKey], "verify-plan", async () => ({ output: "candidate result" }), { verify: async () => { throw new Error("verifier unavailable"); } });
		assert.deepEqual(await profile.work.taskRecovery.reverify(responsibilityOwnerKeys(feishu), "verify-plan"), { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 });
		assert.equal(profile.runtime.tasks(cli, { planId: "verify-plan" })[0].status, "succeeded");

		graph.createPlan({ id: "retry-plan", ownerKey, tasks: [{ id: "retry-task", title: "Retry safe work", acceptanceCriteria: "Recovered result is independently verified", recoveryPolicy: "safe_retry", idempotencyKey: "retry-plan:task", executionScope: cli }] }, 5);
		memory.transition("retry-task", { status: "running", startedAt: 6 });
		memory.transition("retry-task", { status: "failed", finishedAt: 7, error: "interrupted" });
		const retried = await profile.work.taskRecovery.retry(responsibilityOwnerKeys(feishu), "retry-plan", { maxConcurrent: 1 });
		assert.equal(retried.succeeded, 1);
		assert.equal(profile.runtime.tasks(cli, { planId: "retry-plan" })[0].verificationStatus, "accepted");
	} finally {
		await profile.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

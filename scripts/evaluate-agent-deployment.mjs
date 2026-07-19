#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildTaskPreservationEnvelope, CapabilityProviderRuntime, TaskGraph, TaskRecoveryRunner, createTaskCheckpoint, recoverCompactionPreservation } from "../packages/core/dist/index.js";
import { MemoryStore } from "../packages/memory/dist/index.js";

const args = process.argv.slice(2);
const requireUbuntu = args.includes("--require-ubuntu");
const checks = [];
const failures = [];

let osRelease = "";
try { osRelease = await readFile("/etc/os-release", "utf8"); } catch {}
const ubuntu = process.platform === "linux" && /^ID=ubuntu$/m.test(osRelease);
checks.push({ id: "ubuntu-runtime", passed: requireUbuntu ? ubuntu : true, observed: { required: requireUbuntu, platform: process.platform, ubuntu } });
if (requireUbuntu && !ubuntu) failures.push("Deployment matrix requires Ubuntu");

const offline = await new CapabilityProviderRuntime().resolve({ capability: "research", providers: [{ id: "offline-provider", kind: "mcp", capabilities: ["research"], installed: true, health: async () => ({ status: "unavailable", reason: "simulated disconnected network" }) }] });
checks.push({ id: "network-offline", passed: offline.status === "blocked" && offline.blocker?.code === "provider_unavailable", observed: offline.blocker });
if (!checks.at(-1).passed) failures.push("Disconnected Provider did not fail with an explicit blocker");

const timeoutStartedAt = Date.now();
const timed = await new CapabilityProviderRuntime({ healthTimeoutMs: 100 }).resolve({ capability: "research", providers: [{ id: "hung-provider", kind: "tool", capabilities: ["research"], installed: true, health: async () => new Promise(() => undefined) }] });
const timeoutElapsedMs = Date.now() - timeoutStartedAt;
checks.push({ id: "provider-timeout", passed: timed.status === "blocked" && timeoutElapsedMs < 500 && /timed out/i.test(timed.blocker?.reason ?? ""), observed: { elapsedMs: timeoutElapsedMs, blocker: timed.blocker } });
if (!checks.at(-1).passed) failures.push("Provider timeout exceeded its bounded failure budget");

const active = Array.from({ length: 20 }, (_value, index) => ({ id: `objective-${index}`, ownerKey: "eval", kind: "objective", title: `Objective ${index}`, acceptanceCriteria: `retain criterion ${index}`, status: "running", createdAt: index }));
const preservation = buildTaskPreservationEnvelope(active, 4_000);
const recovered = recoverCompactionPreservation({ summary: "context was heavily compacted", preservation, expectedTaskIds: active.map((task) => task.id) });
checks.push({ id: "low-context", passed: Boolean(preservation) && Buffer.byteLength(preservation) <= 4_000 && recovered.recoveryContext === preservation, observed: { bytes: Buffer.byteLength(preservation), missingTaskIds: recovered.missingTaskIds.length } });
if (!checks.at(-1).passed) failures.push("Low-context recovery did not restore the durable Objective envelope");

const root = mkdtempSync(join(tmpdir(), "beemax-deployment-crash-"));
try {
	const path = join(root, "runtime.db");
	let store = new MemoryStore(path, "deployment-eval");
	const graph = new TaskGraph(store);
	graph.createPlan({ id: "crash-plan", ownerKey: "eval", tasks: [{ id: "crash-task", title: "Recover after process crash", recoveryPolicy: "safe_retry", idempotencyKey: "crash-task", executionScope: { platform: "eval", chatId: "crash", chatType: "dm", userId: "eval" } }] });
	store.transition("crash-task", { status: "running", startedAt: 1 });
	store.recordRun({ id: "crash-run", taskId: "crash-task", executor: "subagent", status: "running", startedAt: 1, leaseExpiresAt: 2 });
	store.checkpointTask("eval", "crash-task", createTaskCheckpoint({ taskRunId: "crash-run", source: "pi_turn", at: 1, completed: ["context-recalled"], committedEffectIds: [], evidenceRefs: ["checkpoint:1"], unresolvedIssues: ["finish"], nextSafeStep: "Resume from checkpoint" }), 1);
	store.close();
	store = new MemoryStore(path, "deployment-eval");
	store.reconcileExpiredTaskRuns(3, { taskRunReplayState: () => "clear" });
	const cycle = await new TaskRecoveryRunner(store, async (_task, _signal, context) => ({ output: context.checkpoint?.completed.includes("context-recalled") ? "recovered" : "missing checkpoint" })).run();
	const task = store.queryTasks({ ownerKeys: ["eval"], id: "crash-task", limit: 1 })[0];
	checks.push({ id: "process-crash", passed: cycle.succeeded === 1 && task?.status === "succeeded" && task.result === "recovered", observed: { cycle, taskStatus: task?.status } });
	if (!checks.at(-1).passed) failures.push("Process crash recovery did not resume from its durable checkpoint");
	store.close();
} finally { rmSync(root, { recursive: true, force: true }); }

const artifact = { schemaVersion: 1, checks, environment: { node: process.version, platform: process.platform, arch: process.arch }, gate: { passed: failures.length === 0, failures } };
const writeIndex = args.indexOf("--write");
if (writeIndex >= 0) await writeFile(resolve(args[writeIndex + 1] || "artifacts/agent-deployment.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

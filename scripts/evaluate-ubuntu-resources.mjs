#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_RUNTIME_RESOURCE_LIMITS, FileInteractionInputQueueStore, ProfileTaskScheduler } from "../packages/core/dist/index.js";
import { MemoryStore } from "../packages/memory/dist/index.js";
import { renderSystemdService } from "../apps/cli/dist/service-manager.js";

if (typeof global.gc !== "function") throw new Error("Ubuntu resource gate requires node --expose-gc");
const args = process.argv.slice(2);
const profilePath = resolve(valueAfter(args, "--profile") ?? "evals/resource-profiles/ubuntu-small-node22.json");
const profile = JSON.parse(await readFile(profilePath, "utf8"));
const machine = currentMachine();
validateProfile(profile, machine);

const root = mkdtempSync(join(tmpdir(), "beemax-ubuntu-resources-"));
let store;
try {
	global.gc();
	const baseline = process.memoryUsage();
	const queuePath = join(root, "interaction-inputs.json");
	const queue = new FileInteractionInputQueueStore(queuePath, {
		maxRecords: profile.runtimeLimits.interactionQueueMaxRecords,
		maxBytes: profile.runtimeLimits.interactionQueueMaxBytes,
	});
	for (let index = 0; index < profile.runtimeLimits.interactionQueueMaxRecords * 2; index++) queue.enqueue({
		id: `input:${index}`, key: `conversation:${index}`, text: "q".repeat(128), createdAt: index,
		source: { platform: "eval", chatId: `chat:${index}`, chatType: "dm", userId: `user:${index}` },
	});
	const queueRecords = queue.all().length;
	const queueBytes = statSync(queuePath).size;
	const byteQueuePath = join(root, "interaction-inputs-byte-limit.json");
	const byteQueue = new FileInteractionInputQueueStore(byteQueuePath, { maxRecords: 10_000, maxBytes: profile.runtimeLimits.interactionQueueMaxBytes });
	let byteQueueRejected = false;
	for (let index = 0; index < 100; index++) {
		try { byteQueue.enqueue({ id: `large:${index}`, key: `large:${index}`, text: "b".repeat(64 * 1024), createdAt: index, source: { platform: "eval", chatId: `large:${index}`, chatType: "dm", userId: "byte-test" } }); }
		catch (error) { if (/byte limit/i.test(String(error))) { byteQueueRejected = true; break; } throw error; }
	}
	const byteQueueBytes = statSync(byteQueuePath).size;

	let active = 0;
	let peakTaskConcurrency = 0;
	let releaseTasks;
	const taskGate = new Promise((resolveGate) => { releaseTasks = resolveGate; });
	const scheduler = new ProfileTaskScheduler({ maxConcurrent: profile.runtimeLimits.taskConcurrency, maxQueued: profile.runtimeLimits.taskQueueMax, maxQueuedPerOwner: profile.runtimeLimits.taskQueueMaxPerOwner, adaptive: false });
	const tasks = Array.from({ length: profile.workload.scheduledTasks }, (_, index) => scheduler.run(`owner:${index % 8}`, async () => {
		active++;
		peakTaskConcurrency = Math.max(peakTaskConcurrency, active);
		await taskGate;
		active--;
	}));
	await new Promise((resolveTick) => setImmediate(resolveTick));
	const queuedTasksAtSaturation = scheduler.snapshot().queued;
	releaseTasks();
	await Promise.all(tasks);

	const databasePath = join(root, "memory.db");
	store = new MemoryStore(databasePath, "resource-profile");
	for (let index = 0; index < profile.workload.databaseRecords; index++) store.recordEvent({
		platform: "eval", chatId: `conversation:${index % 100}`, userId: `user:${index % 20}`, kind: "import",
		content: `bounded resource sample ${index} ${"x".repeat(160)}`, occurredAt: index + 1,
	});
	store.close();
	store = undefined;
	const databaseBytes = sqliteFamilyBytes(databasePath);

	global.gc();
	const final = process.memoryUsage();
	const observations = {
		rssBytes: Math.max(final.rss, procRssBytes("VmHWM")),
		heapGrowthBytes: Math.max(0, final.heapUsed - baseline.heapUsed),
		queueRecords, queueBytes, byteQueueBytes, byteQueueRejected, peakTaskConcurrency, queuedTasksAtSaturation, databaseBytes,
		databaseRecords: profile.workload.databaseRecords,
		projectedDatabaseRecordsAtHighWater: Math.floor(profile.operationalHighWater.databaseBytes / Math.max(1, databaseBytes / profile.workload.databaseRecords)),
		systemdLimitsMatch: systemdLimitsMatch(profile),
	};
	const failures = assess(profile, observations);
	const report = { schemaVersion: 1, profile: { id: profile.id, description: profile.description }, machine, runtimeLimits: profile.runtimeLimits, operationalHighWater: profile.operationalHighWater, observations, gate: { passed: failures.length === 0, failures } };
	const output = `${JSON.stringify(report, null, 2)}\n`;
	const writePath = valueAfter(args, "--write");
	if (writePath) await writeFile(resolve(writePath), output, "utf8");
	process.stdout.write(output);
	if (failures.length) process.exitCode = 1;
} finally {
	try { store?.close(); } catch {}
	rmSync(root, { recursive: true, force: true });
}

function assess(profile, observed) {
	const failures = [];
	const budget = profile.benchmarkBudgets;
	if (!Number.isFinite(observed.rssBytes) || observed.rssBytes <= 0) failures.push("RSS measurement is unavailable");
	if (observed.rssBytes > budget.maxRssBytes) failures.push("RSS exceeded the Ubuntu workload budget");
	if (observed.heapGrowthBytes > budget.maxHeapGrowthBytes) failures.push("heap growth exceeded the Ubuntu workload budget");
	if (observed.queueRecords !== profile.runtimeLimits.interactionQueueMaxRecords || observed.queueBytes > budget.maxQueueBytes) failures.push("interaction queue exceeded its bounded storage contract");
	if (!observed.byteQueueRejected || observed.byteQueueBytes > budget.maxQueueBytes) failures.push("interaction queue byte limit was not enforced independently");
	if (observed.peakTaskConcurrency !== budget.expectedTaskConcurrency) failures.push("Profile task concurrency did not match its configured fence");
	if (observed.queuedTasksAtSaturation !== profile.workload.scheduledTasks - budget.expectedTaskConcurrency || observed.queuedTasksAtSaturation > profile.runtimeLimits.taskQueueMax) failures.push("Profile task queue did not retain every task behind the concurrency fence");
	if (observed.databaseBytes > budget.maxDatabaseBytes) failures.push("SQLite sample exceeded the Ubuntu database growth budget");
	if (!observed.systemdLimitsMatch) failures.push("systemd defaults drifted from the Ubuntu resource Profile");
	return failures;
}

function currentMachine() {
	const osRelease = Object.fromEntries(readFileSync("/etc/os-release", "utf8").split("\n").filter(Boolean).map((line) => line.split("=", 2)).map(([key, value]) => [key, value?.replace(/^"|"$/gu, "")]));
	return { platform: process.platform, arch: process.arch, osId: osRelease.ID, osVersion: osRelease.VERSION_ID, node: process.version, logicalCpus: cpus().length, memoryGiB: Math.floor(totalmem() / 2 ** 30) };
}

function validateProfile(profile, machine) {
	assert.equal(profile.schemaVersion, 1, "resource Profile schema is invalid");
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	if (machine.platform !== profile.platform || machine.osId !== profile.osId || !new RegExp(profile.osVersionPattern).test(machine.osVersion ?? "") || !profile.architectures.includes(machine.arch) || machine.logicalCpus < profile.minLogicalCpus || machine.memoryGiB < profile.minMemoryGiB || nodeMajor !== profile.nodeMajor) throw new Error(`Machine does not satisfy Ubuntu resource Profile ${profile.id}: ${JSON.stringify(machine)}`);
	for (const key of ["runtimeLimits", "operationalHighWater", "benchmarkBudgets", "workload"]) assert.equal(typeof profile[key], "object", `resource Profile ${key} is invalid`);
	for (const key of Object.keys(DEFAULT_RUNTIME_RESOURCE_LIMITS)) assert.equal(profile.runtimeLimits[key], DEFAULT_RUNTIME_RESOURCE_LIMITS[key], `resource Profile ${key} drifted from production composition`);
	assert.ok(profile.operationalHighWater.rssBytes < profile.runtimeLimits.systemdMemoryMaxBytes, "RSS high-water must remain below MemoryMax");
	assert.ok(profile.operationalHighWater.interactionQueueRecords < profile.runtimeLimits.interactionQueueMaxRecords, "queue record high-water must remain below the hard limit");
	assert.ok(profile.operationalHighWater.interactionQueueBytes < profile.runtimeLimits.interactionQueueMaxBytes, "queue byte high-water must remain below the hard limit");
	assert.ok(profile.operationalHighWater.taskQueueDepth < profile.runtimeLimits.taskQueueMax, "task queue high-water must remain below the hard limit");
}

function sqliteFamilyBytes(path) {
	let total = 0;
	for (const candidate of [path, `${path}-wal`, `${path}-shm`]) { try { total += statSync(candidate).size; } catch (error) { if (error.code !== "ENOENT") throw error; } }
	return total;
}

function procRssBytes(field) {
	const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "mu").exec(readFileSync("/proc/self/status", "utf8"));
	return match ? Number(match[1]) * 1024 : 0;
}

function systemdLimitsMatch(profile) {
	const unit = renderSystemdService();
	return unit.includes(`MemoryMax=${profile.runtimeLimits.systemdMemoryMaxBytes / 2 ** 30}G`)
		&& unit.includes(`CPUQuota=${profile.runtimeLimits.systemdCpuQuotaPercent}%`)
		&& unit.includes(`TasksMax=${profile.runtimeLimits.systemdTasksMax}`);
}

function valueAfter(args, flag) { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; }

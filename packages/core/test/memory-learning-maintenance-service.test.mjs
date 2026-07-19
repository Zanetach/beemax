import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLearningMaintenanceService } from "../dist/index.js";

function deferred() {
	let resolve;
	const promise = new Promise((complete) => { resolve = complete; });
	return { promise, resolve };
}

test("Memory Learning maintenance runs through Profile admission and coalesces signal wakes", async () => {
	const calls = [];
	const admissions = [];
	const first = deferred();
	let releaseFirst = false;
	const service = new MemoryLearningMaintenanceService({
		maintain: async (input) => {
			calls.push(input);
			if (!releaseFirst) await first.promise;
			return { claimed: 1, completed: 1, deferred: 0, failed: 0, transitions: [], createdObjectiveIds: [], nextWatermarks: {} };
		},
	}, {
		profileId: "profile-a",
		intervalMs: 60_000,
		maxItems: 7,
		maxModelCalls: 3,
		leaseMs: 5_000,
		now: () => 1_700_000_000_000,
		admit: async (ownerKey, work) => { admissions.push(ownerKey); return work(); },
	});

	service.start();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 1);
	service.wake();
	service.wake();
	releaseFirst = true;
	first.resolve();
	await service.waitForIdle();

	assert.equal(calls.length, 2);
	assert.deepEqual(admissions, ["profile:profile-a:memory-learning", "profile:profile-a:memory-learning"]);
	assert.deepEqual(calls.map((call) => call.trigger), ["recovery", "signal"]);
	assert.deepEqual(calls[0], {
		profileId: "profile-a", trigger: "recovery", maxItems: 7, maxModelCalls: 3,
		leaseMs: 5_000, now: 1_700_000_000_000,
	});
	await service.stop();
});

test("Memory Learning maintenance stops future cycles and surfaces failures without dying", async () => {
	const errors = [];
	let attempts = 0;
	const service = new MemoryLearningMaintenanceService({
		maintain: async () => {
			attempts++;
			if (attempts === 1) throw new Error("temporary sqlite contention");
			return { claimed: 0, completed: 0, deferred: 0, failed: 0, transitions: [], createdObjectiveIds: [], nextWatermarks: {} };
		},
	}, {
		profileId: "profile-a",
		intervalMs: 60_000,
		onError: (error) => errors.push(error),
	});

	service.start();
	await service.waitForIdle();
	assert.equal(errors.length, 1);
	service.wake();
	await service.waitForIdle();
	assert.equal(attempts, 2);
	await service.stop();
	service.wake();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(attempts, 2);
});

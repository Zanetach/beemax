import test from "node:test";
import assert from "node:assert/strict";
import { TaskRecoveryService } from "../dist/index.js";

test("TaskRecoveryService reconciles expired runs before one coalesced recovery cycle", async () => {
	const order = [];
	let release;
	const blocked = new Promise((resolve) => { release = resolve; });
	const ledger = { reconcileExpiredTaskRuns() { order.push("reconcile"); return { retried: 2, failed: 1 }; } };
	const runner = {
		async reverifyDue() { order.push("verify"); return { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 }; },
		async run() { order.push("recover"); await blocked; return { plans: 2, succeeded: 2, failed: 0, cancelled: 0, blocked: [] }; },
	};
	const service = new TaskRecoveryService(ledger, runner);
	const first = service.runOnce();
	const second = service.runOnce();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(order, ["reconcile", "verify", "recover"]);
	release();
	const expected = { reconciled: { retried: 2, failed: 1 }, verification: { attempted: 1, accepted: 1, rejected: 0, unavailable: 0 }, recovery: { plans: 2, succeeded: 2, failed: 0, cancelled: 0, blocked: [] } };
	assert.deepEqual(await first, expected);
	assert.deepEqual(await second, expected);
	assert.deepEqual(order, ["reconcile", "verify", "recover"]);
});

test("TaskRecoveryService stop aborts and joins the active recovery cycle", async () => {
	let reconciliations = 0;
	let started;
	const running = new Promise((resolve) => { started = resolve; });
	const ledger = { reconcileExpiredTaskRuns() { reconciliations++; return { retried: 0, failed: 0 }; } };
	const runner = { run({ signal }) {
		started();
		return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	} };
	const errors = [];
	const service = new TaskRecoveryService(ledger, runner, { onError: (error) => errors.push(error) });
	const keepAlive = setTimeout(() => {}, 1_000);
	service.start();
	await running;
	await service.stop(new Error("shutdown"));
	clearTimeout(keepAlive);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(reconciliations, 1);
	assert.equal(errors.length, 1);
	assert.match(String(errors[0]), /shutdown/);
});

test("TaskRecoveryService schedules the next cycle only after the previous cycle completes", async () => {
	let reconciliations = 0;
	let running = 0;
	let maxRunning = 0;
	let secondCycle;
	const completed = new Promise((resolve) => { secondCycle = resolve; });
	const ledger = { reconcileExpiredTaskRuns() { reconciliations++; return { retried: 0, failed: 0 }; } };
	const runner = { async run() {
		running++;
		maxRunning = Math.max(maxRunning, running);
		await new Promise((resolve) => setImmediate(resolve));
		running--;
		return { plans: 0, succeeded: 0, failed: 0, cancelled: 0, blocked: [] };
	} };
	const service = new TaskRecoveryService(ledger, runner, { intervalMs: 10, onCycle: () => { if (reconciliations === 2) secondCycle(); } });
	const keepAlive = setTimeout(() => {}, 1_000);
	service.start();
	await completed;
	await service.stop();
	clearTimeout(keepAlive);
	assert.equal(reconciliations, 2);
	assert.equal(maxRunning, 1);
});

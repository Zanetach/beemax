import assert from "node:assert/strict";
import test from "node:test";
import { FlushController } from "../dist/presentation/flush.js";

test("FlushController drops queued renders after close", async () => {
	const flush = new FlushController(1_000);
	let renders = 0;
	await flush.schedule(async () => { renders++; return true; });
	const queued = flush.schedule(async () => { renders++; return true; });
	flush.close();
	await Promise.race([queued, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("close did not cancel the flush delay")), 100))]);
	assert.equal(renders, 1);
});

test("FlushController lets urgent semantic updates preempt the normal cadence without exceeding four patches per second", async () => {
	const flush = new FlushController(1_000, 250);
	const renderedAt = [];
	await flush.schedule(async () => { renderedAt.push(Date.now()); return true; });
	const normal = flush.schedule(async () => { renderedAt.push(Date.now()); return true; });
	await new Promise((resolve) => setTimeout(resolve, 20));
	const urgent = flush.schedule(async () => { renderedAt.push(Date.now()); return true; }, false, true);
	await Promise.race([urgent, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("urgent update remained behind normal cadence")), 500))]);
	await normal;
	assert.equal(renderedAt.length, 2);
	assert.ok(renderedAt[1] - renderedAt[0] >= 240);
	assert.ok(renderedAt[1] - renderedAt[0] < 700);
	flush.close();
});

test("FlushController preserves updates queued during terminal rendering", async () => {
	const flush = new FlushController(1_000, 50); const frames = []; let releaseTerminal;
	await flush.schedule(async () => { frames.push("initial"); return true; });
	const terminal = flush.schedule(async () => { frames.push("terminal"); await new Promise((resolve) => { releaseTerminal = resolve; }); return true; }, true);
	await new Promise((resolve) => setTimeout(resolve, 70));
	const concurrent = flush.schedule(async () => { frames.push("latest"); return true; }, false, true); releaseTerminal();
	await Promise.all([terminal, concurrent]);
	assert.deepEqual(frames, ["initial", "terminal", "latest"]); flush.close();
});

test("FlushController lets a terminal render bypass the normal and urgent cadence", async () => {
	const flush = new FlushController(1_000, 250);
	await flush.schedule(async () => true);
	const startedAt = Date.now();
	await flush.schedule(async () => true, true);
	assert.ok(Date.now() - startedAt < 80, "terminal render should not wait for the urgent interval");
	flush.close();
});

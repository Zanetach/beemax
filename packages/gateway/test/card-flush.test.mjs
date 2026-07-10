import assert from "node:assert/strict";
import test from "node:test";
import { FlushController } from "../dist/card/flush.js";

test("FlushController drops queued renders after close", async () => {
	const flush = new FlushController(1_000);
	let renders = 0;
	await flush.schedule(async () => { renders++; return true; });
	const queued = flush.schedule(async () => { renders++; return true; });
	flush.close();
	await Promise.race([queued, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("close did not cancel the flush delay")), 100))]);
	assert.equal(renders, 1);
});

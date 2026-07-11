import assert from "node:assert/strict";
import test from "node:test";
import { TaskPlanRuntime } from "../dist/index.js";

test("TaskPlanRuntime cancels only the owned active Plan and unregisters terminal runs", async () => {
	const runtime = new TaskPlanRuntime();
	let observed;
	const running = runtime.run("owner-a", "plan", undefined, async (signal) => new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => { observed = signal.reason; reject(signal.reason); }, { once: true });
	}));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(runtime.cancel(["owner-b"], "plan"), 0);
	assert.equal(runtime.cancel(["owner-a"], "plan"), 1);
	await assert.rejects(running, /cancelled/i);
	assert.match(String(observed), /cancelled/i);
	assert.deepEqual(runtime.snapshot(), { active: 0 });
});

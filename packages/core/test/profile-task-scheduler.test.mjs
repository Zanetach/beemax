import assert from "node:assert/strict";
import test from "node:test";
import { ProfileTaskScheduler } from "../dist/index.js";

test("ProfileTaskScheduler shares one concurrency budget across conversations", async () => {
	const scheduler = new ProfileTaskScheduler({ maxConcurrent: 2 });
	let running = 0;
	let maxRunning = 0;
	const releases = [];
	const work = (owner) => scheduler.run(owner, async () => {
		running++;
		maxRunning = Math.max(maxRunning, running);
		await new Promise((resolve) => releases.push(resolve));
		running--;
		return owner;
	});
	const results = [work("conversation-a"), work("conversation-a"), work("conversation-b")];
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(running, 2);
	assert.equal(scheduler.snapshot().queued, 1);
	releases.shift()();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(running, 2);
	while (releases.length) releases.shift()();
	assert.deepEqual(await Promise.all(results), ["conversation-a", "conversation-a", "conversation-b"]);
	assert.equal(maxRunning, 2);
});

test("ProfileTaskScheduler gives the next free slot to another waiting conversation", async () => {
	const scheduler = new ProfileTaskScheduler({ maxConcurrent: 1 });
	const order = [];
	let releaseFirst;
	const first = scheduler.run("conversation-a", async () => {
		order.push("a1");
		await new Promise((resolve) => { releaseFirst = resolve; });
	});
	await new Promise((resolve) => setImmediate(resolve));
	const secondA = scheduler.run("conversation-a", async () => { order.push("a2"); });
	const firstB = scheduler.run("conversation-b", async () => { order.push("b1"); });
	releaseFirst();
	await Promise.all([first, secondA, firstB]);
	assert.deepEqual(order, ["a1", "b1", "a2"]);
});

test("ProfileTaskScheduler removes an aborted queued task without consuming capacity", async () => {
	const scheduler = new ProfileTaskScheduler({ maxConcurrent: 1 });
	let release;
	const active = scheduler.run("conversation-a", () => new Promise((resolve) => { release = resolve; }));
	await new Promise((resolve) => setImmediate(resolve));
	const controller = new AbortController();
	const queued = scheduler.run("conversation-b", async () => "should-not-run", controller.signal);
	controller.abort(new Error("stopped"));
	await assert.rejects(queued, /stopped/);
	assert.equal(scheduler.snapshot().queued, 0);
	release();
	await active;
});

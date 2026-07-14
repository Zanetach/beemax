import assert from "node:assert/strict";
import test from "node:test";
import { GatewayIngressController, ProfileHost, assessProfileChannelHealth } from "../dist/index.js";

test("Profile Host admits Interactions only while healthy or degraded", () => {
	const host = new ProfileHost(new GatewayIngressController({ maxActive: 2, maxActivePerConversation: 1 }));
	assert.equal(host.tryAcquire("chat:a"), undefined);
	assert.equal(host.snapshot().lifecycleRejected, 1);

	host.beginStart();
	assert.equal(host.snapshot().state, "starting");
	assert.equal(host.tryAcquire("chat:a"), undefined);
	host.reportHealth({ status: "ready" });
	const release = host.tryAcquire("chat:a");
	assert.equal(typeof release, "function");
	assert.equal(host.snapshot().state, "healthy");
	release();

	host.reportHealth({ status: "ready", degradedReasons: ["channel feishu-main is reconnecting"] });
	assert.equal(host.snapshot().state, "degraded");
	assert.equal(typeof host.tryAcquire("chat:b"), "function");
});

test("Profile Host draining blocks new Interactions and waits for admitted work", async () => {
	const host = new ProfileHost();
	host.start({ status: "ready" });
	const release = host.tryAcquire("chat:a");
	assert.equal(typeof release, "function");
	host.beginDrain();
	assert.equal(host.snapshot().acceptingInteractions, false);
	assert.equal(host.tryAcquire("chat:b"), undefined);

	let drained = false;
	const waiting = host.waitForIdle(1_000).then(() => { drained = true; });
	await Promise.resolve();
	assert.equal(drained, false);
	release();
	await waiting;
	host.completeStop();
	assert.equal(host.snapshot().state, "stopped");
});

test("Profile Host fails closed when required authorities fail and can recover", () => {
	const host = new ProfileHost();
	host.start({ status: "failed", failureReason: "Memory authority unavailable" });
	assert.equal(host.snapshot().state, "failed");
	assert.equal(host.tryAcquire("chat:a"), undefined);
	host.beginRecovery();
	assert.equal(host.snapshot().state, "recovering");
	host.reportHealth({ status: "ready" });
	assert.equal(host.snapshot().state, "healthy");
});

test("Profile Host treats isolated channel outages as degraded Profile health", () => {
	assert.deepEqual(assessProfileChannelHealth({ channels: [
		{ id: "feishu-main", adapter: "feishu", platform: "feishu", state: "connected", attempts: 1 },
		{ id: "telegram-main", adapter: "telegram", platform: "telegram", state: "failed", attempts: 3, lastError: "offline" },
	] }), {
		status: "ready",
		degradedReasons: ["Channel Instance telegram-main is failed: offline"],
	});
});

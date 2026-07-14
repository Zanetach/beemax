import assert from "node:assert/strict";
import test from "node:test";
import { GatewayIngressController } from "../dist/index.js";

test("Gateway ingress applies global and per-conversation backpressure with observable counters", () => {
	const ingress = new GatewayIngressController({ maxActive: 2, maxActivePerConversation: 1 });
	const releaseA = ingress.tryAcquire("conversation-a");
	assert.equal(typeof releaseA, "function");
	assert.equal(ingress.tryAcquire("conversation-a"), undefined);
	const releaseB = ingress.tryAcquire("conversation-b");
	assert.equal(typeof releaseB, "function");
	assert.equal(ingress.tryAcquire("conversation-c"), undefined);
	assert.deepEqual(ingress.snapshot(), { active: 2, activeConversations: 2, maxActive: 2, maxActivePerConversation: 1, rejected: 2 });
	releaseA();
	const releaseC = ingress.tryAcquire("conversation-c");
	assert.equal(typeof releaseC, "function");
	releaseB(); releaseC();
	assert.equal(ingress.snapshot().active, 0);
});

test("Gateway ingress release is idempotent", () => {
	const ingress = new GatewayIngressController({ maxActive: 1, maxActivePerConversation: 1 });
	const release = ingress.tryAcquire("conversation");
	release(); release();
	assert.equal(ingress.snapshot().active, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { AdapterRegistry, ChannelHost, GatewayDeliveryPort } from "../dist/index.js";

function adapter(name, events, connect = async () => true) {
	return {
		name,
		isConnected: false,
		async connect() {
			events.push(`${name}:connect`);
			const connected = await connect();
			this.isConnected = connected;
			return connected;
		},
		async disconnect() {
			events.push(`${name}:disconnect`);
			this.isConnected = false;
		},
		onMessage() {},
		async send(chatId, content) {
			events.push(`${name}:send:${chatId}:${content}`);
			return { success: true, messageId: `${name}-message` };
		},
		async editMessage() { return { success: true }; },
		async sendTyping() {},
		async stopTyping() {},
	};
}

test("ChannelHost starts registered adapters, isolates failures, and routes delivery by platform", async () => {
	const events = [];
	const registry = new AdapterRegistry();
	registry.register({ id: "alpha", create: () => adapter("alpha", events) });
	registry.register({ id: "broken", create: () => adapter("broken", events, async () => false) });

	const host = new ChannelHost(registry, [
		{ id: "alpha-main", adapter: "alpha", enabled: true, settings: {} },
		{ id: "broken-main", adapter: "broken", enabled: true, settings: {} },
	], { connectAttempts: 2, retryBaseDelayMs: 0 });
	const snapshot = await host.start();

	assert.deepEqual(snapshot.channels.map(({ id, state, attempts }) => ({ id, state, attempts })), [
		{ id: "alpha-main", state: "connected", attempts: 1 },
		{ id: "broken-main", state: "failed", attempts: 2 },
	]);
	assert.equal(host.resolveAdapter("alpha").name, "alpha");
	assert.throws(() => host.resolveAdapter("broken"), /not connected/);

	const delivery = new GatewayDeliveryPort(host);
	await delivery.sendText({ platform: "alpha", chatId: "chat" }, "hello");
	assert.ok(events.includes("alpha:send:chat:hello"));

	await host.stop();
	assert.equal(events.filter((event) => event === "alpha:disconnect").length, 1);
	assert.equal(events.filter((event) => event === "broken:disconnect").length, 1);
});

test("ChannelHost rejects unknown adapters and duplicate active platforms", () => {
	const registry = new AdapterRegistry();
	registry.register({ id: "alpha", create: () => adapter("alpha", []) });
	assert.throws(() => new ChannelHost(registry, [
		{ id: "missing", adapter: "missing", enabled: true, settings: {} },
	]), /Unknown channel adapter: missing/);
	assert.throws(() => new ChannelHost(registry, [
		{ id: "first", adapter: "alpha", enabled: true, settings: {} },
		{ id: "second", adapter: "alpha", enabled: true, settings: {} },
	]), /Duplicate active channel platform: alpha/);
});

test("ChannelHost pause and resume changes routability without restarting the Profile Runtime", async () => {
	const events = [];
	const registry = new AdapterRegistry();
	registry.register({ id: "alpha", create: () => adapter("alpha", events) });
	const host = new ChannelHost(registry, [
		{ id: "alpha-main", adapter: "alpha", enabled: true, settings: {} },
	]);

	await host.start();
	await host.pause("alpha-main");
	assert.throws(() => host.resolveAdapter("alpha"), /paused/);
	await host.resume("alpha-main");
	assert.equal(host.resolveAdapter("alpha").name, "alpha");
	await host.stop();
});

test("ChannelHost bounds a hung adapter connection without blocking healthy channels", async () => {
	const registry = new AdapterRegistry();
	registry.register({ id: "healthy", create: () => adapter("healthy", []) });
	registry.register({ id: "hung", create: () => adapter("hung", [], async () => new Promise(() => undefined)) });
	const host = new ChannelHost(registry, [
		{ id: "healthy-main", adapter: "healthy", enabled: true, settings: {} },
		{ id: "hung-main", adapter: "hung", enabled: true, settings: {} },
	], { connectAttempts: 1, connectTimeoutMs: 10 });
	const startedAt = Date.now();
	const snapshot = await host.start();
	assert.ok(Date.now() - startedAt < 200);
	assert.equal(snapshot.channels.find((channel) => channel.id === "healthy-main").state, "connected");
	assert.match(snapshot.channels.find((channel) => channel.id === "hung-main").lastError, /timed out/);
	await host.stop();
});

test("ChannelHost reconnects an adapter that disconnects after startup", async () => {
	const events = [];
	const registry = new AdapterRegistry();
	registry.register({ id: "alpha", create: () => adapter("alpha", events) });
	const host = new ChannelHost(registry, [{ id: "alpha-main", adapter: "alpha", enabled: true, settings: {} }], {
		connectAttempts: 1, retryBaseDelayMs: 0, supervisionIntervalMs: 5,
	});
	await host.start();
	const running = host.adapter("alpha-main");
	running.isConnected = false;
	for (let attempt = 0; events.filter((event) => event === "alpha:connect").length < 2 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.equal(events.filter((event) => event === "alpha:connect").length, 2);
	assert.equal(host.resolveAdapter("alpha"), running);
	await host.stop();
});

import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { FeishuAdapter } from "../dist/index.js";

const settings = {
	appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
	requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: true,
	textBatchDelayMs: 5,
};

function event(messageId, text) {
	return {
		sender: { sender_type: "user", sender_id: { open_id: "ou_user", union_id: "on_user" } },
		message: { message_id: messageId, chat_id: "chat", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }), create_time: String(Date.now()) },
	};
}

async function waitFor(predicate, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("Feishu replays startup events received before an inbound handler is registered", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	const receive = adapter.onReceive(event("m1", "startup"));
	await waitFor(() => adapter.pendingInbound.length === 1);
	const delivered = [];
	adapter.onMessage(async (message) => { delivered.push(message.text); });
	await receive;
	assert.deepEqual(delivered, ["startup"]);
});

test("Feishu holds reconnect-window events and replays them in arrival order", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	adapter.connectionGeneration = 1;
	adapter.connected = false;
	const delivered = [];
	adapter.onMessage(async (message) => { delivered.push(message.text); });
	const receives = [adapter.onReceive(event("m1", "first")), adapter.onReceive(event("m2", "second")), adapter.onReceive(event("m3", "/now"))];
	await waitFor(() => adapter.pendingInbound.length === 3);
	assert.deepEqual(delivered, []);
	adapter.connected = true;
	await adapter.drainPendingInbound();
	await Promise.all(receives);
	assert.deepEqual(delivered, ["first\nsecond", "/now"]);
});

test("Feishu bounds the replay queue and releases all waiters on disconnect", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	adapter.connectionGeneration = 1;
	adapter.connected = false;
	const delivered = [];
	adapter.onMessage(async (message) => { delivered.push(message.text); });
	const receives = Array.from({ length: 1_001 }, (_, index) => adapter.onReceive(event(`m${index}`, `/command-${index}`)));
	await waitFor(() => adapter.pendingInbound.length === 1_000);
	assert.equal(adapter.pendingInbound.length, 1_000);
	adapter.connected = true;
	await adapter.drainPendingInbound();
	await Promise.all(receives);
	assert.equal(delivered.length, 1_000);
	assert.equal(delivered[0], "/command-1");
	assert.equal(delivered.at(-1), "/command-1000");
	await adapter.disconnect();
	assert.equal(adapter.pendingInbound.length, 0);
});

test("Feishu retains queued media through replay and releases it afterward", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	adapter.connectionGeneration = 1;
	adapter.connected = false;
	adapter.client = { im: { v1: { messageResource: { get: async () => ({
		headers: { "content-type": "image/png" },
		getReadableStream: () => Readable.from([Buffer.from("image")]),
	}) } } } };
	let deliveredPath;
	adapter.onMessage(async (message) => {
		deliveredPath = message.mediaPaths[0];
		await access(deliveredPath);
	});
	const receive = adapter.onReceive({
		sender: { sender_type: "user", sender_id: { open_id: "ou_user", union_id: "on_user" } },
		message: { message_id: "image-message", chat_id: "chat", chat_type: "p2p", message_type: "image", content: JSON.stringify({ image_key: "image-key" }), create_time: "1" },
	});
	await waitFor(() => adapter.pendingInbound.length === 1);
	const queuedPath = adapter.pendingInbound[0].message.mediaPaths[0];
	await access(queuedPath);
	adapter.connected = true;
	await adapter.drainPendingInbound();
	await receive;
	assert.equal(deliveredPath, queuedPath);
	await assert.rejects(access(queuedPath));
});

test("Feishu settles and releases a queued media event whose temp file disappears before replay", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	adapter.connectionGeneration = 1;
	adapter.connected = false;
	adapter.client = { im: { v1: { messageResource: { get: async () => ({
		headers: { "content-type": "image/png" },
		getReadableStream: () => Readable.from([Buffer.from("image")]),
	}) } } } };
	adapter.onMessage(async () => undefined);
	const receive = adapter.onReceive({
		sender: { sender_type: "user", sender_id: { open_id: "ou_user", union_id: "on_user" } },
		message: { message_id: "missing-image", chat_id: "chat", chat_type: "p2p", message_type: "image", content: JSON.stringify({ image_key: "image-key" }), create_time: "1" },
	});
	await waitFor(() => adapter.pendingInbound.length === 1);
	const path = adapter.pendingInbound[0].message.mediaPaths[0];
	await rm(path, { force: true });
	adapter.connected = true;
	await adapter.drainPendingInbound();
	await assert.rejects(receive, /ENOENT/);
	assert.equal(adapter.pendingInboundInFlight, 0);
});

test("Feishu never replays queued events after formal shutdown", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	adapter.connectionGeneration = 1;
	adapter.connected = false;
	const delivered = [];
	adapter.onMessage(async (message) => { delivered.push(message.text); });
	const receive = adapter.onReceive(event("shutdown-message", "/late"));
	await waitFor(() => adapter.pendingInbound.length === 1);
	await adapter.disconnect();
	await receive;
	adapter.connected = true;
	await adapter.drainPendingInbound();
	assert.deepEqual(delivered, []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { FeishuAdapter, retryFeishuOperation } from "../dist/index.js";

const settings = {
	appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
	requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: true,
	retryBaseDelayMs: 0,
};

test("Feishu retry honors transient responses and Retry-After without retrying permanent 4xx", async () => {
	const delays = [];
	let calls = 0;
	const response = await retryFeishuOperation(async () => {
		calls += 1;
		if (calls === 1) throw { response: { status: 429, headers: { "retry-after": "0.25" } } };
		if (calls === 2) return { code: 99991400 };
		return { code: 0 };
	}, { baseDelayMs: 10, sleep: async (delay) => { delays.push(delay); } });
	assert.equal(response.code, 0);
	assert.equal(calls, 3);
	assert.deepEqual(delays, [250, 20]);

	let permanentCalls = 0;
	await assert.rejects(retryFeishuOperation(async () => {
		permanentCalls += 1;
		throw { response: { status: 400 } };
	}, { baseDelayMs: 0 }), (error) => error.response.status === 400);
	assert.equal(permanentCalls, 1);
	let unknownCalls = 0;
	await assert.rejects(retryFeishuOperation(async () => { unknownCalls += 1; throw new Error("bad payload shape"); }, { baseDelayMs: 0 }), /bad payload/);
	assert.equal(unknownCalls, 1);

	const dateDelays = [];
	const retryAt = new Date(Date.now() + 10_000).toUTCString();
	let dateCalls = 0;
	await retryFeishuOperation(async () => {
		dateCalls += 1;
		if (dateCalls === 1) throw { response: { status: 429, headers: { get: () => retryAt } } };
		return { code: 0 };
	}, { sleep: async (delay) => { dateDelays.push(delay); } });
	assert.ok(dateDelays[0] >= 8_000 && dateDelays[0] <= 10_000);
});

test("Feishu text sending retries transient SDK failures and stops after success", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	let calls = 0;
	const uuids = [];
	adapter.client = { im: { v1: { message: { create: async (payload) => {
		calls += 1;
		uuids.push(payload.data.uuid);
		if (calls < 3) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
		return { code: 0, data: { message_id: "sent" } };
	} } } } };
	assert.deepEqual(await adapter.send("chat", "hello"), { success: true, messageId: "sent" });
	assert.equal(calls, 3);
	assert.equal(new Set(uuids).size, 1);
});

test("Feishu text delivery keeps a stable UUID across outbox retries", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	const uuids = [];
	adapter.client = { im: { v1: { message: { create: async (payload) => { uuids.push(payload.data.uuid); return { code: 0, data: { message_id: "sent" } }; } } } } };
	await adapter.send("chat", "hello", { idempotencyKey: "notice-1" });
	await adapter.send("chat", "hello", { idempotencyKey: "notice-1" });
	assert.equal(uuids.length, 2);
	assert.equal(uuids[0], uuids[1]);
});

test("Feishu card reply falls back only when a non-thread target was withdrawn", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	const calls = [];
	adapter.client = { im: { v1: { message: {
		reply: async (payload) => { calls.push(["reply", payload]); return { code: 230011, msg: "withdrawn" }; },
		create: async (payload) => { calls.push(["create", payload]); return { code: 0, data: { message_id: "fallback" } }; },
	} } } };
	assert.deepEqual(await adapter.sendCard("chat", { schema: "2.0" }, "missing", false), { success: true, messageId: "fallback" });
	assert.deepEqual(calls.map(([kind]) => kind), ["reply", "create"]);

	calls.length = 0;
	const threaded = await adapter.sendCard("chat", { schema: "2.0" }, "missing", true);
	assert.equal(threaded.success, false);
	assert.deepEqual(calls.map(([kind]) => kind), ["reply"]);
});

test("Feishu disconnect force-closes the WebSocket and marks the adapter unavailable", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	const closes = [];
	adapter.connected = true;
	adapter.wsClient = { close: (options) => { closes.push(options); } };
	await adapter.disconnect();
	assert.equal(adapter.isConnected, false);
	assert.deepEqual(closes, [{ force: true }]);
});

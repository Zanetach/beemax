import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { FeishuAdapter } from "../dist/index.js";

const settings = {
	appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
	requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: true,
	textBatchDelayMs: 10, textBatchSplitDelayMs: 20, mediaBatchDelayMs: 10,
};

async function waitFor(predicate, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function textEvent(messageId, text, overrides = {}) {
	return {
		sender: { sender_type: "user", sender_id: { open_id: "ou_user", union_id: "on_user" } },
		message: {
			message_id: messageId, chat_id: "chat", chat_type: "p2p", message_type: "text",
			content: JSON.stringify({ text }), create_time: String(Date.now()), ...overrides,
		},
	};
}

test("Feishu batches a rapid compatible text burst into one Agent message", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	const delivered = [];
	adapter.onMessage(async (message) => { delivered.push(message); });

	await Promise.all([
		adapter.onReceive(textEvent("m1", "first")),
		adapter.onReceive(textEvent("m2", "second")),
		adapter.onReceive(textEvent("m3", "third")),
	]);

	assert.equal(delivered.length, 1);
	assert.equal(delivered[0].text, "first\nsecond\nthird");
	assert.equal(delivered[0].source.messageId, "m3");
});

test("Feishu commands bypass batching and incompatible reply contexts split batches", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	const delivered = [];
	adapter.onMessage(async (message) => { delivered.push(message); });

	await adapter.onReceive(textEvent("command", "/stop"));
	assert.equal(delivered[0].text, "/stop");

	await Promise.all([
		adapter.onReceive(textEvent("m1", "root", { root_id: "root-a" })),
		adapter.onReceive(textEvent("m2", "other", { root_id: "root-b" })),
	]);
	assert.deepEqual(delivered.map((message) => message.text), ["/stop", "root", "other"]);
});

test("Feishu splits text bursts at Hermes message and character bounds", async () => {
	const adapter = new FeishuAdapter({ ...settings, textBatchMaxMessages: 2, textBatchMaxChars: 10 });
	const delivered = [];
	const admitted = [];
	adapter.onMessage(async (message) => {
		admitted.push(message.text);
		if (message.text === "1234\n5678") await new Promise((resolve) => setTimeout(resolve, 15));
		delivered.push(message.text);
	});

	await Promise.all([
		adapter.onReceive(textEvent("m1", "1234")),
		adapter.onReceive(textEvent("m2", "5678")),
		adapter.onReceive(textEvent("m3", "90")),
		adapter.onReceive(textEvent("m4", "ab")),
	]);
	await waitFor(() => delivered.length === 2);
	assert.deepEqual(admitted, ["1234\n5678", "90\nab"]);
	assert.deepEqual(new Set(delivered), new Set(["1234\n5678", "90\nab"]));
});

test("Feishu admits a second message while the first Agent turn is still running", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	const admitted = [];
	let finishFirst;
	adapter.onMessage(async (message) => {
		admitted.push(message.text);
		if (message.text === "/first") await new Promise((resolve) => { finishFirst = resolve; });
	});

	await adapter.onReceive(textEvent("m1", "/first"));
	await adapter.onReceive(textEvent("m2", "/second"));
	assert.deepEqual(admitted, ["/first", "/second"]);
	finishFirst();
	await adapter.disconnect();
});

test("Feishu batches compatible media while preserving every downloaded attachment until delivery", async () => {
	const adapter = new FeishuAdapter({ ...settings, mediaBatchDelayMs: 30 });
	adapter.client = { im: { v1: { messageResource: { get: async ({ path }) => ({
		headers: { "content-type": "image/png" },
		getReadableStream: () => Readable.from((async function* () {
			if (path.file_key === "image-1") await new Promise((resolve) => setTimeout(resolve, 15));
			yield Buffer.from(path.file_key);
		})()),
	}) } } } };
	const delivered = [];
	adapter.onMessage(async (message) => {
		for (const path of message.mediaPaths) await access(path);
		delivered.push({ ...message, contents: await Promise.all(message.mediaPaths.map((path) => readFile(path, "utf8"))) });
	});
	const imageEvent = (messageId, imageKey, createTime) => ({
		sender: { sender_type: "user", sender_id: { open_id: "ou_user", union_id: "on_user" } },
		message: { message_id: messageId, chat_id: "chat", chat_type: "p2p", message_type: "image", content: JSON.stringify({ image_key: imageKey }), create_time: createTime },
	});

	await Promise.all([
		adapter.onReceive(imageEvent("m1", "image-1", "1")),
		adapter.onReceive(imageEvent("m2", "image-2", "2")),
	]);
	await waitFor(() => delivered.length === 1);
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0].mediaPaths.length, 2);
	assert.deepEqual(delivered[0].mediaTypes, ["image/png", "image/png"]);
	assert.deepEqual(delivered[0].contents, ["image-1", "image-2"]);
	assert.equal(delivered[0].source.messageId, "m2");
	for (const path of delivered[0].mediaPaths) await assert.rejects(access(path));
});

test("Feishu bounds sustained media bursts and does not dispatch a download completed after disconnect", async () => {
	const adapter = new FeishuAdapter({ ...settings, mediaBatchDelayMs: 50 });
	adapter.client = { im: { v1: { messageResource: { get: async ({ path }) => ({
		headers: { "content-type": "image/png" },
		getReadableStream: () => Readable.from((async function* () {
			if (path.file_key === "late") await new Promise((resolve) => setTimeout(resolve, 20));
			yield Buffer.from("x");
		})()),
	}) } } } };
	const batchSizes = [];
	adapter.onMessage(async (message) => { batchSizes.push(message.mediaPaths.length); });
	const imageEvent = (index) => ({
		sender: { sender_type: "user", sender_id: { open_id: "ou_user", union_id: "on_user" } },
		message: { message_id: `m${index}`, chat_id: "chat", chat_type: "p2p", message_type: "image", content: JSON.stringify({ image_key: `image-${index}` }), create_time: String(index) },
	});
	await Promise.all(Array.from({ length: 9 }, (_, index) => adapter.onReceive(imageEvent(index + 1))));
	await waitFor(() => batchSizes.length === 2);
	assert.deepEqual(batchSizes, [8, 1]);

	const late = adapter.onReceive({ ...imageEvent(10), message: { ...imageEvent(10).message, content: JSON.stringify({ image_key: "late" }) } });
	await adapter.disconnect();
	await late;
	assert.deepEqual(batchSizes, [8, 1]);
});

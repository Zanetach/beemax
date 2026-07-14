import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { TelegramAdapter } from "../dist/index.js";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("Telegram adapter normalizes authorized long-poll messages and sends replies", async () => {
	const calls = [];
	let updateDelivered = false;
	const fetch = async (url, init = {}) => {
		const method = String(url).split("/").at(-1);
		calls.push([method, init.body ? JSON.parse(String(init.body)) : undefined]);
		if (method === "getMe") return json({ ok: true, result: { id: 7, username: "beemax_bot" } });
		if (method === "getUpdates" && !updateDelivered) {
			updateDelivered = true;
			return json({ ok: true, result: [{
				update_id: 10,
				message: { message_id: 22, date: 1_700_000_000, chat: { id: 100, type: "private" }, from: { id: 42, username: "zane" }, text: "hello" },
			}] });
		}
		if (method === "getUpdates") return new Promise((resolve, reject) => {
			init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
		});
		if (method === "sendMessage") return json({ ok: true, result: { message_id: 23 } });
		throw new Error(`Unexpected Telegram method: ${method}`);
	};
	const adapter = new TelegramAdapter({
		botToken: "token",
		allowedUsers: ["42"],
		allowedChats: [],
		allowAllUsers: false,
		pollingTimeoutSeconds: 1,
		retryBaseDelayMs: 0,
	}, { fetch });
	const received = [];
	adapter.onMessage((message) => { received.push(message); });

	assert.equal(await adapter.connect(), true);
	await waitFor(() => received.length === 1);
	assert.deepEqual(received[0].source, {
		platform: "telegram", chatId: "100", chatType: "dm", userId: "42", userName: "zane", messageId: "22",
	});
	assert.equal(received[0].text, "hello");
	assert.deepEqual(await adapter.send("100", "world", { replyTo: "22" }), { success: true, messageId: "23" });
	assert.deepEqual(calls.find(([method]) => method === "sendMessage")[1], { chat_id: "100", text: "world", reply_parameters: { message_id: 22 } });
	await adapter.disconnect();
	assert.equal(adapter.isConnected, false);
});

test("Telegram adapter drops users and chats outside the configured access boundary", async () => {
	const adapter = new TelegramAdapter({
		botToken: "token", allowedUsers: ["42"], allowedChats: ["100"], allowAllUsers: false,
		pollingTimeoutSeconds: 1, retryBaseDelayMs: 0,
	});
	assert.equal(adapter.admit({ chatId: "100", userId: "42" }), null);
	assert.match(adapter.admit({ chatId: "100", userId: "99" }), /user/);
	assert.match(adapter.admit({ chatId: "200", userId: "42" }), /chat/);
});

test("Telegram adapter downloads inbound photos into bounded temporary media with explicit cleanup", async () => {
	let updateDelivered = false;
	const fetch = async (url, init = {}) => {
		const value = String(url);
		const method = value.split("/").at(-1);
		if (method === "getMe") return json({ ok: true, result: { id: 7 } });
		if (method === "getUpdates" && !updateDelivered) {
			updateDelivered = true;
			return json({ ok: true, result: [{ update_id: 11, message: {
				message_id: 24, date: 1_700_000_001, chat: { id: 100, type: "private" }, from: { id: 42 },
				photo: [{ file_id: "small", width: 10, height: 10, file_size: 20 }, { file_id: "large", width: 100, height: 100, file_size: 100 }],
			} }] });
		}
		if (method === "getUpdates") return new Promise((resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		if (method === "getFile") return json({ ok: true, result: { file_path: "photos/image.jpg", file_size: 4 } });
		if (value.includes("/file/bot")) return new Response(Buffer.from([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/jpeg", "content-length": "4" } });
		throw new Error(`Unexpected Telegram request: ${value}`);
	};
	const adapter = new TelegramAdapter({ botToken: "token", allowedUsers: ["42"], allowedChats: [], allowAllUsers: false, retryBaseDelayMs: 0 }, { fetch });
	const received = [];
	adapter.onMessage((message) => { received.push(message); });
	await adapter.connect();
	await waitFor(() => received.length === 1);
	assert.equal(received[0].messageType, "image");
	assert.equal(received[0].text, "[Telegram image]");
	assert.deepEqual(received[0].mediaTypes, ["image/jpeg"]);
	await access(received[0].mediaPaths[0]);
	await received[0].releaseMedia();
	await assert.rejects(access(received[0].mediaPaths[0]));
	await adapter.disconnect();
});

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("Timed out waiting for Telegram adapter event");
}

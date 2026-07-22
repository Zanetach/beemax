import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TelegramAdapter } from "../dist/index.js";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const telegramAdapter = (settings, dependencies) => {
	const { botToken, ...runtimeSettings } = settings;
	return new TelegramAdapter(runtimeSettings, (consumer) => consumer({ botToken }), dependencies);
};

test("Telegram adapter normalizes authorized long-poll messages and sends replies", async () => {
	const calls = [];
	let updateDelivered = false;
	const fetch = async (url, init = {}) => {
		const method = String(url).split("/").at(-1);
		calls.push([method, init.body ? JSON.parse(String(init.body)) : undefined]);
		if (method === "getMe") return json({ ok: true, result: { id: 7, username: "thruvera_bot" } });
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
	const adapter = telegramAdapter({
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
	const adapter = telegramAdapter({
		botToken: "token", allowedUsers: ["42"], allowedChats: ["100"], allowAllUsers: false,
		pollingTimeoutSeconds: 1, retryBaseDelayMs: 0,
	});
	assert.equal(adapter.admit({ chatId: "100", userId: "42" }), null);
	assert.match(adapter.admit({ chatId: "100", userId: "99" }), /user/);
	assert.match(adapter.admit({ chatId: "200", userId: "42" }), /chat/);
});

test("Telegram explicit group activation admits verified mention and command signals only", async () => {
	let updatesDelivered = false;
	const fetch = async (url, init = {}) => {
		const method = String(url).split("/").at(-1);
		if (method === "getMe") return json({ ok: true, result: { id: 7, username: "thruvera_bot" } });
		if (method === "getUpdates" && !updatesDelivered) {
			updatesDelivered = true;
			return json({ ok: true, result: [
				{ update_id: 20, message: { message_id: 30, date: 1, message_thread_id: 9, chat: { id: 100, type: "supergroup" }, from: { id: 42 }, text: "ordinary" } },
				{ update_id: 21, message: { message_id: 31, date: 2, message_thread_id: 9, chat: { id: 100, type: "supergroup" }, from: { id: 42 }, text: "@thruvera_bot inspect", entities: [{ type: "mention", offset: 0, length: 13 }] } },
				{ update_id: 22, message: { message_id: 32, date: 3, message_thread_id: 9, chat: { id: 100, type: "supergroup" }, from: { id: 42 }, text: "/status", entities: [{ type: "bot_command", offset: 0, length: 7 }] } },
			] });
		}
		if (method === "getUpdates") return new Promise((resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		throw new Error(`Unexpected Telegram method: ${method}`);
	};
	const adapter = telegramAdapter({ botToken: "token", allowedUsers: ["42"], allowedChats: ["100"], allowAllUsers: false, retryBaseDelayMs: 0 }, { fetch });
	const received = [];
	adapter.onMessage((message) => { received.push(message); });
	await adapter.connect();
	await waitFor(() => received.length === 2);
	assert.deepEqual(received.map((message) => [message.text, message.messageType, message.source.threadId]), [
		["@thruvera_bot inspect", "text", "9"],
		["/status", "command", "9"],
	]);
	await adapter.disconnect();
});

test("Telegram contextual activation keeps natural follow-ups inside the activated Thread", async () => {
	let delivered = false;
	const fetch = async (url, init = {}) => {
		const method = String(url).split("/").at(-1);
		if (method === "getMe") return json({ ok: true, result: { id: 7, username: "thruvera_bot" } });
		if (method === "getUpdates" && !delivered) {
			delivered = true;
			return json({ ok: true, result: [
				{ update_id: 30, message: { message_id: 40, date: 1, message_thread_id: 9, chat: { id: 100, type: "supergroup" }, from: { id: 42 }, text: "@thruvera_bot start", entities: [{ type: "mention", offset: 0, length: 13 }] } },
				{ update_id: 31, message: { message_id: 41, date: 2, message_thread_id: 9, chat: { id: 100, type: "supergroup" }, from: { id: 42 }, text: "continue" } },
				{ update_id: 32, message: { message_id: 42, date: 3, message_thread_id: 10, chat: { id: 100, type: "supergroup" }, from: { id: 42 }, text: "unrelated thread" } },
			] });
		}
		if (method === "getUpdates") return new Promise((resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		throw new Error(`Unexpected Telegram method: ${method}`);
	};
	const adapter = telegramAdapter({
		botToken: "token", allowedUsers: ["42"], allowedChats: ["100"], allowAllUsers: false, retryBaseDelayMs: 0,
		activation: { mode: "contextual", respondTo: ["mention", "active_thread"] },
	}, { fetch });
	const received = [];
	adapter.onMessage((message) => { received.push(message); });
	await adapter.connect();
	await waitFor(() => received.length === 2);
	assert.deepEqual(received.map((message) => [message.text, message.source.threadId]), [["@thruvera_bot start", "9"], ["continue", "9"]]);
	await adapter.disconnect();
});

test("Telegram ambient observation stays outside the Agent message path", async () => {
	let delivered = false;
	const fetch = async (url, init = {}) => {
		const method = String(url).split("/").at(-1);
		if (method === "getMe") return json({ ok: true, result: { id: 7, username: "thruvera_bot" } });
		if (method === "getUpdates" && !delivered) {
			delivered = true;
			return json({ ok: true, result: [{ update_id: 40, message: { message_id: 50, date: 4, chat: { id: 100, type: "supergroup" }, from: { id: 42 }, text: "potentially useful context" } }] });
		}
		if (method === "getUpdates") return new Promise((resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		throw new Error(`Unexpected Telegram method: ${method}`);
	};
	const adapter = telegramAdapter({
		botToken: "token", allowedUsers: ["42"], allowedChats: ["100"], allowAllUsers: false, retryBaseDelayMs: 0,
		activation: { mode: "explicit", respondTo: ["mention", "reply", "command"], ambientObservation: true },
	}, { fetch });
	const messages = [];
	const observations = [];
	adapter.onMessage((message) => { messages.push(message); });
	adapter.onObservation((observation) => { observations.push(observation); });
	await adapter.connect();
	await waitFor(() => observations.length === 1);
	assert.equal(messages.length, 0);
	assert.deepEqual(observations[0], {
		text: "potentially useful context",
		source: { platform: "telegram", chatId: "100", chatType: "group", userId: "42", userName: "42", messageId: "50" },
		timestamp: 4_000,
	});
	await adapter.disconnect();
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
	const adapter = telegramAdapter({ botToken: "token", allowedUsers: ["42"], allowedChats: [], allowAllUsers: false, retryBaseDelayMs: 0 }, { fetch });
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

test("Telegram adapter rejects oversized outbound media before reading or uploading it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "beemax-telegram-outbound-limit-"));
	try {
		const path = join(directory, "oversized.pdf");
		await writeFile(path, Buffer.alloc(1_025, 1));
		let fetchCalls = 0;
		const adapter = telegramAdapter({
			botToken: "token",
			allowedUsers: ["42"],
			allowedChats: [],
			allowAllUsers: false,
			mediaMaxBytes: 1_024,
		}, { fetch: async () => { fetchCalls += 1; return json({ ok: true, result: { message_id: 1 } }); } });

		await assert.rejects(adapter.sendMedia("100", path, "application/pdf", "oversized.pdf"), /exceeds 1024 byte limit/u);
		assert.equal(fetchCalls, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("Timed out waiting for Telegram adapter event");
}

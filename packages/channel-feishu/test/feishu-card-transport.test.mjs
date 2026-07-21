import assert from "node:assert/strict";
import { mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { FeishuAdapter, parseFeishuCardActionEvent } from "../dist/index.js";

const settings = {
	appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket",
	requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: true,
};

test("Feishu cards reply to the triggering message and preserve topic routing", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	const calls = [];
	adapter.client = { im: { v1: { message: {
		reply: async (payload) => { calls.push(["reply", payload]); return { code: 0, data: { message_id: "reply-card" } }; },
		create: async (payload) => { calls.push(["create", payload]); return { code: 0, data: { message_id: "new-card" } }; },
	} } } };
	assert.deepEqual(await adapter.sendCard("chat", { schema: "2.0" }, "source-message", true), { success: true, messageId: "reply-card" });
	assert.equal(calls[0][0], "reply");
	assert.equal(calls[0][1].path.message_id, "source-message");
	assert.equal(calls[0][1].data.reply_in_thread, true);
	assert.equal(calls[0][1].data.msg_type, "interactive");
	assert.deepEqual(await adapter.sendCard("chat", { schema: "2.0" }), { success: true, messageId: "new-card" });
	assert.equal(calls[1][0], "create");
	assert.equal(calls[1][1].data.receive_id, "chat");
});

test("Feishu CardKit transport creates a card entity and streams only the answer element", async () => {
	const calls = [];
	const adapter = new FeishuAdapter({ ...settings });
	adapter.client = {
		cardkit: { v1: {
			card: {
				create: async (payload) => { calls.push(["card.create", payload]); return { code: 0, data: { card_id: "card-entity" } }; },
				update: async (payload) => { calls.push(["card.update", payload]); return { code: 0 }; },
				settings: async (payload) => { calls.push(["card.settings", payload]); return { code: 0 }; },
			},
			cardElement: {
				content: async (payload) => { calls.push(["cardElement.content", payload]); return { code: 0 }; },
			},
		} },
		im: { v1: { message: {
			reply: async (payload) => { calls.push(["message.reply", payload]); return { code: 0, data: { message_id: "card-message" } }; },
			create: async (payload) => { calls.push(["message.create", payload]); return { code: 0, data: { message_id: "new-message" } }; },
		} } },
	};
	const card = { schema: "2.0", config: { streaming_mode: true }, body: { elements: [{ tag: "markdown", element_id: "main_content", content: "处理中" }] } };

	assert.deepEqual(await adapter.sendStreamingCard("chat", card, "source-message", true, "stream-key"), { success: true, messageId: "card-message", cardId: "card-entity" });
	assert.deepEqual(JSON.parse(calls[0][1].data.data), card);
	assert.deepEqual(JSON.parse(calls[1][1].data.content), { type: "card", data: { card_id: "card-entity" } });
	assert.equal(calls[1][1].data.reply_in_thread, true);
	assert.deepEqual(await adapter.updateStreamingCardContent("card-entity", "main_content", "完整正文", 1), { success: true });
	assert.deepEqual(calls[2][1].path, { card_id: "card-entity", element_id: "main_content" });
	assert.equal(calls[2][1].data.content, "完整正文");
	assert.equal(calls[2][1].data.sequence, 1);
	assert.deepEqual(await adapter.updateStreamingCard("card-entity", card, 2), { success: true });
	assert.equal(calls[3][1].data.sequence, 2);
	assert.deepEqual(await adapter.finishStreamingCard("card-entity", "任务已完成", 3), { success: true });
	assert.deepEqual(JSON.parse(calls[4][1].data.settings), { config: { streaming_mode: false, summary: { content: "任务已完成" } } });
	assert.equal(calls[4][1].data.sequence, 3);
});

test("Feishu Card JSON 2.0 callbacks normalize identity, routing, and stable action id", () => {
	const raw = {
		context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
		operator: { open_id: "ou_user", user_id: "user", union_id: "on_user" },
		action: { tag: "button", name: "show_details", value: { choice: "expanded", beemax_action: "details.set" } },
	};
	const first = parseFeishuCardActionEvent(raw);
	const reordered = parseFeishuCardActionEvent({ ...raw, action: { ...raw.action, value: { beemax_action: "details.set", choice: "expanded" } } });
	assert.equal(first.messageId, "om_card");
	assert.equal(first.chatId, "oc_chat");
	assert.equal(first.userId, "ou_user");
	assert.equal(first.userIdAlt, "on_user");
	assert.equal(first.actionId, reordered.actionId);
	assert.deepEqual(first.value, raw.action.value);
});

test("Feishu processing reactions mirror Hermes start, success, and failure states", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	const calls = [];
	adapter.client = { im: { v1: { messageReaction: {
		create: async (payload) => {
			calls.push(["create", payload]);
			return { code: 0, data: { reaction_id: `reaction-${calls.length}` } };
		},
		delete: async (payload) => { calls.push(["delete", payload]); return { code: 0 }; },
	} } } };

	await adapter.sendTyping("chat", "message-ok");
	await adapter.stopTyping("chat", "message-ok");
	await adapter.sendTyping("chat", "message-failed");
	await adapter.stopTyping("chat", "message-failed", true);

	assert.equal(calls[0][1].path.message_id, "message-ok");
	assert.equal(calls[0][1].data.reaction_type.emoji_type, "Typing");
	assert.deepEqual(calls[1], ["delete", { path: { message_id: "message-ok", reaction_id: "reaction-1" } }]);
	assert.equal(calls[2][1].data.reaction_type.emoji_type, "Typing");
	assert.deepEqual(calls[3], ["delete", { path: { message_id: "message-failed", reaction_id: "reaction-3" } }]);
	assert.equal(calls[4][1].path.message_id, "message-failed");
	assert.equal(calls[4][1].data.reaction_type.emoji_type, "CrossMark");
});

test("Feishu processing reactions are best-effort when message ids or permissions are unavailable", async () => {
	const adapter = new FeishuAdapter({ ...settings });
	let creates = 0;
	adapter.client = { im: { v1: { messageReaction: {
		create: async () => { creates += 1; throw new Error("forbidden"); },
		delete: async () => { throw new Error("forbidden"); },
	} } } };
	await adapter.sendTyping("chat");
	await adapter.stopTyping("chat");
	await adapter.sendTyping("chat", "message");
	await adapter.stopTyping("chat", "message", true);
	assert.equal(creates, 2);
});

test("Feishu uploads and sends generic files, video, and Opus audio natively", async () => {
	const dir = await mkdtemp(join(tmpdir(), "beemax-feishu-media-"));
	try {
		const cases = [
			["report.pdf", "application/pdf", "pdf", "file"],
			["clip.mp4", "video/mp4", "mp4", "media"],
			["voice.opus", "audio/opus", "opus", "audio"],
		];
		for (const [name, mimeType, fileType, messageType] of cases) {
			const path = join(dir, name);
			await writeFile(path, "media");
			const calls = [];
			const adapter = new FeishuAdapter({ ...settings });
			adapter.client = { im: { v1: {
				file: { create: async (payload) => { calls.push(["upload", payload]); return { file_key: "file-key" }; } },
				message: { create: async (payload) => { calls.push(["send", payload]); return { code: 0, data: { message_id: "sent" } }; } },
			} } };
			assert.deepEqual(await adapter.sendMedia("chat", path, mimeType), { success: true, messageId: "sent" });
			assert.equal(calls[0][1].data.file_type, fileType);
			assert.equal(calls[0][1].data.file_name, name);
			assert.equal(calls[1][1].data.msg_type, messageType);
			assert.deepEqual(JSON.parse(calls[1][1].data.content), { file_key: "file-key" });
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Feishu retries an outbound upload from one bounded stable read when the source path is replaced", async () => {
	const dir = await mkdtemp(join(tmpdir(), "beemax-feishu-media-retry-snapshot-"));
	try {
		const path = join(dir, "report.pdf");
		const replacementPath = join(dir, "replacement.pdf");
		const original = Buffer.from("%PDF-original-stable-upload");
		const replacement = Buffer.alloc(original.byteLength, 0x58);
		await writeFile(path, original);
		const uploads = [];
		let uploadAttempts = 0;
		const adapter = new FeishuAdapter({ ...settings, retryBaseDelayMs: 0 });
		adapter.client = { im: { v1: {
			file: { create: async (payload) => {
				const chunks = [];
				if (Buffer.isBuffer(payload.data.file)) chunks.push(Buffer.from(payload.data.file));
				else for await (const chunk of payload.data.file) chunks.push(Buffer.from(chunk));
				uploads.push(Buffer.concat(chunks));
				uploadAttempts += 1;
				if (uploadAttempts === 1) {
					await writeFile(replacementPath, replacement);
					await rename(replacementPath, path);
					throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
				}
				return { file_key: "file-key" };
			} },
			message: { create: async () => ({ code: 0, data: { message_id: "sent" } }) },
		} } };

		assert.deepEqual(await adapter.sendMedia("chat", path, "application/pdf"), { success: true, messageId: "sent" });
		assert.equal(uploadAttempts, 2);
		assert.deepEqual(uploads, [original, original]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Feishu rejects empty and oversized generic outbound media before upload", async () => {
	const dir = await mkdtemp(join(tmpdir(), "beemax-feishu-media-limit-"));
	try {
		const empty = join(dir, "empty.bin");
		await writeFile(empty, "");
		const adapter = new FeishuAdapter({ ...settings });
		adapter.client = { im: { v1: { file: { create: async () => { throw new Error("must not upload"); } } } } };
		const result = await adapter.sendMedia("chat", empty, "application/octet-stream");
		assert.equal(result.success, false);
		assert.match(result.error, /non-empty file no larger than 30MB/);
		const oversized = join(dir, "oversized.bin");
		await writeFile(oversized, "x");
		await truncate(oversized, 30 * 1024 * 1024 + 1);
		const oversizedResult = await adapter.sendMedia("chat", oversized, "application/octet-stream");
		assert.equal(oversizedResult.success, false);
		assert.match(oversizedResult.error, /non-empty file no larger than 30MB/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

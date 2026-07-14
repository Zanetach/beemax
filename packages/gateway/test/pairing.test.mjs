import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FeishuAdapter, PairingStore } from "../dist/index.js";

test("PairingStore creates, approves, reloads, revokes, expires, and rate-limits profile grants", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-pairing-"));
	try {
		const store = new PairingStore(root);
		const request = store.request("feishu", "ou_user", 1_000);
		assert.equal(request.status, "created");
		assert.match(request.code, /^[A-HJ-NP-Z2-9]{8}$/);
		assert.equal(store.request("feishu", "ou_user", 2_000).status, "rate_limited");
		assert.equal(store.request("feishu", "ou_user", 601_000).status, "existing");
		assert.equal(store.isApproved("feishu", ["ou_user"]), false);
		assert.equal(store.approve("feishu", request.code, 3_000).userId, "ou_user");
		assert.equal(new PairingStore(root).isApproved("feishu", ["ou_user"]), true);
		assert.equal(store.revoke("feishu", "ou_user"), true);
		assert.equal(store.isApproved("feishu", ["ou_user"]), false);
		const other = store.request("feishu", "ou_other", 4_000);
		assert.equal(other.status, "created");
		assert.equal(store.list("feishu", other.expiresAt).pending.length, 0);
		assert.equal(store.request("feishu", "ou_other", other.expiresAt).status, "created");
		const directory = join(root, "state", "pairing");
		assert.equal(statSync(directory).mode & 0o777, 0o700);
		assert.equal(statSync(join(directory, "state.json")).mode & 0o777, 0o600);
		assert.doesNotMatch(readFileSync(join(directory, "state.json"), "utf8"), /ABCDEFGH/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("PairingStore fails closed instead of replacing corrupt authorization state", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-pairing-corrupt-"));
	try {
		const store = new PairingStore(root);
		store.request("feishu", "ou_user");
		const path = join(root, "state", "pairing", "state.json");
		writeFileSync(path, "{broken", { mode: 0o600 });
		assert.throws(() => store.isApproved("feishu", ["ou_user"]), /corrupt/);
		assert.throws(() => store.request("feishu", "ou_other"), /corrupt/);
		assert.equal(readFileSync(path, "utf8"), "{broken");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Feishu admission routes unknown DMs to pairing and admits approved identities without opening groups", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-pairing-admit-"));
	try {
		const pairing = new PairingStore(root);
		const adapter = new FeishuAdapter({ appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket", requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: false, pairing });
		const sender = { sender_type: "user", sender_id: { open_id: "ou_unknown", union_id: "on_unknown" } };
		const direct = { chat_type: "p2p", chat_id: "chat", message_id: "message", message_type: "text", content: "{}", create_time: "1" };
		assert.equal(adapter.admit(sender, direct), "pairing required");
		const request = pairing.request("feishu", "on_unknown", 1_000);
		pairing.approve("feishu", request.code, 2_000);
		assert.equal(adapter.admit(sender, direct), null);
		pairing.revoke("feishu", "on_unknown");
		assert.equal(adapter.admit(sender, direct), "pairing required");
		const allowlisted = new FeishuAdapter({ appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket", requireMention: true, allowedUsers: ["ou_unknown"], allowedChats: [], allowAllUsers: false, pairing });
		assert.equal(allowlisted.admit(sender, direct), null, "static allowlist remains an independent authorization grant");
		assert.equal(adapter.admit({ sender_type: "user", sender_id: { open_id: "ou_other" } }, { ...direct, chat_type: "group" }), "sender is not authorized for group");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown Feishu DMs receive a pairing code and never reach the Agent before approval", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-pairing-message-"));
	try {
		const pairing = new PairingStore(root);
		const adapter = new FeishuAdapter({ appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket", requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: false, pairing });
		const sent = [];
		adapter.client = { im: { v1: { message: { create: async (payload) => { sent.push(JSON.parse(payload.data.content).text); return { code: 0, data: { message_id: "reply" } }; } } } } };
		let delivered = 0;
		adapter.onMessage(() => { delivered++; });
		const event = (messageId) => ({ sender: { sender_type: "user", sender_id: { open_id: "ou_user" } }, message: { message_id: messageId, chat_id: "chat", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "hello" }), create_time: "1" } });
		await adapter.onReceive(event("m1"));
		assert.equal(delivered, 0);
		assert.match(sent[0], /Pairing code: [A-HJ-NP-Z2-9]{8}/);
		await adapter.onReceive(event("m1-followup"));
		assert.equal(sent.length, 1, "rate-limited pairing retries must not flood the DM");
		const code = pairing.list().pending[0].code;
		pairing.approve("feishu", code);
		await adapter.onReceive(event("m2"));
		assert.equal(delivered, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("PairingStore bounds pending requests and locks repeated invalid approvals", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-pairing-lock-"));
	try {
		const store = new PairingStore(root);
		for (const user of ["u1", "u2", "u3"]) assert.equal(store.request("feishu", user, 100).status, "created");
		assert.equal(store.request("feishu", "u4", 100).status, "capacity");
		for (let attempt = 0; attempt < 5; attempt++) assert.equal(store.approve("feishu", "BADCODE", 200), undefined);
		assert.throws(() => store.approve("feishu", "BADCODE", 201), /temporarily locked/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("PairingStore cross-process lock preserves the global pending bound", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-pairing-processes-"));
	try {
		const modulePath = resolve("packages/gateway/dist/index.js");
		const script = `import { pathToFileURL } from "node:url"; const { PairingStore } = await import(pathToFileURL(process.argv[1])); new PairingStore(process.argv[2]).request("feishu", process.argv[3]);`;
		await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolveWorker, rejectWorker) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", script, modulePath, root, `ou_${index}`], { stdio: "ignore" });
			child.once("error", rejectWorker);
			child.once("exit", (code) => code === 0 ? resolveWorker() : rejectWorker(new Error(`pairing worker exited ${code}`)));
		})));
		assert.equal(new PairingStore(root).list().pending.length, 3);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Feishu group policies support global and per-chat authorization without affecting DMs", () => {
	const sender = { sender_type: "user", sender_id: { open_id: "ou_user" } };
	const message = { chat_type: "group", chat_id: "chat", message_id: "m", message_type: "text", content: "{}", create_time: "1", mentions: [{ id: { open_id: "ou_bot" }, name: "bot" }] };
	const settings = { appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket", requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: false, botOpenId: "ou_bot" };
	assert.equal(new FeishuAdapter({ ...settings, groupPolicy: "open" }).admit(sender, message), null);
	assert.equal(new FeishuAdapter({ ...settings, groupPolicy: "disabled" }).admit(sender, message), "group is disabled");
	assert.equal(new FeishuAdapter({ ...settings, groupPolicy: "allowlist" }).admit(sender, message), "sender is not authorized for group");
	assert.equal(new FeishuAdapter({ ...settings, groupRules: { chat: { policy: "allowlist", allowlist: ["ou_user"] } } }).admit(sender, message), null);
	assert.equal(new FeishuAdapter({ ...settings, groupRules: { chat: { policy: "blacklist", blacklist: ["ou_user"] } } }).admit(sender, message), "sender is blocked in group");
	assert.equal(new FeishuAdapter({ ...settings, admins: ["ou_user"], groupRules: { chat: { policy: "admin_only" } } }).admit(sender, message), null);
});

test("Feishu contextual activation carries natural follow-ups only within the activated thread", () => {
	const sender = { sender_type: "user", sender_id: { open_id: "ou_user" } };
	const settings = {
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket", requireMention: true,
		allowedUsers: ["ou_user"], allowedChats: [], allowAllUsers: false, botOpenId: "ou_bot", groupPolicy: "allowlist",
		activation: { mode: "contextual", respondTo: ["mention", "active_thread"], activeThreadTtlMs: 60_000, maxActiveThreads: 10 },
	};
	const adapter = new FeishuAdapter(settings);
	const message = { chat_type: "group", chat_id: "chat", thread_id: "topic-1", message_id: "m1", message_type: "text", content: JSON.stringify({ text: "start" }), create_time: "1", mentions: [{ id: { open_id: "ou_bot" }, name: "bot" }] };
	assert.equal(adapter.admit(sender, message), null);
	assert.equal(adapter.admit(sender, { ...message, message_id: "m2", mentions: [] }), null);
	assert.equal(adapter.admit(sender, { ...message, thread_id: "topic-2", message_id: "m3", mentions: [] }), "group message without bot mention");
});

test("Feishu contextual activation trusts replies only when the parent is known Agent output", async () => {
	const sender = { sender_type: "user", sender_id: { open_id: "ou_user" } };
	const adapter = new FeishuAdapter({
		appId: "app", appSecret: "secret", domain: "feishu", connectionMode: "websocket", requireMention: true,
		allowedUsers: ["ou_user"], allowedChats: [], allowAllUsers: false, groupPolicy: "allowlist",
		activation: { mode: "contextual", respondTo: ["reply"], activeThreadTtlMs: 60_000, maxActiveThreads: 10 },
	});
	adapter.client = { im: { v1: { message: { create: async () => ({ code: 0, data: { message_id: "agent-output" } }) } } } };
	assert.equal((await adapter.send("chat", "answer")).success, true);
	const message = { chat_type: "group", chat_id: "chat", thread_id: "topic", message_id: "reply", parent_id: "agent-output", message_type: "text", content: JSON.stringify({ text: "continue" }), create_time: "1", mentions: [] };
	assert.equal(adapter.admit(sender, message), null);
	assert.equal(adapter.admit(sender, { ...message, thread_id: "other", message_id: "untrusted", parent_id: "someone-else" }), "group message without bot mention");
});

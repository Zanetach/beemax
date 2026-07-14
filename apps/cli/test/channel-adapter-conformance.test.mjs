import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFeishuAdapterRegistration } from "@beemax/channel-feishu";
import { createTelegramAdapterRegistration } from "@beemax/channel-telegram";

const candidates = [feishuCandidate(), telegramCandidate()];

for (const candidate of candidates) {
	test(`${candidate.name} conforms to the shared Channel Adapter contract`, async () => {
		const harness = await candidate.create();
		try {
			const first = harness.registration.create(harness.instance("primary", "actor-a"));
			const second = harness.registration.create(harness.instance("secondary", "actor-b"));
			assert.notEqual(first, second);
			assert.equal(first.name, candidate.adapter);
			assert.equal(harness.admit(first, "actor-a"), null);
			assert.match(harness.admit(first, "actor-b"), /authoriz/i);
			assert.deepEqual(Object.keys(first.capabilities).sort(), ["interactiveActions", "mediaDelivery", "messageEditing", "richPresentation"]);
			const inboundPromise = harness.captureInbound(second);
			await first.connect();
			await second.connect();
			assert.equal(first.isConnected, true);
			assert.equal(second.isConnected, true);
			await first.disconnect();
			assert.equal(first.isConnected, false);
			assert.equal(second.isConnected, true, "one Channel Instance disconnect must not affect another");
			const sent = await harness.send(second);
			assert.equal(sent.success, true);
			assert.ok(sent.messageId);
			await harness.emitInbound(second);
			const inbound = await Promise.race([inboundPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for public transport ingress")), 5_000))]);
			assert.equal(inbound.source.platform, candidate.adapter);
			assert.equal(inbound.source.userId, "actor-b");
			assert.ok(inbound.source.chatId);
			await harness.assertBoundedMedia(second);
			harness.assertCredentialIsolation();
			await second.disconnect();
			assert.equal(second.isConnected, false);
			assert.throws(() => harness.registration.create({ ...harness.instance("missing", "actor"), credentialRef: "missing" }), /missing.*credentials/i);
			assert.throws(() => harness.registration.create({ ...harness.instance("wrong", "actor"), adapter: "another-platform" }), /cannot create/i);
			assert.throws(() => harness.registration.create({ ...harness.instance("invalid", "actor"), settings: harness.invalidSettings }), harness.invalidPattern);
		} finally {
			await harness.cleanup();
		}
	});
}

function feishuCandidate() {
	return {
		name: "Feishu", adapter: "feishu",
		async create() {
			const credentialUses = [];
			const ports = { primary: await freePort(), secondary: await freePort(), missing: await freePort(), wrong: await freePort(), invalid: await freePort() };
			const registration = createFeishuAdapterRegistration({
				defaults: (instance) => ({ domain: "feishu", connectionMode: "webhook", webhookHost: "127.0.0.1", webhookPort: ports[instance.id], webhookPath: "/events", requireMention: true, allowedUsers: [], allowedChats: [], allowAllUsers: false, botOpenId: "bot", textBatchDelayMs: 0, retryBaseDelayMs: 0 }),
				consumeCredentials: (instance, consumer) => {
					if (instance.credentialRef === "missing") return undefined;
					credentialUses.push(`${instance.id}:${instance.credentialRef}`);
					return consumer({ appId: `app-${instance.id}`, appSecret: `secret-${instance.id}`, webhookVerificationToken: "verify-token", webhookEncryptKey: "encrypt-key" });
				},
				dependencies: { createClient: (credentials) => ({ im: { v1: { message: { create: async () => ({ code: 0, data: { message_id: `sent-${credentials.appId}` } }) } } } }) },
			});
			return {
				registration, invalidSettings: { webhookEncryptKey: "secret-in-settings" }, invalidPattern: /unknown.*webhookEncryptKey/i,
				instance: (id, actor) => ({ id, adapter: "feishu", enabled: true, credentialRef: `profile-env:channel:${id}`, settings: { allowedUsers: [actor] } }),
				admit: (adapter, actor) => adapter.admit({ sender_id: { open_id: actor } }, { chat_id: "dm", chat_type: "p2p", message_id: actor, message_type: "text", content: "{}" }),
				send: (adapter) => adapter.send("chat", "hello"),
				captureInbound: (adapter) => new Promise((resolve) => adapter.onMessage(resolve)),
				emitInbound: async () => {
					const body = JSON.stringify({ schema: "2.0", header: { event_id: "event-1", event_type: "im.message.receive_v1", create_time: "1", token: "verify-token", app_id: "app-secondary" }, event: { sender: { sender_id: { open_id: "actor-b" }, sender_type: "user" }, message: { chat_id: "chat", chat_type: "p2p", message_id: "inbound", message_type: "text", content: JSON.stringify({ text: "hello" }), create_time: "1" } } });
					const timestamp = "1";
					const nonce = "conformance";
					const signature = createHash("sha256").update(timestamp + nonce + "encrypt-key" + body).digest("hex");
					assert.equal((await httpPost(ports.secondary, "/events", body, { "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce, "x-lark-signature": signature })).status, 200);
				},
				assertBoundedMedia: async (adapter) => {
					const directory = await mkdtemp(join(tmpdir(), "beemax-conformance-"));
					const path = join(directory, "oversized.png");
					try { await writeFile(path, "x"); await truncate(path, 10 * 1024 * 1024 + 1); assert.equal((await adapter.sendImage("chat", path)).success, false); }
					finally { await rm(directory, { recursive: true, force: true }); }
				},
				assertCredentialIsolation: () => {
					assert.ok(credentialUses.includes("primary:profile-env:channel:primary"));
					assert.ok(credentialUses.includes("secondary:profile-env:channel:secondary"));
				},
				cleanup: async () => undefined,
			};
		},
	};
}

function telegramCandidate() {
	return {
		name: "Telegram", adapter: "telegram",
		async create() {
			let sent = 0;
			const credentialUses = [];
			const deliveries = new Map();
			let oversizedDelivered = false;
			let getFileCalls = 0;
			const fetch = async (url, init = {}) => {
				const method = String(url).split("/").at(-1);
				if (method === "getMe") return json({ ok: true, result: { id: 7, username: "beemax_bot" } });
				if (method === "getUpdates") {
					const instance = String(url).includes("token-secondary") ? "secondary" : "primary";
					const count = deliveries.get(instance) ?? 0;
					if (count === 0) {
						deliveries.set(instance, 1);
						return json({ ok: true, result: [{ update_id: instance === "secondary" ? 2 : 1, message: { message_id: 1, date: 1, chat: { id: 2, type: "private" }, from: { id: instance === "secondary" ? "actor-b" : "actor-a" }, text: "hello" } }] });
					}
					if (instance === "secondary" && count === 1) {
						deliveries.set(instance, 2);
						oversizedDelivered = true;
						return json({ ok: true, result: [{ update_id: 3, message: { message_id: 2, date: 1, chat: { id: 2, type: "private" }, from: { id: "actor-b" }, photo: [{ file_id: "oversized", width: 1, height: 1, file_size: 2_048 }] } }] });
					}
					return new Promise((resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
				}
				if (method === "getFile") { getFileCalls++; throw new Error("Oversized media must be rejected before getFile"); }
				if (method === "sendMessage") return json({ ok: true, result: { message_id: ++sent } });
				throw new Error(`Unexpected Telegram method: ${method}`);
			};
			const registration = createTelegramAdapterRegistration({ defaults: { allowedUsers: [], allowedChats: [], allowAllUsers: false, mediaMaxBytes: 1_024 }, consumeCredentials: (instance, consumer) => { if (instance.credentialRef === "missing") return undefined; credentialUses.push(`${instance.id}:${instance.credentialRef}`); return consumer({ botToken: `token-${instance.id}` }); }, dependencies: { fetch } });
			return {
				registration, invalidSettings: { allowAllUsers: "yes" }, invalidPattern: /allowAllUsers/i,
				instance: (id, actor) => ({ id, adapter: "telegram", enabled: true, credentialRef: `profile-env:channel:${id}`, settings: { allowedUsers: [actor] } }),
				admit: (adapter, actor) => adapter.admit({ chatId: "dm", chatType: "dm", userId: actor }),
				send: (adapter) => adapter.send("chat", "hello"),
				captureInbound: (adapter) => new Promise((resolve) => adapter.onMessage(resolve)),
				emitInbound: async () => undefined,
				assertBoundedMedia: async () => { await waitFor(() => oversizedDelivered); await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(getFileCalls, 0); },
				assertCredentialIsolation: () => {
					assert.ok(credentialUses.includes("primary:profile-env:channel:primary"));
					assert.ok(credentialUses.includes("secondary:profile-env:channel:secondary"));
				},
				cleanup: async () => undefined,
			};
		},
	};
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
function freePort() { return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject).listen(0, "127.0.0.1", () => { const address = server.address(); server.close((error) => error ? reject(error) : resolve(address.port)); }); }); }
async function waitFor(predicate) { for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error("Timed out waiting for adapter event"); }
function httpPost(port, path, body, headers = {}) { return new Promise((resolve, reject) => { const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode })); }); req.once("error", reject); req.end(body); }); }

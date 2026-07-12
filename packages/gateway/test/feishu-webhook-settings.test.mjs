import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { loadFeishuSettings, validateFeishuWebhookSettings } from "../dist/platforms/feishu/settings.js";
import { FeishuAdapter } from "../dist/index.js";

const base = {
	appId: "cli_test",
	appSecret: "secret",
	domain: "feishu",
	connectionMode: "webhook",
	webhookHost: "127.0.0.1",
	webhookPort: 8787,
	webhookPath: "/feishu/events",
	requireMention: true,
	allowedUsers: ["ou_allowed"],
	allowedChats: [],
	allowAllUsers: false,
};

test("webhook configuration requires encryption and a valid local listener", () => {
	assert.throws(() => validateFeishuWebhookSettings(base), /FEISHU_WEBHOOK_ENCRYPT_KEY/);
	assert.throws(() => validateFeishuWebhookSettings({ ...base, webhookEncryptKey: "key", webhookPort: 0 }), /port/);
	assert.throws(() => validateFeishuWebhookSettings({ ...base, webhookEncryptKey: "key", webhookPath: "events" }), /path/);
	assert.doesNotThrow(() => validateFeishuWebhookSettings({ ...base, webhookEncryptKey: "key" }));
});

test("Feishu batch tuning defaults match Hermes and clamps environment overrides", () => {
	const defaults = loadFeishuSettings({ FEISHU_APP_ID: "app", FEISHU_APP_SECRET: "secret" });
	assert.deepEqual({
		textDelay: defaults.textBatchDelayMs,
		splitDelay: defaults.textBatchSplitDelayMs,
		maxMessages: defaults.textBatchMaxMessages,
		maxChars: defaults.textBatchMaxChars,
		mediaDelay: defaults.mediaBatchDelayMs,
		retryDelay: defaults.retryBaseDelayMs,
	}, { textDelay: 600, splitDelay: 2_000, maxMessages: 8, maxChars: 4_000, mediaDelay: 800, retryDelay: 1_000 });
	const tuned = loadFeishuSettings({
		FEISHU_APP_ID: "app", FEISHU_APP_SECRET: "secret",
		FEISHU_TEXT_BATCH_DELAY_MS: "12.9", FEISHU_TEXT_BATCH_MAX_MESSAGES: "0",
		FEISHU_TEXT_BATCH_MAX_CHARS: "999999", FEISHU_MEDIA_BATCH_DELAY_MS: "bad",
	});
	assert.equal(tuned.textBatchDelayMs, 12);
	assert.equal(tuned.textBatchMaxMessages, 1);
	assert.equal(tuned.textBatchMaxChars, 100_000);
	assert.equal(tuned.mediaBatchDelayMs, 800);
});

test("webhook listener rejects non-POST, query paths, and oversized bodies", async () => {
	const port = await freePort();
	const adapter = new FeishuAdapter({ ...base, webhookEncryptKey: "key", webhookPort: port, botOpenId: "ou_bot" });
	try {
		assert.equal(await adapter.connect(), true);
		assert.equal((await http(port, "GET", "/feishu/events")).status, 404);
		assert.equal((await http(port, "POST", "/feishu/events?x=1")).status, 404);
		assert.equal((await http(port, "POST", "/feishu/events", "x", { "content-length": "1048577" })).status, 413);
	} finally {
		await adapter.disconnect();
	}
});

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject).listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close((error) => error ? reject(error) : resolve(address.port));
		});
	});
}

function http(port, method, path, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
			res.resume();
			res.on("end", () => resolve({ status: res.statusCode }));
		});
		req.once("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

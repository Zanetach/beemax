import assert from "node:assert/strict";
import test from "node:test";
import { registerFeishuBot } from "../dist/feishu-onboarding.js";

test("QR onboarding performs init, begin, pending poll, and returns owner-scoped credentials", async () => {
	const requests = [];
	const responses = [
		{ supported_auth_methods: ["client_secret"] },
		{ device_code: "device", verification_uri_complete: "https://example.test/scan?code=user", interval: 1, expire_in: 60 },
		{ error: "authorization_pending" },
		{ client_id: "cli_created", client_secret: "created-secret", user_info: { open_id: "ou_owner", tenant_brand: "feishu" } },
	];
	let now = 0;
	let qrUrl;
	const result = await registerFeishuBot({
		fetch: async (url, init) => { requests.push([url, Object.fromEntries(init.body)]); return new Response(JSON.stringify(responses.shift()), { status: 200 }); },
		now: () => now,
		sleep: async (ms) => { now += ms; },
		showQr: (url) => { qrUrl = url; },
	});
	assert.deepEqual(result, { appId: "cli_created", appSecret: "created-secret", domain: "feishu", openId: "ou_owner" });
	assert.match(qrUrl, /from=thruvera&tp=thruvera/);
	assert.deepEqual(requests.map(([, body]) => body.action), ["init", "begin", "poll", "poll"]);
	assert.equal(requests[1][1].archetype, "PersonalAgent");
	assert.equal(requests[1][1].request_user_info, "open_id");
});

test("QR onboarding switches to Lark and fails closed on denial", async () => {
	const queue = [
		{ supported_auth_methods: ["client_secret"] }, { device_code: "d", verification_uri_complete: "https://scan", interval: 1, expire_in: 60 },
		{ client_id: "cli_lark", client_secret: "secret", user_info: { tenant_brand: "lark", open_id: "ou_lark" } },
	];
	assert.equal((await registerFeishuBot({ fetch: async () => new Response(JSON.stringify(queue.shift())), now: () => 0, sleep: async () => undefined, showQr: () => undefined }))?.domain, "lark");
	const denied = [{ supported_auth_methods: ["client_secret"] }, { device_code: "d", verification_uri_complete: "https://scan" }, { error: "access_denied" }];
	assert.equal(await registerFeishuBot({ fetch: async () => new Response(JSON.stringify(denied.shift())), now: () => 0, sleep: async () => undefined, showQr: () => undefined }), undefined);
});

test("QR onboarding rejects non-retryable HTTP failures and backs off after rate limiting", async () => {
	let calls = 0;
	await assert.rejects(() => registerFeishuBot({
		fetch: async () => { calls++; return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }); },
		showQr: () => undefined,
	}), /HTTP 401/);
	assert.equal(calls, 1);
	const queue = [
		new Response(JSON.stringify({ supported_auth_methods: ["client_secret"] })),
		new Response(JSON.stringify({ device_code: "d", verification_uri_complete: "https://scan", interval: 1, expire_in: 60 })),
		new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "7" } }),
		new Response(JSON.stringify({ client_id: "cli", client_secret: "secret", user_info: { open_id: "ou" } })),
	];
	let now = 0;
	const waits = [];
	assert.equal((await registerFeishuBot({
		fetch: async () => queue.shift(), now: () => now,
		sleep: async (ms) => { waits.push(ms); now += ms; }, showQr: () => undefined, log: () => undefined,
	}))?.appId, "cli");
	assert.ok(waits[0] >= 7_000);
});

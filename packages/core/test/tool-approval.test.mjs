import test from "node:test";
import assert from "node:assert/strict";
import { ToolApprovalBroker } from "../dist/index.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("Core approval broker owns one-time and session grants", async () => {
	const prompts = [];
	const broker = new ToolApprovalBroker(async (_source, text) => { prompts.push(text); }, 1_000);
	try {
		const once = broker.authorize({ source, toolName: "write", args: { path: "a.txt", token: "hidden" } });
		assert.match(prompts[0], /\[REDACTED\]/);
		assert.match(prompts[0], /目标：a.txt/);
		assert.match(prompts[0], /风险：高/);
		assert.match(prompts[0], /可逆性：/);
		assert.equal(await broker.handleReply(source, "1"), true);
		assert.deepEqual(await once, { allowed: true });

		const granted = broker.authorize({ source, toolName: "write", args: {} });
		assert.equal(await broker.handleReply(source, "2"), true);
		assert.deepEqual(await granted, { allowed: true });
		assert.deepEqual(await broker.authorize({ source, toolName: "write", args: {} }), { allowed: true });
	} finally {
		broker.dispose();
	}
});

test("approval lifecycle exposes only redacted presenter-safe card details", async () => {
	const events = [];
	const broker = new ToolApprovalBroker(async () => {}, 1_000);
	broker.subscribe((event) => events.push(event));
	const waiting = broker.authorize({ source, toolName: "browser_fill", args: { url: "https://alice:pw@example.com/?token=secret-value", selector: "#email", password: "secret-value" } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(events[0].type, "requested");
	assert.equal(events[0].details.risk, "高");
	assert.doesNotMatch(events[0].details.target, /secret-value|alice|:pw@/);
	assert.match(events[0].details.argsSummary, /\[REDACTED\]/);
	assert.doesNotMatch(events[0].details.argsSummary, /secret-value/);
	await broker.handleReply(source, "3");
	assert.deepEqual(await waiting, { allowed: false, reason: "User denied the tool call" });
});

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

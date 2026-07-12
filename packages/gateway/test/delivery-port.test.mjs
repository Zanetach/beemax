import assert from "node:assert/strict";
import test from "node:test";
import { GatewayDeliveryPort } from "../dist/index.js";

const target = { platform: "feishu", chatId: "chat" };

test("Gateway delivery forwards complete artifacts to generic media transport", async () => {
	let received;
	const port = new GatewayDeliveryPort({
		name: "feishu",
		sendMedia: async (...args) => { received = args; return { success: true }; },
	});
	await port.sendMedia(target, { path: "/tmp/report.pdf", mimeType: "application/pdf", name: "Report.pdf" });
	assert.deepEqual(received, ["chat", "/tmp/report.pdf", "application/pdf", "Report.pdf"]);
});

test("Gateway delivery uses legacy image transport only for image artifacts", async () => {
	const calls = [];
	const port = new GatewayDeliveryPort({
		name: "feishu",
		sendImage: async (...args) => { calls.push(args); return { success: true }; },
	});
	await port.sendMedia(target, { path: "/tmp/generated.png" });
	assert.deepEqual(calls, [["chat", "/tmp/generated.png"]]);
	await assert.rejects(port.sendMedia(target, { path: "/tmp/report.pdf", mimeType: "application/pdf" }), /does not support media delivery/);
});

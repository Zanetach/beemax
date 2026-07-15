import assert from "node:assert/strict";
import test from "node:test";
import { GatewayDeliveryPort } from "../dist/index.js";

const target = { platform: "feishu", chatId: "chat" };

test("Gateway delivery forwards complete artifacts to generic media transport", async () => {
	let received;
	const port = new GatewayDeliveryPort({
		name: "feishu",
		capabilities: { mediaDelivery: "files", messageEditing: false, interactiveActions: false, richPresentation: false },
		sendMedia: async (...args) => { received = args; return { success: true }; },
	});
	await port.sendMedia(target, { path: "/tmp/report.pdf", mimeType: "application/pdf", name: "Report.pdf" });
	assert.deepEqual(received, ["chat", "/tmp/report.pdf", "application/pdf", "Report.pdf"]);
});

test("Gateway delivery honors the declared image-only capability", async () => {
	const calls = [];
	const port = new GatewayDeliveryPort({
		name: "feishu",
		capabilities: { mediaDelivery: "images", messageEditing: false, interactiveActions: false, richPresentation: false },
		sendImage: async (...args) => { calls.push(args); return { success: true }; },
	});
	await port.sendMedia(target, { path: "/tmp/generated.png" });
	assert.deepEqual(calls, [["chat", "/tmp/generated.png"]]);
	await assert.rejects(port.sendMedia(target, { path: "/tmp/report.pdf", mimeType: "application/pdf" }), /does not support media delivery/);
});

test("Gateway delivery routes through the requested channel instance", async () => {
	let resolved, sent;
	const port = new GatewayDeliveryPort({
		resolveAdapter(platform, channelInstanceId) {
			resolved = { platform, channelInstanceId };
			return {
				name: platform,
				async send(...args) { sent = args; return { success: true, messageId: "reply-1" }; },
			};
		},
	});
	const receipt = await port.sendText({ platform: "feishu", channelInstanceId: "company-a", chatId: "group-1", chatType: "thread", threadId: "thread-1", replyToMessageId: "origin-1" }, "hello", { idempotencyKey: "completion-1" });
	assert.deepEqual(resolved, { platform: "feishu", channelInstanceId: "company-a" });
	assert.deepEqual(sent, ["group-1", "hello", { idempotencyKey: "completion-1", replyTo: "origin-1", replyInThread: true }]);
	assert.deepEqual(receipt, { idempotencyKey: "completion-1", deliveredAt: receipt.deliveredAt, providerMessageId: "reply-1" });
});

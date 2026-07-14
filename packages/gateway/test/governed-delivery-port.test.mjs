import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryDeferredError, GovernedDeliveryPort, GroupResponseGovernor } from "../dist/index.js";

test("Governed Delivery defers proactive group output but never misclassifies DM or interactive replies", async () => {
	const delivered = [];
	const transport = {
		sendText: async (target, text) => { delivered.push({ target, text }); },
		sendMedia: async () => {},
	};
	const governor = new GroupResponseGovernor({ quietHours: { start: "22:00", end: "07:00", timezone: "UTC" }, now: () => Date.parse("2026-07-14T23:00:00Z") });
	const delivery = new GovernedDeliveryPort(transport, { resolve: (target) => target.platform === "feishu" ? governor : undefined });
	const group = { platform: "feishu", channelInstanceId: "company", chatId: "group", chatType: "group" };
	await assert.rejects(() => delivery.sendText(group, "proactive result", { deliveryClass: "proactive" }), (error) => {
		assert.ok(error instanceof DeliveryDeferredError);
		assert.equal(error.reason, "quiet_hours");
		assert.ok(error.retryAt > Date.parse("2026-07-14T23:00:00Z"));
		return true;
	});
	await delivery.sendText({ ...group, chatType: "dm" }, "private reminder", { deliveryClass: "proactive" });
	await delivery.sendText(group, "requested reply", { deliveryClass: "interactive" });
	assert.deepEqual(delivered.map((item) => item.text), ["private reminder", "requested reply"]);
});

test("Governed Delivery fails closed on legacy proactive targets and releases budget after transport failure", async () => {
	let sends = 0;
	const events = [];
	const governor = new GroupResponseGovernor({ maxRepliesPerWindow: 1, replyWindowMs: 60_000, now: () => 1_000 });
	const delivery = new GovernedDeliveryPort({
		sendText: async () => { sends++; if (sends === 1) throw new Error("offline"); },
		sendMedia: async () => undefined,
	}, { resolve: () => governor, onSettled: (event) => events.push(event) });
	await assert.rejects(() => delivery.sendText({ platform:"feishu",chatId:"legacy" }, "result", { deliveryClass:"proactive" }), (error) => error instanceof DeliveryDeferredError && error.reason === "unknown_conversation_type");
	const target = { platform:"feishu",channelInstanceId:"main",chatId:"group",chatType:"group" };
	await assert.rejects(() => delivery.sendText(target, "first", { deliveryClass:"proactive" }), /offline/);
	await delivery.sendText(target, "retry", { deliveryClass:"proactive" });
	assert.deepEqual(events.map(({ status, reason }) => ({ status, reason })), [
		{ status:"deferred", reason:"unknown_conversation_type" },
		{ status:"failed", reason:undefined },
		{ status:"delivered", reason:undefined },
	]);
});

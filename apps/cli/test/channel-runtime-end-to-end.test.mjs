import assert from "node:assert/strict";
import test from "node:test";
import { AdapterRegistry, ChannelHost } from "@beemax/channel-runtime";
import { Dispatcher, GatewayDeliveryPort, GatewayIngressController, ProfileBindingResolver } from "@beemax/gateway";

test("Channel Runtime routes normalized inbound turns and outbound delivery through the concrete Channel Instance", async () => {
	const created = new Map();
	const registry = new AdapterRegistry().register({
		id: "test-channel",
		create: (instance) => {
			const adapter = new TestAdapter("chat", instance.id);
			created.set(instance.id, adapter);
			return adapter;
		},
	});
	const host = new ChannelHost(registry, [
		{ id: "company-a", adapter: "test-channel", enabled: true, settings: { account: "a" } },
		{ id: "company-b", adapter: "test-channel", enabled: true, settings: { account: "b" } },
	], { connectAttempts: 1, supervisionIntervalMs: 60_000 });
	const seen = [];
	let cancellations = 0;
	let cleaned = 0;
	let releaseHeldTurn;
	const ingress = new GatewayIngressController({ maxActive: 1, maxActivePerConversation: 1 });
	const bindingResolver = new ProfileBindingResolver([{ id: "operations-a", profileId: "operations", channelInstanceId: "company-a", conversationId: "conversation" }]);
	const dispatchers = host.adapterEntries().map(({ id, adapter }) => new Dispatcher({
		channelInstanceId: id,
		profileId: "operations",
		...(id === "company-a" ? { bindingResolver, ingress } : {}),
		runtime: {
			run: async ({ source, text }) => {
				seen.push({ source, text });
				if (text === "hold") await new Promise((resolve) => { releaseHeldTurn = resolve; });
				return { answer: `handled:${id}:${text}`, model: "test", durationMs: 1, usage: {} };
			},
			cancel: async (source) => { cancellations++; seen.push({ source, text: "/stop" }); return true; },
			handleControl: async () => undefined,
			isBusy: () => false,
			dispose: () => undefined,
		},
	}, adapter));

	try {
		await host.start();
		const companyA = created.get("company-a");
		const companyB = created.get("company-b");
		await companyA.emit({ text: "inspect", messageType: "text", source: source("in-1"), mediaPaths: [], mediaTypes: [], releaseMedia: async () => { cleaned++; }, raw: { native: true }, timestamp: 1 });
		await waitFor(() => companyA.sent.some(({ text }) => text === "handled:company-a:inspect"));

		assert.equal(seen[0].source.channelInstanceId, "company-a");
		assert.equal(seen[0].source.platform, "chat");
		assert.equal(companyB.sent.length, 0);
		assert.equal(cleaned, 1);

		await companyA.emit({ text: "blocked", messageType: "text", source: { ...source("blocked-1"), chatId: "unbound" }, mediaPaths: [], mediaTypes: [], releaseMedia: async () => { cleaned++; }, raw: {}, timestamp: 2 });
		assert.equal(seen.some(({ text }) => text === "blocked"), false);
		assert.equal(cleaned, 2);

		await companyA.emit({ text: "hold", messageType: "text", source: source("hold-1"), mediaPaths: [], mediaTypes: [], raw: {}, timestamp: 3 });
		await waitFor(() => seen.some(({ text }) => text === "hold"));
		await companyA.emit({ text: "overflow", messageType: "text", source: source("overflow-1"), mediaPaths: [], mediaTypes: [], releaseMedia: async () => { cleaned++; }, raw: {}, timestamp: 4 });
		assert.equal(seen.some(({ text }) => text === "overflow"), false);
		assert.equal(companyA.sent.some(({ text }) => /容量已满/.test(text)), true);
		assert.equal(cleaned, 3);
		releaseHeldTurn();
		await waitFor(() => companyA.sent.some(({ text }) => text === "handled:company-a:hold"));

		const delivery = new GatewayDeliveryPort(host);
		await delivery.sendText({ platform: "chat", channelInstanceId: "company-b", chatId: "target", chatType: "dm" }, "scheduled result", { idempotencyKey: "delivery-1" });
		assert.deepEqual(companyB.sent.at(-1), { chatId: "target", text: "scheduled result", idempotencyKey: "delivery-1" });
		assert.equal(companyA.sent.some(({ text }) => text === "scheduled result"), false);

		await companyA.emit({ text: "/stop", messageType: "command", source: source("stop-1"), mediaPaths: [], mediaTypes: [], raw: {}, timestamp: 5 });
		await waitFor(() => cancellations === 1);
		assert.equal(seen.at(-1).source.channelInstanceId, "company-a");
	} finally {
		await Promise.all(dispatchers.map((dispatcher) => dispatcher.dispose()));
		await host.stop();
	}
});

class TestAdapter {
	name;
	instanceId;
	capabilities = { mediaDelivery: "none", messageEditing: true, interactiveActions: false, richPresentation: false };
	connected = false;
	handler;
	sent = [];

	constructor(name, instanceId) { this.name = name; this.instanceId = instanceId; }
	get isConnected() { return this.connected; }
	async connect() { this.connected = true; return true; }
	async disconnect() { this.connected = false; }
	onMessage(handler) { this.handler = handler; }
	async emit(message) { if (!this.handler) throw new Error("No inbound handler"); await this.handler(message); }
	async send(chatId, text, options) { this.sent.push({ chatId, text, idempotencyKey: options?.idempotencyKey }); return { success: true, messageId: `${this.instanceId}:${this.sent.length}` }; }
	async editMessage() { return { success: true }; }
	async sendTyping() {}
	async stopTyping() {}
}

function source(messageId) {
	return { platform: "chat", chatId: "conversation", chatType: "dm", userId: "user", messageId };
}

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("Timed out waiting for Channel Runtime end-to-end outcome");
}

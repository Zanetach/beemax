import test from "node:test";
import assert from "node:assert/strict";
import { InteractionControlServer } from "../dist/index.js";
import { InteractionEventAdapter, InteractionProtocol } from "@thruvera/core";

const source = { platform: "web", chatId: "remote-1", chatType: "dm", userId: "user-1" };
const scope = { profileId: "personal", platform: "web", chatId: "remote-1", userId: "user-1" };

test("loopback control server authenticates before dispatching versioned interaction actions", async () => {
	let runs = 0;
	const runtime = {
		async run() { runs++; return { answer: "ok", model: "test/model", durationMs: 1, usage: {} }; },
		async open() { return true; }, reset() { return false; }, async compact() { return false; }, async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const protocol = new InteractionProtocol({ adapter: new InteractionEventAdapter(runtime, { profileId: "personal" }), resolveSource: () => source });
	const server = new InteractionControlServer({ protocol, authenticate: (request) => request.headers.authorization === "Bearer local-token" ? scope : undefined });
	const address = await server.listen();
	try {
		const url = `http://${address.host}:${address.port}/v1/interaction`;
		const denied = await fetch(url, { method: "POST", body: "{}" });
		assert.equal(denied.status, 401);
		const response = await fetch(url, {
			method: "POST",
			headers: { authorization: "Bearer local-token", "content-type": "application/json" },
			body: JSON.stringify({ version: 1, id: "send", type: "action", scope, action: { type: "message.send", text: "hi", input: { timeoutMs: 1_000 }, actionId: "one" } }),
		});
		assert.equal(response.status, 200);
		assert.equal((await response.json()).ok, true);
		assert.equal(runs, 1);
	} finally { await server.close(); }
});

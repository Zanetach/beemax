import test from "node:test";
import assert from "node:assert/strict";
import { InteractionEventAdapter, InteractionProtocol, parseInteractionProtocolRequest } from "../dist/index.js";

const source = { platform: "web", chatId: "remote-1", chatType: "dm", userId: "user-1" };
const scope = { profileId: "personal", platform: "web", chatId: "remote-1", userId: "user-1" };

test("versioned interaction protocol rejects scope substitution and delegates valid actions", async () => {
	let runs = 0;
	const runtime = {
		async run() { runs++; return { answer: "ok", model: "test/model", durationMs: 1, usage: {} }; },
		async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
	};
	const protocol = new InteractionProtocol({ adapter: new InteractionEventAdapter(runtime, { profileId: "personal" }), resolveSource: () => source });
	const denied = await protocol.handle({ version: 1, id: "bad", type: "snapshot", scope: { ...scope, userId: "other" } }, scope);
	assert.deepEqual(denied, { version: 1, id: "bad", ok: false, error: "unauthorized_scope", message: "Request scope does not match the authenticated scope" });
	const action = { version: 1, id: "send", type: "action", scope, action: { type: "message.send", text: "hi", input: { timeoutMs: 1_000 }, actionId: "remote-retry" } };
	assert.equal((await protocol.handle(action, scope)).ok, true);
	assert.equal((await protocol.handle(action, scope)).ok, true);
	assert.equal(runs, 1);
	const events = await protocol.handle({ version: 1, id: "events", type: "events", scope, afterSequence: 0 }, scope);
	assert.equal(events.ok, true);
	assert.equal(events.type, "events");
	assert.deepEqual(events.events.map((event) => event.type), ["turn.started", "turn.finished"]);
});

test("protocol parser rejects malformed JSON transport input before authorization", () => {
	assert.equal(parseInteractionProtocolRequest({ version: 1, id: "x", type: "action", scope, action: { type: "approval.decide", choice: "anything" } }), undefined);
	assert.equal(parseInteractionProtocolRequest({ version: 1, id: "x", type: "events", scope, afterSequence: -1.5 }), undefined);
	assert.deepEqual(parseInteractionProtocolRequest({ version: 1, id: "x", type: "snapshot", scope }), { version: 1, id: "x", type: "snapshot", scope });
});

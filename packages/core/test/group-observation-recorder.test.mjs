import assert from "node:assert/strict";
import test from "node:test";
import { GroupObservationRecorder } from "../dist/index.js";

test("Group Observation Recorder retains only a cognition-approved bounded candidate without execution authority", async () => {
	const writes = [];
	const store = {
		upsertInitiativeObservation: (input) => { writes.push(input); return { observation: { id: "observation-1", ...input }, created: true }; },
		upsertBoundedAmbientGroupObservation: (input, retain) => {
			assert.equal(retain, 2);
			return store.upsertInitiativeObservation(input);
		},
	};
	const recorder = new GroupObservationRecorder({
		profileId: "operations", store, retainPerLane: 2,
		evaluator: { evaluate: async () => ({ disposition: "retain", relevance: 0.9, credibility: 0.7, expectedValue: 0.8, confidence: 0.85, rationale: "It may change active work", action: "Review the reported change", intendedVerification: "Confirm the change from an authoritative source" }) },
	});
	const result = await recorder.record({
		text: "A potentially useful reported fact",
		source: { platform: "feishu", channelInstanceId: "company-a", chatId: "group", chatType: "group", threadId: "topic", messageId: "message-1" },
		timestamp: 1_000,
	});
	assert.equal(result.kind, "retained");
	assert.equal(result.created, true);
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0].scope, { profileId: "operations", platform: "feishu", channelInstanceId: "company-a", chatId: "group", threadId: "topic" });
	assert.equal(writes[0].mode, "observe_only");
	assert.equal(writes[0].notificationEmitted, false);
	assert.equal(writes[0].action, "Review the reported change");
	assert.equal(writes[0].expectedValue, 0.8);
	assert.equal(writes[0].situation.observations[0].confidence, 0.7);
	assert.match(writes[0].triggerId, /^ambient-group:message:/);
	assert.equal(writes[0].situation.observations[0].statement, "A potentially useful reported fact");
});

test("Group Observation Recorder ignores low-value ambient chat without writing Memory", async () => {
	let writes = 0;
	const recorder = new GroupObservationRecorder({
		profileId: "operations",
		store: { upsertBoundedAmbientGroupObservation: () => { writes++; throw new Error("must not write"); } },
		evaluator: { evaluate: async () => ({ disposition: "ignore", relevance: 0.1, credibility: 0.5, expectedValue: 0.1, confidence: 0.9, rationale: "Ordinary social chatter" }) },
	});
	const result = await recorder.record({ text: "hello everyone", source: { platform: "feishu", chatId: "group", chatType: "group", messageId: "message-2" }, timestamp: 2_000 });
	assert.deepEqual(result, { kind: "ignored", rationale: "Ordinary social chatter" });
	assert.equal(writes, 0);
});

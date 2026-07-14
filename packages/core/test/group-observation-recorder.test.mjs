import assert from "node:assert/strict";
import test from "node:test";
import { GroupObservationRecorder } from "../dist/index.js";

test("Group Observation Recorder stores bounded observe-only candidates without execution or notification authority", () => {
	const writes = [];
	const store = {
		upsertInitiativeObservation: (input) => { writes.push(input); return { observation: { id: "observation-1", ...input }, created: true }; },
		upsertBoundedAmbientGroupObservation: (input, retain) => {
			assert.equal(retain, 2);
			return store.upsertInitiativeObservation(input);
		},
	};
	const recorder = new GroupObservationRecorder({ profileId: "operations", store, retainPerLane: 2 });
	const result = recorder.record({
		text: "A potentially useful reported fact",
		source: { platform: "feishu", channelInstanceId: "company-a", chatId: "group", chatType: "group", threadId: "topic", messageId: "message-1" },
		timestamp: 1_000,
	});
	assert.equal(result.created, true);
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0].scope, { profileId: "operations", platform: "feishu", channelInstanceId: "company-a", chatId: "group", threadId: "topic" });
	assert.equal(writes[0].mode, "observe_only");
	assert.equal(writes[0].notificationEmitted, false);
	assert.match(writes[0].triggerId, /^ambient-group:message:/);
	assert.equal(writes[0].situation.observations[0].statement, "A potentially useful reported fact");
});

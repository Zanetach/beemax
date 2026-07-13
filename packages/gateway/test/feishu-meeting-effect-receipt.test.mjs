import assert from "node:assert/strict";
import test from "node:test";
import { createFeishuMeetingTools } from "@beemax/feishu-capability";

test("Feishu reservation creation returns a provider proof and stable idempotency receipt", async () => {
	const client = { vc: { v1: { reserve: { apply: async () => ({ code: 0, data: { reserve: { id: "reserve-42" } } }) } } } };
	const tool = createFeishuMeetingTools(() => client).find((candidate) => candidate.name === "feishu_meeting_reserve_create");
	const result = await tool.execute("call-1", { topic: "Weekly review", endTime: "1800000000", idempotencyKey: "weekly-review-2026-07-13" });
	assert.deepEqual(result.details.beemaxEffect, {
		operation: "create meeting reservation",
		externalRef: "feishu-vc:meeting-reservation:reserve-42",
		idempotencyKey: "weekly-review-2026-07-13",
		proof: { provider: "feishu-vc", resourceType: "meeting-reservation", resourceId: "reserve-42" },
	});
});

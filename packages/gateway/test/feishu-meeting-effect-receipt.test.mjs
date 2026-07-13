import assert from "node:assert/strict";
import test from "node:test";
import { createFeishuMeetingTools } from "@beemax/feishu-capability";
import { FileToolEffectJournal } from "@beemax/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Feishu reservation creation produces a trusted provider receipt with a local replay key", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-feishu-receipt-"));
	try {
	const client = { vc: { v1: { reserve: { apply: async () => ({ code: 0, data: { reserve: { id: "reserve-42" } } }) } } } };
	const tool = createFeishuMeetingTools(() => client).find((candidate) => candidate.name === "feishu_meeting_reserve_create");
	const args = { topic: "Weekly review", endTime: "1800000000", idempotencyKey: "weekly-review-2026-07-13" };
	const result = await tool.execute("call-1", args);
	assert.deepEqual(result.details.beemaxEffect, {
		operation: "create meeting reservation",
		externalRef: "feishu-vc:meeting-reservation:reserve-42",
		idempotencyKey: "weekly-review-2026-07-13",
		proof: { provider: "feishu-vc", resourceType: "meeting-reservation", resourceId: "reserve-42" },
	});
	const effects = new FileToolEffectJournal(join(root, "tool-effects.jsonl"));
	const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };
	effects.begin({ source, taskId: "turn-1", toolCallId: "call-1", toolName: tool.name, args, policy: tool.beemaxPolicy });
	effects.finish({ source, toolCallId: "call-1", toolName: tool.name, policy: tool.beemaxPolicy, isError: false, details: result.details });
	assert.equal(effects.events().at(-1).status, "committed");
	assert.equal(effects.events().at(-1).receipt.proof.provider, "feishu-vc");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Feishu success without a stable reservation id does not produce a provider proof", async () => {
	const client = { vc: { v1: { reserve: { apply: async () => ({ code: 0, data: { reserve: {} } }) } } } };
	const tool = createFeishuMeetingTools(() => client).find((candidate) => candidate.name === "feishu_meeting_reserve_create");
	const result = await tool.execute("call-1", { topic: "Weekly review", endTime: "1800000000" });
	assert.equal(result.details.beemaxEffect, undefined);
});

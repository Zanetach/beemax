import assert from "node:assert/strict";
import test from "node:test";
import { createFeishuMeetingTools } from "@beemax/feishu-capability";
import { FileToolEffectJournal } from "@beemax/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };

function persistResult(root, tool, args, result, toolCallId) {
	const effects = new FileToolEffectJournal(join(root, `${toolCallId}.jsonl`));
	effects.begin({ source, taskId: "turn-1", toolCallId, toolName: tool.name, args, policy: tool.beemaxPolicy });
	effects.finish({ source, toolCallId, toolName: tool.name, policy: tool.beemaxPolicy, isError: Boolean(result.isError), details: result.details });
	return effects.events().at(-1);
}

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

test("Feishu reservation update returns a trusted receipt for the requested reservation", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-feishu-update-receipt-"));
	try {
	const client = { vc: { v1: { reserve: { update: async () => ({ code: 0, data: {} }) } } } };
	const tool = createFeishuMeetingTools(() => client).find((candidate) => candidate.name === "feishu_meeting_reserve_update");
	const result = await tool.execute("call-1", { reserveId: "reserve-42", topic: "Updated review", idempotencyKey: "update-reserve-42-v2" });
	assert.deepEqual(result.details.beemaxEffect, {
		operation: "update meeting reservation",
		externalRef: "feishu-vc:meeting-reservation:reserve-42",
		idempotencyKey: "update-reserve-42-v2",
		proof: { provider: "feishu-vc", resourceType: "meeting-reservation", resourceId: "reserve-42" },
	});
	assert.equal(persistResult(root, tool, { reserveId: "reserve-42", topic: "Updated review", idempotencyKey: "update-reserve-42-v2" }, result, "update-1").status, "committed");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Feishu reservation deletion returns a trusted irreversible receipt", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-feishu-delete-receipt-"));
	try {
	const client = { vc: { v1: { reserve: { delete: async () => ({ code: 0 }) } } } };
	const tool = createFeishuMeetingTools(() => client).find((candidate) => candidate.name === "feishu_meeting_reserve_delete");
	const result = await tool.execute("call-1", { reserveId: "reserve-42", idempotencyKey: "delete-reserve-42" });
	assert.deepEqual(result.details.beemaxEffect, {
		operation: "delete meeting reservation",
		externalRef: "feishu-vc:meeting-reservation:reserve-42",
		idempotencyKey: "delete-reserve-42",
		proof: { provider: "feishu-vc", resourceType: "meeting-reservation", resourceId: "reserve-42" },
	});
	assert.equal(persistResult(root, tool, { reserveId: "reserve-42", idempotencyKey: "delete-reserve-42" }, result, "delete-1").status, "committed");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Feishu provider errors stay unknown and are not masked by proof construction", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-feishu-error-receipt-"));
	try {
		const client = { vc: { v1: { reserve: { update: async () => ({ code: 999, msg: "reservation rejected" }) } } } };
		const tool = createFeishuMeetingTools(() => client).find((candidate) => candidate.name === "feishu_meeting_reserve_update");
		const args = { reserveId: `token=${"x".repeat(600)}`, topic: "Rejected" };
		const result = await tool.execute("call-1", args);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /code=999.*reservation rejected/);
		assert.equal(result.details.beemaxEffect, undefined);
		assert.equal(persistResult(root, tool, args, result, "failed-update").status, "unknown");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Feishu active meeting mutations return operation-specific trusted receipts", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-feishu-active-meeting-receipts-"));
	try {
	const client = { vc: { v1: { meeting: {
		end: async () => ({ code: 0 }),
		invite: async () => ({ code: 0, data: {} }),
		kickout: async () => ({ code: 0, data: {} }),
		setHost: async () => ({ code: 0, data: {} }),
	} } } };
	const tools = createFeishuMeetingTools(() => client);
	const cases = [
		["feishu_meeting_end", { meetingId: "meeting-42", idempotencyKey: "end-42" }, "end meeting", "end-42"],
		["feishu_meeting_invite", { meetingId: "meeting-42", userIds: ["user-1"], idempotencyKey: "invite-42-user-1" }, "invite meeting participants", "invite-42-user-1"],
		["feishu_meeting_kickout", { meetingId: "meeting-42", userIds: ["user-1"], idempotencyKey: "kickout-42-user-1" }, "remove meeting participants", "kickout-42-user-1"],
		["feishu_meeting_set_host", { meetingId: "meeting-42", hostId: "user-2", oldHostId: "user-1", idempotencyKey: "host-42-user-2" }, "set meeting host", "host-42-user-2"],
	];
	for (const [name, args, operation, idempotencyKey] of cases) {
		const tool = tools.find((candidate) => candidate.name === name);
		const result = await tool.execute(`call-${name}`, args);
		assert.deepEqual(result.details.beemaxEffect, {
			operation,
			externalRef: "feishu-vc:meeting:meeting-42",
			idempotencyKey,
			proof: { provider: "feishu-vc", resourceType: "meeting", resourceId: "meeting-42" },
		});
		assert.equal(persistResult(root, tool, args, result, `effect-${name}`).status, "committed");
	}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

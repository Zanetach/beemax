import assert from "node:assert/strict";
import test from "node:test";
import { createFeishuMeetingTools } from "@thruvera/feishu-capability";
import { FileToolEffectJournal } from "@thruvera/core";
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

test("Feishu meeting end commits while participant and host mutations await reconciliation", async () => {
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
		["feishu_meeting_end", { meetingId: "meeting-42", idempotencyKey: "opaque-end-key" }, true],
		["feishu_meeting_invite", { meetingId: "meeting-42", userIds: ["user-1"] }, false],
		["feishu_meeting_kickout", { meetingId: "meeting-42", userIds: ["user-1"] }, false],
		["feishu_meeting_set_host", { meetingId: "meeting-42", hostId: "user-2", oldHostId: "user-1" }, false],
	];
	for (const [name, args, hasProof] of cases) {
		const tool = tools.find((candidate) => candidate.name === name);
		const result = await tool.execute(`call-${name}`, args);
		assert.equal(Boolean(result.details.beemaxEffect), hasProof);
		assert.equal(persistResult(root, tool, args, result, `effect-${name}`).status, hasProof ? "committed" : "unknown");
	}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Feishu participant and host mutations commit only after exact provider reconciliation", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-feishu-meeting-reconciliation-"));
	try {
		const client = { vc: { v1: { meeting: {
			invite: async () => ({ code: 0, data: { invite_results: [{ id: "user-2", user_type: 1, status: 0 }, { id: "user-1", user_type: 1, status: 0 }] } }),
			kickout: async () => ({ code: 0, data: { kickout_results: [{ id: "user-1", user_type: 1, result: 0 }] } }),
			setHost: async () => ({ code: 0, data: { host_user: { id: "user-2", user_type: 1 } } }),
		} } } };
		const tools = createFeishuMeetingTools(() => client);
		const cases = [
			["feishu_meeting_invite", { meetingId: "meeting-42", userIds: ["user-1", "user-2"] }],
			["feishu_meeting_kickout", { meetingId: "meeting-42", userIds: ["user-1"] }],
			["feishu_meeting_set_host", { meetingId: "meeting-42", hostId: "user-2", oldHostId: "user-1" }],
		];
		for (const [name, args] of cases) {
			const tool = tools.find((candidate) => candidate.name === name);
			const result = await tool.execute(`call-${name}`, args);
			assert.equal(persistResult(root, tool, args, result, `effect-${name}`).status, "committed");
			assert.equal(result.details.beemaxEffect.proof.provider, "feishu-vc");
			assert.equal(result.details.beemaxEffect.proof.resourceType, "meeting-mutation");
			assert.match(result.details.beemaxEffect.proof.resourceId, /^meeting-42:[a-f0-9]{64}$/);
			assert.equal(JSON.stringify(result.details.beemaxEffect).includes("user-"), false);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Feishu participant reconciliation rejects partial, extra, mismatched, wrong-type, and failed results", async () => {
	const responses = [
		[{ id: "user-1", user_type: 1, status: 0 }],
		[{ id: "user-1", user_type: 1, status: 0 }, { id: "user-2", user_type: 1, status: 0 }, { id: "user-3", user_type: 1, status: 0 }],
		[{ id: "user-1", user_type: 1, status: 0 }, { id: "wrong-user", user_type: 1, status: 0 }],
		[{ id: "user-1", user_type: 2, status: 0 }, { id: "user-2", user_type: 1, status: 0 }],
		[{ id: "user-1", user_type: 1, status: 0 }, { id: "user-2", user_type: 1, status: 1 }],
	];
	for (const [index, inviteResults] of responses.entries()) {
		const root = mkdtempSync(join(tmpdir(), `beemax-feishu-reconciliation-negative-${index}-`));
		try {
			const client = { vc: { v1: { meeting: { invite: async () => ({ code: 0, data: { invite_results: inviteResults } }) } } } };
			const tool = createFeishuMeetingTools(() => client).find((candidate) => candidate.name === "feishu_meeting_invite");
			const args = { meetingId: "meeting-42", userIds: ["user-1", "user-2"] };
			const result = await tool.execute(`call-${index}`, args);
			assert.equal(result.details.beemaxEffect, undefined);
			assert.equal(persistResult(root, tool, args, result, `effect-${index}`).status, "unknown");
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});

test("Feishu recording mutations commit provider receipts bound to privacy-safe intent digests", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-feishu-recording-receipts-"));
	try {
		const client = { vc: { v1: { meetingRecording: {
			start: async () => ({ code: 0, data: {} }),
			stop: async () => ({ code: 0, data: {} }),
			setPermission: async () => ({ code: 0, data: {} }),
		} } } };
		const tools = createFeishuMeetingTools(() => client);
		const cases = [
			["feishu_meeting_recording_start", { meetingId: "meeting-42" }],
			["feishu_meeting_recording_stop", { meetingId: "meeting-42" }],
			["feishu_meeting_recording_set_permission", { meetingId: "meeting-42", actionType: 1, objects: [{ id: "user-secret", type: 1, permission: 2 }] }],
		];
		const resourceIds = [];
		for (const [name, args] of cases) {
			const tool = tools.find((candidate) => candidate.name === name);
			const result = await tool.execute(`call-${name}`, args);
			assert.equal(persistResult(root, tool, args, result, `effect-${name}`).status, "committed");
			assert.equal(result.details.beemaxEffect.proof.provider, "feishu-vc");
			assert.equal(result.details.beemaxEffect.proof.resourceType, "meeting-recording-mutation");
			assert.match(result.details.beemaxEffect.proof.resourceId, /^[a-f0-9]{64}$/);
			assert.equal(JSON.stringify(result.details.beemaxEffect).includes("user-secret"), false);
			assert.equal(JSON.stringify(result.details.beemaxEffect).includes("meeting-42"), false);
			resourceIds.push(result.details.beemaxEffect.proof.resourceId);
		}
		assert.equal(new Set(resourceIds).size, cases.length);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Feishu recording permission proofs are order-invariant, intent-sensitive, and fail closed", async () => {
	const success = { vc: { v1: { meetingRecording: { setPermission: async () => ({ code: 0, data: {} }) } } } };
	const tool = createFeishuMeetingTools(() => success).find((candidate) => candidate.name === "feishu_meeting_recording_set_permission");
	const first = await tool.execute("first", { meetingId: "meeting-42", actionType: 1, objects: [
		{ id: "user:2", type: 1, permission: 2 }, { permission: 1, type: 2, id: "user:1" },
	] });
	const reordered = await tool.execute("reordered", { meetingId: "meeting-42", actionType: 1, objects: [
		{ id: "user:1", type: 2, permission: 1 }, { permission: 2, id: "user:2", type: 1 },
	] });
	const changed = await tool.execute("changed", { meetingId: "meeting-42", actionType: 1, objects: [
		{ id: "user:2", type: 1, permission: 3 }, { id: "user:1", type: 2, permission: 1 },
	] });
	assert.equal(first.details.beemaxEffect.proof.resourceId, reordered.details.beemaxEffect.proof.resourceId);
	assert.notEqual(first.details.beemaxEffect.proof.resourceId, changed.details.beemaxEffect.proof.resourceId);

	const root = mkdtempSync(join(tmpdir(), "beemax-feishu-recording-failure-"));
	try {
		const failedClient = { vc: { v1: { meetingRecording: { start: async () => ({ code: 999, msg: "not host" }) } } } };
		const failedTool = createFeishuMeetingTools(() => failedClient).find((candidate) => candidate.name === "feishu_meeting_recording_start");
		const args = { meetingId: "meeting-42" };
		const result = await failedTool.execute("failed", args);
		assert.equal(result.isError, true);
		assert.equal(result.details.beemaxEffect, undefined);
		assert.equal(persistResult(root, failedTool, args, result, "failed-recording").status, "unknown");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

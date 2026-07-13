/** Feishu VC capability tools backed by @larksuiteoapi/node-sdk. */

import type { Client } from "@larksuiteoapi/node-sdk";
import { createToolEffectDetails, MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, defineTool, withToolPolicy, type ToolDefinition, type ToolPolicy } from "@beemax/core";
import { Type } from "typebox";

export type FeishuClientProvider = () => Client | undefined;

export function createFeishuMeetingTools(getClient: FeishuClientProvider): ToolDefinition[] {
	const meetingGet = defineTool({
		name: "feishu_meeting_get",
		label: "Feishu Meeting Get",
		description: "Get Feishu meeting details, optionally including participants and meeting capabilities.",
		parameters: Type.Object({
			meetingId: Type.String({ description: "Feishu meeting_id" }),
			withParticipants: Type.Optional(Type.Boolean({ description: "Include participant details" })),
		}),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.meeting.get({
				path: { meeting_id: params.meetingId },
				params: { with_participants: params.withParticipants ?? true, with_meeting_ability: true, user_id_type: "union_id" },
			});
			return apiResult("Get meeting", response, response.data?.meeting);
		}),
	});

	const meetingList = defineTool({
		name: "feishu_meeting_list",
		label: "Feishu Meeting List",
		description: "List Feishu meetings in a Unix-second time range. Can filter by meeting number or status.",
		parameters: Type.Object({
			startTime: Type.String({ description: "Range start, Unix timestamp in seconds" }),
			endTime: Type.String({ description: "Range end, Unix timestamp in seconds" }),
			meetingNo: Type.Optional(Type.String({ description: "Optional meeting number" })),
			meetingStatus: Type.Optional(Type.Integer({ description: "Optional Feishu meeting status code" })),
			pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			pageToken: Type.Optional(Type.String()),
		}),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.meetingList.get({
				params: {
					start_time: params.startTime,
					end_time: params.endTime,
					meeting_no: params.meetingNo,
					meeting_status: params.meetingStatus,
					page_size: params.pageSize ?? 50,
					page_token: params.pageToken,
					user_id_type: "union_id",
				},
			});
			return apiResult("List meetings", response, response.data);
		}),
	});

	const reserveCreate = defineTool({
		name: "feishu_meeting_reserve_create",
		label: "Feishu Meeting Reserve Create",
		description: "Create a Feishu video meeting reservation. This is a write action and requires approval.",
		parameters: Type.Object({
			topic: Type.String({ description: "Meeting topic" }),
			endTime: Type.String({ description: "Reservation expiration, Unix timestamp in seconds; must be within 30 days" }),
			ownerId: Type.Optional(Type.String({ description: "Owner union_id/open_id; omit to use application identity" })),
			password: Type.Optional(Type.String({ description: "Optional meeting password" })),
			autoRecord: Type.Optional(Type.Boolean({ description: "Automatically record the meeting" })),
			assignHostIds: Type.Optional(Type.Array(Type.String(), { description: "Optional host user IDs" })),
			idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Stable identity for safely detecting repeated creation of this reservation" })),
		}),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.reserve.apply({
				params: { user_id_type: "union_id" },
				data: {
					end_time: params.endTime,
					owner_id: params.ownerId,
					meeting_settings: {
						topic: params.topic,
						password: params.password,
						auto_record: params.autoRecord ?? false,
						meeting_initial_type: 1,
						meeting_connect: true,
						assign_host_list: params.assignHostIds?.map((id) => ({ id, user_type: 1 })),
					},
				},
			});
			const reserve = response.data?.reserve;
			const reserveId = safeIdentifier(reserve);
			return apiResult("Create meeting reservation", response, reserve, reserveId ? createToolEffectDetails({ operation: "create meeting reservation", provider: "feishu-vc", resourceType: "meeting-reservation", resourceId: reserveId, idempotencyKey: params.idempotencyKey }) : undefined);
		}),
	});

	const reserveGet = defineTool({
		name: "feishu_meeting_reserve_get",
		label: "Feishu Meeting Reserve Get",
		description: "Get a Feishu meeting reservation owned by the current application/user identity.",
		parameters: Type.Object({ reserveId: Type.String({ description: "Feishu reserve_id" }) }),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.reserve.get({
				path: { reserve_id: params.reserveId },
				params: { user_id_type: "union_id" },
			});
			return apiResult("Get meeting reservation", response, response.data?.reserve);
		}),
	});

	const reserveUpdate = defineTool({
		name: "feishu_meeting_reserve_update",
		label: "Feishu Meeting Reserve Update",
		description: "Update or renew a Feishu meeting reservation owned by the current identity. Requires approval.",
		parameters: Type.Object({
			reserveId: Type.String({ description: "Feishu reserve_id" }),
			endTime: Type.Optional(Type.String({ description: "New expiration, Unix timestamp in seconds; within 30 days" })),
			topic: Type.Optional(Type.String()),
			password: Type.Optional(Type.String()),
			autoRecord: Type.Optional(Type.Boolean()),
			assignHostIds: Type.Optional(Type.Array(Type.String(), { description: "Replacement host union_id list" })),
		}),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const hasSettings = params.topic !== undefined || params.password !== undefined ||
				params.autoRecord !== undefined || params.assignHostIds !== undefined;
			if (params.endTime === undefined && !hasSettings) {
				return textResult("At least one reservation field must be provided", { reserve_id: params.reserveId }, true);
			}
			const response = await client.vc.v1.reserve.update({
				path: { reserve_id: params.reserveId },
				params: { user_id_type: "union_id" },
				data: {
					end_time: params.endTime,
					meeting_settings: hasSettings ? {
						topic: params.topic,
						password: params.password,
						auto_record: params.autoRecord,
						assign_host_list: params.assignHostIds?.map((id) => ({ id, user_type: 1 })),
					} : undefined,
				},
			});
			return apiResult("Update meeting reservation", response, response.data);
		}),
	});

	const activeMeetingGet = defineTool({
		name: "feishu_meeting_reserve_active_get",
		label: "Feishu Meeting Reserve Active Get",
		description: "Get the currently active meeting for a Feishu reservation owned by the current identity.",
		parameters: Type.Object({
			reserveId: Type.String({ description: "Feishu reserve_id" }),
			withParticipants: Type.Optional(Type.Boolean()),
		}),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.reserve.getActiveMeeting({
				path: { reserve_id: params.reserveId },
				params: { with_participants: params.withParticipants ?? true, user_id_type: "union_id" },
			});
			return apiResult("Get active reserved meeting", response, response.data?.meeting);
		}),
	});

	const reserveDelete = defineTool({
		name: "feishu_meeting_reserve_delete",
		label: "Feishu Meeting Reserve Delete",
		description: "Delete a Feishu meeting reservation. Irreversible write action; requires approval.",
		parameters: Type.Object({ reserveId: Type.String({ description: "Feishu reserve_id" }) }),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.reserve.delete({ path: { reserve_id: params.reserveId } });
			return apiResult("Delete meeting reservation", response, { reserve_id: params.reserveId, deleted: true });
		}),
	});

	const meetingEnd = defineTool({
		name: "feishu_meeting_end",
		label: "Feishu Meeting End",
		description: "End an active Feishu meeting. Requires host permission and explicit approval.",
		parameters: Type.Object({ meetingId: Type.String({ description: "Feishu meeting_id" }) }),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.meeting.end({ path: { meeting_id: params.meetingId } });
			return apiResult("End meeting", response, { meeting_id: params.meetingId, ended: true });
		}),
	});

	const meetingInvite = defineTool({
		name: "feishu_meeting_invite",
		label: "Feishu Meeting Invite",
		description: "Invite Feishu users to an active meeting by union_id. Requires approval and meeting permission.",
		parameters: Type.Object({
			meetingId: Type.String({ description: "Feishu meeting_id" }),
			userIds: Type.Array(Type.String(), { minItems: 1, maxItems: 100, description: "Invitee union_id values" }),
		}),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.meeting.invite({
				path: { meeting_id: params.meetingId },
				params: { user_id_type: "union_id" },
				data: { invitees: params.userIds.map((id) => ({ id, user_type: 1 })) },
			});
			return apiResult("Invite meeting participants", response, response.data);
		}),
	});

	const meetingKickout = defineTool({
		name: "feishu_meeting_kickout",
		label: "Feishu Meeting Kickout",
		description: "Remove Feishu users from an active meeting by union_id. Requires explicit approval.",
		parameters: Type.Object({
			meetingId: Type.String({ description: "Feishu meeting_id" }),
			userIds: Type.Array(Type.String(), { minItems: 1, maxItems: 100, description: "Participant union_id values" }),
		}),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.meeting.kickout({
				path: { meeting_id: params.meetingId },
				params: { user_id_type: "union_id" },
				data: { kickout_users: params.userIds.map((id) => ({ id, user_type: 1 })) },
			});
			return apiResult("Remove meeting participants", response, response.data);
		}),
	});

	const meetingSetHost = defineTool({
		name: "feishu_meeting_set_host",
		label: "Feishu Meeting Set Host",
		description: "Transfer host of an active Feishu meeting. Pass oldHostId for CAS safety when known. Requires approval.",
		parameters: Type.Object({
			meetingId: Type.String({ description: "Feishu meeting_id" }),
			hostId: Type.String({ description: "New host union_id" }),
			oldHostId: Type.Optional(Type.String({ description: "Current host union_id for concurrency safety" })),
		}),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.meeting.setHost({
				path: { meeting_id: params.meetingId },
				params: { user_id_type: "union_id" },
				data: {
					host_user: { id: params.hostId, user_type: 1 },
					old_host_user: params.oldHostId ? { id: params.oldHostId, user_type: 1 } : undefined,
				},
			});
			return apiResult("Set meeting host", response, response.data);
		}),
	});

	const recordingGet = defineTool({
		name: "feishu_meeting_recording_get",
		label: "Feishu Meeting Recording Get",
		description: "Get recording URL and duration for a completed Feishu meeting owned by the current identity.",
		parameters: Type.Object({ meetingId: Type.String({ description: "Feishu meeting_id" }) }),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.meetingRecording.get({ path: { meeting_id: params.meetingId } });
			return apiResult("Get meeting recording", response, response.data?.recording);
		}),
	});

	const recordingSetPermission = defineTool({
		name: "feishu_meeting_recording_set_permission",
		label: "Feishu Meeting Recording Set Permission",
		description: "Grant or revoke access to a completed meeting recording using Feishu VC permission enum values. Requires approval.",
		parameters: Type.Object({
			meetingId: Type.String({ description: "Feishu meeting_id" }),
			actionType: Type.Optional(Type.Integer({ description: "Feishu recording permission action type" })),
			objects: Type.Array(Type.Object({
				id: Type.Optional(Type.String({ description: "User/tenant object ID, depending on type" })),
				type: Type.Integer({ description: "Feishu permission object type" }),
				permission: Type.Integer({ description: "Feishu recording permission level" }),
			}), { minItems: 1, maxItems: 100 }),
		}),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.meetingRecording.setPermission({
				path: { meeting_id: params.meetingId },
				params: { user_id_type: "union_id" },
				data: { permission_objects: params.objects, action_type: params.actionType },
			});
			return apiResult("Set meeting recording permission", response, {
				meeting_id: params.meetingId,
				permission_objects: params.objects.length,
			});
		}),
	});

	const recordingStart = defineTool({
		name: "feishu_meeting_recording_start",
		label: "Feishu Meeting Recording Start",
		description: "Start recording an active Feishu meeting. Requires host permission and explicit approval.",
		parameters: Type.Object({ meetingId: Type.String({ description: "Feishu meeting_id" }) }),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.meetingRecording.start({ path: { meeting_id: params.meetingId } });
			return apiResult("Start meeting recording", response, { meeting_id: params.meetingId, recording: "started" });
		}),
	});

	const recordingStop = defineTool({
		name: "feishu_meeting_recording_stop",
		label: "Feishu Meeting Recording Stop",
		description: "Stop recording an active Feishu meeting. Requires host permission and explicit approval.",
		parameters: Type.Object({ meetingId: Type.String({ description: "Feishu meeting_id" }) }),
		execute: async (_id, params) => withClient(getClient, async (client) => {
			const response = await client.vc.v1.meetingRecording.stop({ path: { meeting_id: params.meetingId } });
			return apiResult("Stop meeting recording", response, { meeting_id: params.meetingId, recording: "stopped" });
		}),
	});

	const tools = [
		meetingGet,
		meetingList,
		reserveCreate,
		reserveGet,
		reserveUpdate,
		activeMeetingGet,
		reserveDelete,
		meetingEnd,
		meetingInvite,
		meetingKickout,
		meetingSetHost,
		recordingGet,
		recordingSetPermission,
		recordingStart,
		recordingStop,
	];
	const changeMeeting: ToolPolicy = { ...MUTATING_TOOL_POLICY, risk: "medium", reversible: "unknown", impact: "Changes meeting state or participants in Feishu", effectProofProvider: "feishu-vc" };
	const destructiveMeeting: ToolPolicy = { ...changeMeeting, risk: "high", reversible: false, impact: "Performs a non-reversible meeting or recording operation in Feishu" };
	const readOnly = new Set(["feishu_meeting_get", "feishu_meeting_list", "feishu_meeting_reserve_get", "feishu_meeting_reserve_active_get", "feishu_meeting_recording_get"]);
	const destructive = new Set(["feishu_meeting_reserve_delete", "feishu_meeting_end", "feishu_meeting_kickout", "feishu_meeting_recording_stop"]);
	return tools.map((tool) => withToolPolicy(tool, readOnly.has(tool.name) ? { ...READ_ONLY_TOOL_POLICY } : destructive.has(tool.name) ? destructiveMeeting : changeMeeting));
}

async function withClient(
	getClient: FeishuClientProvider,
	run: (client: Client) => Promise<ReturnType<typeof textResult>>,
) {
	const client = getClient();
	if (!client) return textResult("Feishu client is not connected", { connected: false }, true);
	try {
		return await run(client);
	} catch (error) {
		return textResult(
			`Feishu meeting API failed: ${error instanceof Error ? error.message : String(error)}`,
			{ connected: true },
			true,
		);
	}
}

function apiResult(
	operation: string,
	response: { code?: number; msg?: string },
	data: unknown,
	effectDetails?: ReturnType<typeof createToolEffectDetails>,
) {
	if (response.code !== 0) {
		return textResult(
			`${operation} failed: code=${response.code ?? "unknown"} msg=${response.msg ?? "unknown error"}. ` +
				"Check Feishu VC scopes and whether the current app/user owns this meeting resource.",
			{ operation, code: response.code, message: response.msg },
			true,
		);
	}
	return textResult(JSON.stringify(data ?? {}, null, 2), { operation, data, ...effectDetails });
}

function safeIdentifier(value: unknown): string | undefined { if (!value || typeof value !== "object") return undefined; const record = value as Record<string, unknown>; const id = record.reserve_id ?? record.id; return typeof id === "string" && id.trim() ? id.trim() : undefined; }

function textResult(text: string, details: unknown, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

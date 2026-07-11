import type { AgentRunInput } from "./agent-runtime.ts";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { InteractionEventAdapter, interactionScopeForSource, type InteractionActionResult, type InteractionEvent, type InteractionScope, type InteractionSnapshot } from "./interaction-runtime.ts";
import type { ToolApprovalChoice } from "./tool-approval.ts";

/** Transport-neutral contract for authenticated Web/remote presenters. */
export const INTERACTION_PROTOCOL_VERSION = 1 as const;

export type ProtocolInteractionAction =
	| { type: "message.send"; text: string; input: Omit<AgentRunInput, "source" | "text">; actionId?: string }
	| { type: "turn.queue"; text: string; actionId?: string }
	| { type: "turn.steer"; text: string; actionId?: string }
	| { type: "approval.decide"; choice: ToolApprovalChoice; actionId?: string }
	| { type: "turn.cancel"; actionId?: string };

export type InteractionProtocolRequest =
	| { version: typeof INTERACTION_PROTOCOL_VERSION; id: string; type: "snapshot"; scope: InteractionScope }
	| { version: typeof INTERACTION_PROTOCOL_VERSION; id: string; type: "events"; scope: InteractionScope; afterSequence?: number }
	| { version: typeof INTERACTION_PROTOCOL_VERSION; id: string; type: "action"; scope: InteractionScope; action: ProtocolInteractionAction };

export type InteractionProtocolResponse =
	| { version: typeof INTERACTION_PROTOCOL_VERSION; id: string; ok: true; type: "snapshot"; snapshot: InteractionSnapshot }
	| { version: typeof INTERACTION_PROTOCOL_VERSION; id: string; ok: true; type: "events"; events: InteractionEvent[] }
	| { version: typeof INTERACTION_PROTOCOL_VERSION; id: string; ok: true; type: "action"; result: InteractionActionResult }
	| { version: typeof INTERACTION_PROTOCOL_VERSION; id: string; ok: false; error: "unauthorized_scope" | "invalid_request" | "unsupported_version"; message: string };

export interface InteractionProtocolOptions<Source extends BeeMaxRuntimeSource> {
	adapter: InteractionEventAdapter<Source>;
	/** Resolves a scope only after the authenticated scope is proven equal. */
	resolveSource(scope: InteractionScope): Source;
}

/** Core protocol facade: transport authenticates; Core enforces exact scope. */
export class InteractionProtocol<Source extends BeeMaxRuntimeSource> {
	private readonly adapter: InteractionEventAdapter<Source>;
	private readonly resolveSource: (scope: InteractionScope) => Source;

	constructor(options: InteractionProtocolOptions<Source>) {
		this.adapter = options.adapter;
		this.resolveSource = options.resolveSource;
	}

	async handle(request: InteractionProtocolRequest, authenticatedScope: InteractionScope): Promise<InteractionProtocolResponse> {
		if (request.version !== INTERACTION_PROTOCOL_VERSION) return failure(request.id, "unsupported_version", `Expected protocol version ${INTERACTION_PROTOCOL_VERSION}`);
		if (!sameScope(request.scope, authenticatedScope)) return failure(request.id, "unauthorized_scope", "Request scope does not match the authenticated scope");
		const source = this.resolveSource(authenticatedScope);
		if (!sameScope(interactionScopeForSource(source, authenticatedScope.profileId), authenticatedScope)) return failure(request.id, "unauthorized_scope", "Resolved source does not match the authenticated scope");
		if (request.type === "snapshot") return { version: INTERACTION_PROTOCOL_VERSION, id: request.id, ok: true, type: "snapshot", snapshot: await this.adapter.snapshot(source) };
		if (request.type === "events") return { version: INTERACTION_PROTOCOL_VERSION, id: request.id, ok: true, type: "events", events: this.adapter.events(source, clampSequence(request.afterSequence)) };
		return { version: INTERACTION_PROTOCOL_VERSION, id: request.id, ok: true, type: "action", result: await this.adapter.dispatch(hydrateAction(request.action, source)) };
	}
}

/** Runtime validation for JSON transports before they call {@link InteractionProtocol.handle}. */
export function parseInteractionProtocolRequest(value: unknown): InteractionProtocolRequest | undefined {
	if (!value || typeof value !== "object") return undefined;
	const request = value as Record<string, unknown>;
	if (request.version !== INTERACTION_PROTOCOL_VERSION || typeof request.id !== "string" || !request.id.trim() || !isScope(request.scope) || typeof request.type !== "string") return undefined;
	if (request.type === "snapshot") return request as InteractionProtocolRequest;
	if (request.type === "events") return request.afterSequence === undefined || Number.isSafeInteger(request.afterSequence) ? request as InteractionProtocolRequest : undefined;
	if (request.type !== "action" || !request.action || typeof request.action !== "object") return undefined;
	const action = request.action as Record<string, unknown>;
	if (!(["message.send", "turn.queue", "turn.steer", "approval.decide", "turn.cancel"] as string[]).includes(String(action.type))) return undefined;
	if (action.type === "message.send") return typeof action.text === "string" && action.input && typeof action.input === "object" ? request as InteractionProtocolRequest : undefined;
	if (action.type === "turn.queue" || action.type === "turn.steer") return typeof action.text === "string" ? request as InteractionProtocolRequest : undefined;
	if (action.type === "approval.decide") return ["once", "session", "deny"].includes(String(action.choice)) ? request as InteractionProtocolRequest : undefined;
	return request as InteractionProtocolRequest;
}

export function sameScope(left: InteractionScope, right: InteractionScope): boolean {
	return left.profileId === right.profileId && left.platform === right.platform && left.chatId === right.chatId && left.userId === right.userId && left.threadId === right.threadId;
}

function isScope(value: unknown): value is InteractionScope {
	if (!value || typeof value !== "object") return false;
	const scope = value as Record<string, unknown>;
	return typeof scope.profileId === "string" && typeof scope.platform === "string" && typeof scope.chatId === "string" && (scope.userId === undefined || typeof scope.userId === "string") && (scope.threadId === undefined || typeof scope.threadId === "string");
}

function hydrateAction<Source extends BeeMaxRuntimeSource>(action: ProtocolInteractionAction, source: Source) {
	return { ...action, source } as Parameters<InteractionEventAdapter<Source>["dispatch"]>[0];
}
function clampSequence(sequence: number | undefined): number { return Number.isSafeInteger(sequence) ? Math.max(0, sequence!) : 0; }
function failure(id: string, error: "unauthorized_scope" | "invalid_request" | "unsupported_version", message: string): InteractionProtocolResponse {
	return { version: INTERACTION_PROTOCOL_VERSION, id, ok: false, error, message };
}

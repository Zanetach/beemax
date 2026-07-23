import type { DeliveryOptions, DeliveryReceipt, DeliveryTarget, InteractionEvent, TaskPlanProgressEvent } from "@beemax/core";
import type { SessionSource } from "./types.ts";

export interface InteractionPresentationPreferences {
	title?: string;
	reasoningDisplay?: "off" | "summary" | "raw";
	/** Do not create a progress message for Turns that finish before this delay. */
	progressDelayMs?: number;
	updateIntervalMs?: number;
	ioTimeoutMs?: number;
}

export interface InteractionPresentationOpen {
	source: SessionSource;
	profileId: string;
	preferences?: InteractionPresentationPreferences;
	onBinding?: (messageId: string, pendingApprovalId?: string) => void;
}

export interface TurnPresentation {
	start(): Promise<void>;
	onEvent(event: InteractionEvent): Promise<void>;
	finish(answer: string, options?: DeliveryOptions): Promise<DeliveryReceipt>;
	fail(error: string): Promise<void>;
	close(failed: boolean): Promise<void>;
}

export interface WorkProgressPresentation {
	target: DeliveryTarget;
	event: TaskPlanProgressEvent;
	idempotencyKey?: string;
}

/** Adapter-owned presentation interface; Gateway never constructs provider payloads. */
export interface InteractionPresenter {
	open(input: InteractionPresentationOpen): TurnPresentation;
	presentWorkProgress?(input: WorkProgressPresentation): Promise<void>;
}

/** Stable channel-neutral copy shared by rich and text presenters. */
export function formatWorkProgress(event: TaskPlanProgressEvent): string {
	return `${event.title} · ${event.completed}/${event.total}${event.failed ? ` · 失败 ${event.failed}` : ""}${event.cancelled ? ` · 取消 ${event.cancelled}` : ""}`;
}

/** Stable approval instructions; provider presenters choose only the visual treatment. */
export function formatApprovalRequest(event: Extract<InteractionEvent, { type: "approval.requested" }>): string {
	return event.details
		? `等待审批：${event.toolName}\n目标：${event.details.target}\n风险：${event.details.risk} · ${event.details.impact}\n可逆性：${event.details.reversibility}\n回复 1（一次）/ 2（本会话）/ 3（拒绝），或 /stop 取消。`
		: `等待审批：${event.toolName}\n回复 1（一次）/ 2（本会话）/ 3（拒绝），或 /stop 取消。`;
}

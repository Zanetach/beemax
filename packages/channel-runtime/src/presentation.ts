import type { DeliveryTarget, InteractionEvent, TaskPlanProgressEvent } from "@beemax/core";
import type { SessionSource } from "./types.ts";

export interface InteractionPresentationPreferences {
	title?: string;
	reasoningDisplay?: "off" | "summary" | "raw";
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
	finish(answer: string): Promise<void>;
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

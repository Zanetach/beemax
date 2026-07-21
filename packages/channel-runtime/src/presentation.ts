import type { DeliveryOptions, DeliveryReceipt, DeliveryTarget, InteractionEvent, TaskPlanProgressEvent } from "@beemax/core";
import type { SessionSource } from "./types.ts";

export interface PublishedArtifactPresentation {
	url: string;
	name: string;
	mediaType: string;
	disposition: "inline" | "attachment";
}

export interface TurnPresentationFinishOptions extends DeliveryOptions {
	/** Trusted publication metadata produced from integrity-checked Artifacts. */
	publishedArtifacts?: readonly PublishedArtifactPresentation[];
}

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
	onBinding?: (messageId: string) => void;
}

export interface TurnPresentation {
	start(): Promise<void>;
	onEvent(event: InteractionEvent): Promise<void>;
	finish(answer: string, options?: TurnPresentationFinishOptions): Promise<DeliveryReceipt>;
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

/** Text-channel projection of trusted published Artifact metadata. */
export function formatAnswerWithPublishedArtifacts(answer: string, artifacts: readonly PublishedArtifactPresentation[] = []): string {
	const seen = new Set<string>();
	const links = artifacts.flatMap((artifact) => {
		if (seen.has(artifact.url) || !isSafePublishedUrl(artifact.url)) return [];
		seen.add(artifact.url);
		const compactName = artifact.name.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200) || "文件";
		const name = compactName.replace(/\\/gu, "\\\\").replace(/\[/gu, "\\[").replace(/\]/gu, "\\]");
		const url = artifact.url.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
		return [`- [${name}](${url})${artifact.disposition === "attachment" ? "（下载）" : ""}`];
	});
	if (!links.length) return answer;
	return `${answer.trimEnd()}\n\n在线打开 / 下载：\n${links.join("\n")}`;
}

function isSafePublishedUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
	} catch {
		return false;
	}
}

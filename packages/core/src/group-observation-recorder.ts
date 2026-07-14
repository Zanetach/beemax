import { createHash } from "node:crypto";
import { createSituation } from "./situation.ts";
import type { InitiativeObservation, InitiativeObservationInput, InitiativeScope } from "./initiative-runtime.ts";

export interface AmbientGroupObservation {
	text: string;
	source: {
		platform: string;
		channelInstanceId?: string;
		chatId: string;
		chatType: "dm" | "group" | "channel" | "thread";
		threadId?: string;
		messageId?: string;
	};
	timestamp: number;
}

export interface GroupObservationStore {
	upsertBoundedAmbientGroupObservation(input: InitiativeObservationInput, retain: number): { observation: InitiativeObservation; created: boolean };
}

export interface GroupObservationRecorderOptions {
	profileId: string;
	store: GroupObservationStore;
	retainPerLane?: number;
}

/** Core-owned observe-only admission with no Agent, Task Ledger writer, Tool Runtime, or Delivery port. */
export class GroupObservationRecorder {
	private readonly profileId: string;
	private readonly store: GroupObservationStore;
	private readonly retainPerLane: number;

	constructor(options: GroupObservationRecorderOptions) {
		if (!options.profileId.trim()) throw new Error("Group Observation Recorder requires a Profile");
		this.profileId = options.profileId;
		this.store = options.store;
		this.retainPerLane = boundedRetention(options.retainPerLane);
	}

	record(observation: AmbientGroupObservation): { observation: InitiativeObservation; created: boolean } {
		if (observation.source.chatType === "dm") throw new Error("Ambient group Observation cannot accept a direct message");
		const text = observation.text.trim();
		const messageId = observation.source.messageId?.trim();
		if (!text || text.length > 10_000 || !messageId) throw new Error("Ambient group Observation requires bounded text and a message id");
		const scope: InitiativeScope = {
			profileId: this.profileId,
			platform: observation.source.platform,
			...(observation.source.channelInstanceId ? { channelInstanceId: observation.source.channelInstanceId } : {}),
			chatId: observation.source.chatId,
			...(observation.source.threadId ? { threadId: observation.source.threadId } : {}),
		};
		const evidenceRef = `message:${observation.source.platform}:${observation.source.channelInstanceId ?? "default"}:${messageId}`;
		const input: InitiativeObservationInput = {
			dedupeKey: createHash("sha256").update([this.profileId, observation.source.platform, observation.source.channelInstanceId ?? "", observation.source.chatId, observation.source.threadId ?? "", messageId].join("\0")).digest("hex"),
			triggerKind: "message",
			triggerId: `ambient-group:${evidenceRef}`,
			scope,
			situation: createSituation({
				summary: "Unreviewed ambient group observation",
				observations: [{ statement: text, source: { kind: "user", reference: evidenceRef }, evidenceRef, confidence: 1, trust: "reported" }],
				confidence: 0.5,
			}),
			action: "Re-evaluate this candidate only when later evidence makes it relevant",
			expectedValue: 0.5,
			risk: "none",
			rationale: "Ambient group content retained as an unreviewed candidate Observation",
			intendedVerification: "Later evidence explicitly relates the Observation to active work",
			evidenceRefs: [evidenceRef],
			confidence: 0.5,
			mode: "observe_only",
			disposition: "new_candidate",
			notificationEmitted: false,
			observedAt: observation.timestamp,
		};
		return this.store.upsertBoundedAmbientGroupObservation(input, this.retainPerLane);
	}
}

function boundedRetention(value: number | undefined): number {
	if (value === undefined) return 100;
	if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error("Group Observation retention must be between 1 and 10000");
	return value;
}

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

interface AmbientObservationEvaluationBase {
	relevance: number;
	credibility: number;
	expectedValue: number;
	confidence: number;
	rationale: string;
}
type RetainedAmbientObservationEvaluation = AmbientObservationEvaluationBase & { disposition: "retain"; action: string; intendedVerification: string };
export type AmbientObservationEvaluation = RetainedAmbientObservationEvaluation | AmbientObservationEvaluationBase & { disposition: "defer" | "ignore"; action?: string; intendedVerification?: string };

export interface AmbientObservationEvaluator {
	evaluate(observation: AmbientGroupObservation): Promise<AmbientObservationEvaluation>;
}

export type GroupObservationRecordResult =
	| { kind: "retained"; observation: InitiativeObservation; created: boolean }
	| { kind: "deferred" | "ignored"; rationale: string };

export interface GroupObservationRecorderOptions {
	profileId: string;
	store: GroupObservationStore;
	evaluator: AmbientObservationEvaluator;
	retainPerLane?: number;
}

/** Core-owned observe-only admission with no Agent, Task Ledger writer, Tool Runtime, or Delivery port. */
export class GroupObservationRecorder {
	private readonly profileId: string;
	private readonly store: GroupObservationStore;
	private readonly evaluator: AmbientObservationEvaluator;
	private readonly retainPerLane: number;

	constructor(options: GroupObservationRecorderOptions) {
		if (!options.profileId.trim()) throw new Error("Group Observation Recorder requires a Profile");
		this.profileId = options.profileId;
		this.store = options.store;
		this.evaluator = options.evaluator;
		this.retainPerLane = boundedRetention(options.retainPerLane);
	}

	async record(observation: AmbientGroupObservation): Promise<GroupObservationRecordResult> {
		if (observation.source.chatType === "dm") throw new Error("Ambient group Observation cannot accept a direct message");
		const text = observation.text.trim();
		const messageId = observation.source.messageId?.trim();
		if (!text || text.length > 10_000 || !messageId) throw new Error("Ambient group Observation requires bounded text and a message id");
		const evaluation = normalizeEvaluation(await this.evaluator.evaluate({ ...observation, text }));
		if (evaluation.disposition !== "retain") return { kind: evaluation.disposition === "defer" ? "deferred" : "ignored", rationale: evaluation.rationale };
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
				summary: evaluation.rationale,
				observations: [{ statement: text, source: { kind: "user", reference: evidenceRef }, evidenceRef, confidence: Math.min(evaluation.credibility, evaluation.confidence), trust: "reported" }],
				confidence: evaluation.confidence,
			}),
			action: evaluation.action,
			expectedValue: evaluation.expectedValue,
			risk: "none",
			rationale: evaluation.rationale,
			intendedVerification: evaluation.intendedVerification,
			evidenceRefs: [evidenceRef],
			confidence: Math.min(evaluation.relevance, evaluation.credibility, evaluation.confidence),
			mode: "observe_only",
			disposition: "new_candidate",
			notificationEmitted: false,
			observedAt: observation.timestamp,
		};
		return { kind: "retained", ...this.store.upsertBoundedAmbientGroupObservation(input, this.retainPerLane) };
	}
}

function normalizeEvaluation(value: AmbientObservationEvaluation): AmbientObservationEvaluation {
	if (!value || !["retain", "defer", "ignore"].includes(value.disposition)) throw new Error("Ambient Observation evaluation disposition is invalid");
	for (const [name, score] of Object.entries({ relevance: value.relevance, credibility: value.credibility, expectedValue: value.expectedValue, confidence: value.confidence })) {
		if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`Ambient Observation evaluation ${name} must be between 0 and 1`);
	}
	const rationale = boundedText(value.rationale, "rationale");
	if (value.disposition !== "retain") return { ...value, rationale };
	return { ...value, rationale, action: boundedText(value.action, "action"), intendedVerification: boundedText(value.intendedVerification, "verification") };
}

function boundedText(value: string | undefined, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > 5_000) throw new Error(`Ambient Observation evaluation ${field} is invalid`);
	return value.trim();
}

function boundedRetention(value: number | undefined): number {
	if (value === undefined) return 100;
	if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error("Group Observation retention must be between 1 and 10000");
	return value;
}

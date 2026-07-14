import { createHash } from "node:crypto";
import { containsCredentialMaterial } from "./credential-material.ts";
import type { Situation } from "./situation.ts";
import type { SituationBuilderPort } from "./situation-builder.ts";
import type { SituationEvidenceInput } from "./situation-builder.ts";
import type { TaskLedger, TaskRecord } from "./task-ledger.ts";
import type { TurnUnderstanding } from "./turn-understanding.ts";
import { canonicalUserId, type AgentScope } from "./agent-scope.ts";

export type InitiativeTriggerKind = "heartbeat" | "message" | "task_transition" | "enterprise_event";
export interface InitiativeScope {
	profileId: string;
	platform: string;
	channelInstanceId?: string;
	chatId: string;
	userId?: string;
	threadId?: string;
}
export interface InitiativeTrigger {
	kind: InitiativeTriggerKind;
	id: string;
	occurredAt: number;
	scope: InitiativeScope;
	prompt: string;
	evidence?: SituationEvidenceInput[];
}
export type InitiativeRisk = "none" | "low" | "medium" | "high";
export type InitiativeDecision =
	| { kind: "ignore"; rationale: string }
	| {
		kind: "propose";
		action: string;
		expectedValue: number;
		risk: InitiativeRisk;
		rationale: string;
		intendedVerification: string;
		evidenceRefs: string[];
		confidence: number;
		relatedObjectiveId?: string;
	};
export interface InitiativeDecisionContext {
	trigger: InitiativeTrigger;
	situation: Situation;
	activeObjectives: TaskRecord[];
}
export type InitiativeDecisionPort = (context: InitiativeDecisionContext) => Promise<InitiativeDecision>;
export type InitiativeEvidenceRecallPort = (situation: Situation, trigger: InitiativeTrigger) => Promise<SituationEvidenceInput[]> | SituationEvidenceInput[];

export interface InitiativeObservationInput {
	dedupeKey: string;
	triggerKind: InitiativeTriggerKind;
	triggerId: string;
	scope: InitiativeScope;
	situation: Situation;
	action: string;
	expectedValue: number;
	risk: InitiativeRisk;
	rationale: string;
	intendedVerification: string;
	evidenceRefs: string[];
	confidence: number;
	mode: "observe_only";
	disposition: "new_candidate" | "relates_to_active_objective";
	relatedObjectiveId?: string;
	notificationEmitted: false;
	observedAt: number;
}
export interface InitiativeObservation extends InitiativeObservationInput {
	id: string;
	repeatCount: number;
	feedback: "unreviewed" | "accepted" | "rejected";
	createdAt: number;
	lastObservedAt: number;
}
export interface InitiativeObservationStore {
	upsertInitiativeObservation(input: InitiativeObservationInput): { observation: InitiativeObservation; created: boolean };
}

/** Exact trusted route match; optional observation actor/thread fields remain deliberate scope wildcards. */
export function initiativeScopeMatchesExecutionScope(scope: InitiativeScope, executionScope: AgentScope): boolean {
	return scope.platform === executionScope.platform
		&& scope.channelInstanceId === executionScope.channelInstanceId
		&& scope.chatId === executionScope.chatId
		&& (!scope.userId || scope.userId === canonicalUserId(executionScope))
		&& (!scope.threadId || scope.threadId === executionScope.threadId);
}
export type InitiativeObserveResult =
	| { kind: "ignored"; rationale: string }
	| { kind: "observed"; observation: InitiativeObservation; created: boolean };

export interface InitiativeRuntimeOptions {
	situationBuilder: SituationBuilderPort;
	decide: InitiativeDecisionPort;
	observations: InitiativeObservationStore;
	taskLedger: Pick<TaskLedger, "queryTasks">;
	recallEvidence?: InitiativeEvidenceRecallPort;
}

/**
 * Admits proactive cognition without admitting proactive execution. This class
 * has no Task Ledger writer, Tool Runtime, Pi execution, or Delivery port.
 */
export class InitiativeRuntime {
	private readonly options: InitiativeRuntimeOptions;
	constructor(options: InitiativeRuntimeOptions) { this.options = options; }

	async observe(trigger: InitiativeTrigger): Promise<InitiativeObserveResult> {
		const normalizedTrigger = normalizeTrigger(trigger);
		const ownerKey = initiativeOwnerKey(normalizedTrigger.scope);
		const activeObjectives = this.options.taskLedger.queryTasks({ ownerKeys: [ownerKey], kinds: ["objective"], statuses: ["pending", "running"], limit: 100 });
		const activeObjective = activeObjectives[0];
		const seed = seedSituation(normalizedTrigger, activeObjectives);
		const recalledEvidence = await this.options.recallEvidence?.(seed, normalizedTrigger);
		const evidence = [...(normalizedTrigger.evidence ?? []), ...(recalledEvidence ?? [])];
		const built = await this.options.situationBuilder.build({
			text: normalizedTrigger.prompt,
			fallback: fallbackUnderstanding(normalizedTrigger.prompt),
			origin: { source: { kind: "tool", reference: normalizedTrigger.id }, trust: "observed" },
			...(activeObjective ? { activeObjective: { id: activeObjective.id, title: activeObjective.title, ...(activeObjective.situation ? { situation: activeObjective.situation } : {}) } } : {}),
			...(evidence.length ? { evidence } : {}),
		});
		const rawDecision = await this.options.decide({ trigger: normalizedTrigger, situation: built.situation, activeObjectives });
		if (rawDecision.kind === "ignore") return { kind: "ignored", rationale: requiredText(rawDecision.rationale, "Initiative ignore rationale", 5_000) };
		const decision = normalizeProposal(rawDecision, built.situation);
		if (!decision) return { kind: "ignored", rationale: "Initiative proposal was not evidence-backed" };
		const related = decision.relatedObjectiveId
			? activeObjectives.find((objective) => objective.id === decision.relatedObjectiveId)
			: undefined;
		const dedupeKey = initiativeDedupeKey(normalizedTrigger.scope, decision.action, related?.id);
		const persisted = this.options.observations.upsertInitiativeObservation({
			dedupeKey,
			triggerKind: normalizedTrigger.kind,
			triggerId: normalizedTrigger.id,
			scope: normalizedTrigger.scope,
			situation: built.situation,
			action: decision.action,
			expectedValue: decision.expectedValue,
			risk: decision.risk,
			rationale: decision.rationale,
			intendedVerification: decision.intendedVerification,
			evidenceRefs: decision.evidenceRefs,
			confidence: decision.confidence,
			mode: "observe_only",
			disposition: related ? "relates_to_active_objective" : "new_candidate",
			...(related ? { relatedObjectiveId: related.id } : {}),
			notificationEmitted: false,
			observedAt: normalizedTrigger.occurredAt,
		});
		return { kind: "observed", ...persisted };
	}
}

/** Generic fallback admission: it reads Situation shape, never customer-specific nouns. */
export async function decideInitiativeFromSituation(context: InitiativeDecisionContext): Promise<InitiativeDecision> {
	const action = context.situation.possibleActions[0];
	if (!action || context.situation.confidence < 0.6) return { kind: "ignore", rationale: "Situation has no sufficiently confident meaningful action" };
	const evidenceRefs = [...new Set([
		...context.situation.relevantMemoryIds,
		...context.situation.relevantTaskIds,
		...context.situation.observations.flatMap((observation) => observation.evidenceRef ? [observation.evidenceRef] : []),
		...(context.situation.conflicts ?? []).flatMap((conflict) => conflict.evidenceRefs),
	])];
	if (!evidenceRefs.length) return { kind: "ignore", rationale: "Situation action has no durable evidence" };
	const relatedObjectiveId = context.activeObjectives.find((objective) => context.situation.relevantTaskIds.includes(objective.id))?.id;
	return {
		kind: "propose",
		action: action.description,
		expectedValue: context.situation.confidence,
		risk: action.reversible === true ? "low" : action.reversible === false ? "high" : "medium",
		rationale: context.situation.summary,
		intendedVerification: action.expectedOutcome,
		evidenceRefs,
		confidence: context.situation.confidence,
		...(relatedObjectiveId ? { relatedObjectiveId } : {}),
	};
}

export function initiativeOwnerKey(scope: InitiativeScope): string {
	return `${scope.platform}${scope.channelInstanceId ? `@${scope.channelInstanceId}` : ""}:${scope.chatId}:${scope.userId ?? "anon"}`;
}

export function initiativeDedupeKey(scope: InitiativeScope, action: string, relatedObjectiveId?: string): string {
	const identity = [scope.profileId, scope.platform, scope.channelInstanceId ?? "", scope.chatId, scope.userId ?? "", scope.threadId ?? "", canonical(action), relatedObjectiveId ?? ""].join("\0");
	return createHash("sha256").update(identity).digest("hex");
}

function normalizeTrigger(trigger: InitiativeTrigger): InitiativeTrigger {
	if (!["heartbeat", "message", "task_transition", "enterprise_event"].includes(trigger.kind)) throw new Error("Initiative trigger kind is invalid");
	if (!Number.isSafeInteger(trigger.occurredAt) || trigger.occurredAt < 0) throw new Error("Initiative trigger time is invalid");
	const scope = {
		profileId: requiredText(trigger.scope.profileId, "Initiative profile", 512),
		platform: requiredText(trigger.scope.platform, "Initiative platform", 128),
		...(trigger.scope.channelInstanceId ? { channelInstanceId: requiredText(trigger.scope.channelInstanceId, "Initiative Channel Instance", 512) } : {}),
		chatId: requiredText(trigger.scope.chatId, "Initiative chat", 512),
		...(trigger.scope.userId ? { userId: requiredText(trigger.scope.userId, "Initiative user", 512) } : {}),
		...(trigger.scope.threadId ? { threadId: requiredText(trigger.scope.threadId, "Initiative thread", 512) } : {}),
	};
	if (trigger.evidence && (!Array.isArray(trigger.evidence) || trigger.evidence.length > 100)) throw new Error("Initiative trigger evidence is invalid");
	return { kind: trigger.kind, id: requiredText(trigger.id, "Initiative trigger ID", 512), occurredAt: trigger.occurredAt, scope, prompt: requiredText(trigger.prompt, "Initiative prompt", 10_000), ...(trigger.evidence?.length ? { evidence: structuredClone(trigger.evidence) } : {}) };
}

function normalizeProposal(decision: Extract<InitiativeDecision, { kind: "propose" }>, situation: Situation): Extract<InitiativeDecision, { kind: "propose" }> | undefined {
	if (!Number.isFinite(decision.expectedValue) || decision.expectedValue < 0 || decision.expectedValue > 1) return undefined;
	if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) return undefined;
	if (!["none", "low", "medium", "high"].includes(decision.risk)) return undefined;
	const availableEvidence = new Set([
		...situation.relevantMemoryIds,
		...situation.relevantTaskIds,
		...situation.observations.flatMap((observation) => observation.evidenceRef ? [observation.evidenceRef] : [observation.source.reference]),
		...(situation.conflicts ?? []).flatMap((conflict) => conflict.evidenceRefs),
	]);
	const evidenceRefs = [...new Set(decision.evidenceRefs.map((reference) => reference.trim()).filter((reference) => reference && availableEvidence.has(reference)))];
	if (evidenceRefs.length === 0) return undefined;
	const normalized = {
		kind: "propose" as const,
		action: requiredText(decision.action, "Initiative action", 10_000),
		expectedValue: decision.expectedValue,
		risk: decision.risk,
		rationale: requiredText(decision.rationale, "Initiative rationale", 10_000),
		intendedVerification: requiredText(decision.intendedVerification, "Initiative verification", 10_000),
		evidenceRefs,
		confidence: decision.confidence,
		...(decision.relatedObjectiveId ? { relatedObjectiveId: requiredText(decision.relatedObjectiveId, "Initiative related Objective", 512) } : {}),
	};
	if (containsCredentialMaterial(JSON.stringify(normalized))) return undefined;
	return normalized;
}

function fallbackUnderstanding(prompt: string): TurnUnderstanding {
	return { action: "query", goal: prompt, constraints: ["Observe only; do not execute actions or notify"], acceptanceCriteria: [], memoryQuery: prompt, capabilityQuery: prompt, executionMode: "direct", confidence: 0.5 };
}
function seedSituation(trigger: InitiativeTrigger, activeObjectives: TaskRecord[]): Situation {
	return {
		summary: trigger.prompt,
		goals: [trigger.prompt],
		constraints: ["Observe only; do not execute actions or notify"],
		uncertainties: [],
		relevantMemoryIds: [],
		relevantTaskIds: activeObjectives.map((objective) => objective.id),
		observations: [{ statement: `Initiative trigger ${trigger.kind} occurred`, source: { kind: "tool", reference: trigger.id }, confidence: 1, trust: "observed" }],
		possibleActions: [],
		confidence: 0.5,
	};
}
function canonical(value: string): string { return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim(); }
function requiredText(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`${label} must be between 1 and ${maxLength} characters`);
	return value.trim();
}

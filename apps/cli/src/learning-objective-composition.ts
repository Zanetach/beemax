import { createHash } from "node:crypto";
import {
	createSituation,
	type LearningObjectiveAdmissionResult,
	type LearningObjectiveClaim,
	type ProactiveCapability,
	type ProactiveInvestigationCandidate,
	type ProactiveInvestigationRuntime,
} from "@thruvera/core";

export interface LearningObjectiveCompositionOptions {
	allowsReadOnlyInvestigation: () => boolean;
	runtime: Pick<ProactiveInvestigationRuntime, "consider">;
	capabilities: readonly ProactiveCapability[];
	now?: () => number;
}

/** Admits Memory Learning work only through the existing governed read-only Objective runtime. */
export async function admitLearningObjective(
	claim: LearningObjectiveClaim,
	options: LearningObjectiveCompositionOptions,
): Promise<LearningObjectiveAdmissionResult> {
	if (!options.allowsReadOnlyInvestigation()) return { status: "deferred", reasonCode: "read_only_investigation_disabled" };
	if (!options.capabilities.length) return { status: "deferred", reasonCode: "read_only_capability_unavailable" };
	const at = (options.now ?? Date.now)();
	const candidate = learningObjectiveInvestigationCandidate(claim, options.capabilities, at);
	const result = await options.runtime.consider(candidate, at);
	if (result.kind === "admitted") return { status: "admitted", objectiveId: result.objective.id };
	if (result.kind === "active_updated" || result.kind === "existing_terminal") return { status: "existing", objectiveId: result.objective.id };
	return { status: "deferred", reasonCode: "read_only_investigation_rejected" };
}

export function learningObjectiveInvestigationCandidate(
	claim: LearningObjectiveClaim,
	capabilities: readonly ProactiveCapability[],
	at: number,
): ProactiveInvestigationCandidate {
	if (!Number.isSafeInteger(at) || at < 0) throw new Error("Learning Objective composition time is invalid");
	if (!claim.scope.chatType) throw new Error("Learning Objective has no routable conversation type");
	const route = decodeMemoryPlatform(claim.scope.platform);
	const scope = {
		profileId: claim.profileId,
		platform: route.platform,
		...(route.channelInstanceId ? { channelInstanceId: route.channelInstanceId } : {}),
		chatId: claim.scope.chatId,
		...(claim.scope.userId ? { userId: claim.scope.userId } : {}),
		...(claim.scope.threadId ? { threadId: claim.scope.threadId } : {}),
	};
	const executionScope = {
		platform: route.platform,
		...(route.channelInstanceId ? { channelInstanceId: route.channelInstanceId } : {}),
		chatId: claim.scope.chatId,
		chatType: claim.scope.chatType,
		...(claim.scope.userId ? { userId: claim.scope.userId } : {}),
		...(claim.scope.threadId ? { threadId: claim.scope.threadId } : {}),
	};
	const situation = createSituation({
		summary: `A retained, evidence-backed capability gap requires read-only investigation: ${claim.statement}`,
		goals: [claim.statement],
		constraints: ["Use only admitted read-only capabilities", "Do not install software, mutate external state, or infer missing authority"],
		uncertainties: [claim.statement],
		relevantMemoryIds: [claim.proposalId, claim.observationId],
		observations: [{ statement: claim.statement, source: { kind: "memory", reference: claim.observationId }, evidenceRef: claim.observationId, confidence: claim.confidence, trust: "observed" }],
		possibleActions: [{ description: `Investigate the capability gap: ${claim.statement}`, expectedOutcome: claim.intendedVerification, reversible: true }],
		confidence: claim.confidence,
	});
	const dedupeKey = learningObjectiveDedupeKey(claim);
	return {
		observation: {
			id: `learning_observation:${dedupeKey}`,
			dedupeKey,
			triggerKind: "learning_signal",
			triggerId: claim.proposalId,
			scope,
			situation,
			action: `Investigate the capability gap: ${claim.statement}`,
			expectedValue: claim.confidence,
			risk: "low",
			rationale: `The gap is supported by retained evidence ${claim.observationId}.`,
			intendedVerification: claim.intendedVerification,
			evidenceRefs: [...claim.evidenceRefs],
			confidence: claim.confidence,
			mode: "observe_only",
			disposition: "new_candidate",
			notificationEmitted: false,
			observedAt: at,
			repeatCount: 1,
			feedback: "unreviewed",
			createdAt: at,
			lastObservedAt: at,
		},
		executionScope,
		capabilities: [...capabilities],
	};
}

export function learningObjectiveDedupeKey(claim: Pick<LearningObjectiveClaim, "profileId" | "proposalId" | "proposalDigest">): string {
	return createHash("sha256").update([claim.profileId, claim.proposalId, claim.proposalDigest].join("\0")).digest("hex");
}

function decodeMemoryPlatform(value: string): { platform: string; channelInstanceId?: string } {
	const separator = value.lastIndexOf("@");
	if (separator <= 0 || separator === value.length - 1) return { platform: value };
	return { platform: value.slice(0, separator), channelInstanceId: value.slice(separator + 1) };
}

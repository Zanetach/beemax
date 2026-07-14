export type GroupAdmissionPolicy = "open" | "allowlist" | "blacklist" | "admin_only" | "disabled";
export type GroupActivationMode = "disabled" | "explicit" | "contextual" | "ambient";
export type GroupActivationSignal = "mention" | "reply" | "active_thread" | "command";

export interface GroupAdmissionInput {
	policy: GroupAdmissionPolicy;
	actorIds: readonly string[];
	actorAuthorized: boolean;
	actorIsAdmin: boolean;
	allowlist?: readonly string[];
	blacklist?: readonly string[];
	requireMention: boolean;
	agentMentioned: boolean;
}

export type GroupAdmissionDecision =
	| { admitted: true; activation: "mention" | "ambient" }
	| { admitted: false; reason: "group_disabled" | "actor_blocked" | "actor_not_allowed" | "admin_required" | "mention_required" };

export interface GroupActivationInput extends Omit<GroupAdmissionInput, "requireMention" | "agentMentioned"> {
	mode: GroupActivationMode;
	respondTo: readonly GroupActivationSignal[];
	signals: Partial<Record<GroupActivationSignal, boolean>>;
	ambientObservation?: boolean;
}

export type GroupActivationDecision =
	| { admitted: true; action: "respond" | "observe"; activation: GroupActivationSignal | "ambient" }
	| { admitted: false; reason: "group_disabled" | "actor_blocked" | "actor_not_allowed" | "admin_required" | "activation_required" };
type GroupAccessDenial = { admitted: false; reason: "group_disabled" | "actor_blocked" | "actor_not_allowed" | "admin_required" };

/** Transport-neutral group admission. Platform adapters supply verified identity and mention facts only. */
export function decideGroupAdmission(input: GroupAdmissionInput): GroupAdmissionDecision {
	const access = decideGroupAccess(input);
	if (access) return access;
	if (input.requireMention && !input.agentMentioned) return { admitted: false, reason: "mention_required" };
	return { admitted: true, activation: input.agentMentioned ? "mention" : "ambient" };
}

/** Transport-neutral activation after authenticated access facts have been normalized. */
export function decideGroupActivation(input: GroupActivationInput): GroupActivationDecision {
	if (input.mode === "disabled") return { admitted: false, reason: "group_disabled" };
	const access = decideGroupAccess(input);
	if (access) return access;
	for (const signal of ["command", "mention", "reply", "active_thread"] as const) {
		if (input.signals[signal] && input.respondTo.includes(signal)) return { admitted: true, action: "respond", activation: signal };
	}
	if (input.mode === "ambient") return { admitted: true, action: "respond", activation: "ambient" };
	if (input.mode === "contextual" && input.ambientObservation) return { admitted: true, action: "observe", activation: "ambient" };
	return { admitted: false, reason: "activation_required" };
}

function decideGroupAccess(input: Pick<GroupAdmissionInput, "policy" | "actorIds" | "actorAuthorized" | "actorIsAdmin" | "allowlist" | "blacklist">): GroupAccessDenial | undefined {
	if (input.policy === "disabled") return { admitted: false, reason: "group_disabled" };
	if (input.policy === "blacklist" && intersects(input.actorIds, input.blacklist)) return { admitted: false, reason: "actor_blocked" };
	if (input.policy === "allowlist" && !input.actorAuthorized && !intersects(input.actorIds, input.allowlist)) return { admitted: false, reason: "actor_not_allowed" };
	if (input.policy === "admin_only" && !input.actorIsAdmin) return { admitted: false, reason: "admin_required" };
	return undefined;
}

function intersects(actorIds: readonly string[], configured: readonly string[] | undefined): boolean {
	return Boolean(configured?.some((id) => actorIds.includes(id)));
}

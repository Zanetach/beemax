export type GroupAdmissionPolicy = "open" | "allowlist" | "blacklist" | "admin_only" | "disabled";

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

/** Transport-neutral group admission. Platform adapters supply verified identity and mention facts only. */
export function decideGroupAdmission(input: GroupAdmissionInput): GroupAdmissionDecision {
	if (input.policy === "disabled") return { admitted: false, reason: "group_disabled" };
	if (input.policy === "blacklist" && intersects(input.actorIds, input.blacklist)) return { admitted: false, reason: "actor_blocked" };
	if (input.policy === "allowlist" && !input.actorAuthorized && !intersects(input.actorIds, input.allowlist)) {
		return { admitted: false, reason: "actor_not_allowed" };
	}
	if (input.policy === "admin_only" && !input.actorIsAdmin) return { admitted: false, reason: "admin_required" };
	if (input.requireMention && !input.agentMentioned) return { admitted: false, reason: "mention_required" };
	return { admitted: true, activation: input.agentMentioned ? "mention" : "ambient" };
}

function intersects(actorIds: readonly string[], configured: readonly string[] | undefined): boolean {
	return Boolean(configured?.some((id) => actorIds.includes(id)));
}

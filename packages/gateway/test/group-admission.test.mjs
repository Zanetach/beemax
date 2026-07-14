import assert from "node:assert/strict";
import test from "node:test";
import { decideGroupActivation, decideGroupAdmission } from "../dist/index.js";

test("group admission keeps transport identity outside policy decisions", () => {
	assert.deepEqual(decideGroupAdmission({
		policy: "allowlist",
		actorIds: ["open-id", "union-id"],
		allowlist: ["union-id"],
		requireMention: true,
		agentMentioned: true,
		actorAuthorized: false,
		actorIsAdmin: false,
	}), { admitted: true, activation: "mention" });
});

test("group admission denies disabled, blocked, unauthorized, non-admin, and unmentioned actors with stable reasons", () => {
	const base = { actorIds: ["user"], requireMention: false, agentMentioned: false, actorAuthorized: false, actorIsAdmin: false };
	assert.equal(decideGroupAdmission({ ...base, policy: "disabled" }).reason, "group_disabled");
	assert.equal(decideGroupAdmission({ ...base, policy: "blacklist", blacklist: ["user"] }).reason, "actor_blocked");
	assert.equal(decideGroupAdmission({ ...base, policy: "allowlist", allowlist: [] }).reason, "actor_not_allowed");
	assert.equal(decideGroupAdmission({ ...base, policy: "admin_only" }).reason, "admin_required");
	assert.equal(decideGroupAdmission({ ...base, policy: "open", requireMention: true }).reason, "mention_required");
});

test("globally authorized actors satisfy allowlist but never bypass blacklist or disabled policy", () => {
	const base = { actorIds: ["user"], requireMention: false, agentMentioned: false, actorAuthorized: true, actorIsAdmin: false };
	assert.equal(decideGroupAdmission({ ...base, policy: "allowlist", allowlist: [] }).admitted, true);
	assert.equal(decideGroupAdmission({ ...base, policy: "blacklist", blacklist: ["user"] }).admitted, false);
	assert.equal(decideGroupAdmission({ ...base, policy: "disabled" }).admitted, false);
});

test("contextual activation responds to verified signals and otherwise observes or ignores", () => {
	const base = {
		policy: "open", actorIds: ["user"], actorAuthorized: true, actorIsAdmin: false,
		mode: "contextual", respondTo: ["mention", "reply", "active_thread", "command"],
	};
	assert.deepEqual(decideGroupActivation({ ...base, signals: { reply: true } }), { admitted: true, action: "respond", activation: "reply" });
	assert.deepEqual(decideGroupActivation({ ...base, signals: {}, ambientObservation: true }), { admitted: true, action: "observe", activation: "ambient" });
	assert.deepEqual(decideGroupActivation({ ...base, signals: {}, ambientObservation: false }), { admitted: false, reason: "activation_required" });
});

test("explicit and disabled activation modes never become ambient responses", () => {
	const base = { policy: "open", actorIds: ["user"], actorAuthorized: true, actorIsAdmin: false, respondTo: ["mention", "command"] };
	assert.equal(decideGroupActivation({ ...base, mode: "explicit", signals: {} }).reason, "activation_required");
	assert.deepEqual(decideGroupActivation({ ...base, mode: "explicit", signals: { command: true } }), { admitted: true, action: "respond", activation: "command" });
	assert.equal(decideGroupActivation({ ...base, mode: "disabled", signals: { mention: true } }).reason, "group_disabled");
});

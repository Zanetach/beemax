import assert from "node:assert/strict";
import test from "node:test";
import { AutonomyRolloutController, AUTONOMY_LEVELS, createEnterprisePolicyPublisher, guardVerifiedObjectiveMemoryPublisher } from "../dist/index.js";

const passingEvidence = {
	situationPrecision: 1,
	correctionRetention: 1,
	unauthorizedRetrievals: 0,
	verifiedCompletionRate: 1,
	initiativePrecision: 0.8,
	initiativeAverageExpectedValue: 0.8,
	duplicateInitiatives: 0,
	initiativeInterruptionRate: 0.02,
	readOnlyPrecision: 0.8,
	readOnlyAdoptionRate: 0.7,
	readOnlyInterruptionRate: 0.03,
	duplicateReadOnlyObjectives: 0,
	proactivePolicyScopeCoverage: 1,
	emergencyStopBlockRate: 1,
	compensationSuccessRate: 1,
	duplicateCompensations: 0,
	highRiskAutonomousActions: 0,
	irreversibleAutonomousActions: 0,
};

function stateStore() {
	const records = new Map();
	return {
		records,
		read(level) { return records.get(level); },
		write(record) { records.set(record.level, structuredClone(record)); },
	};
}

const enterprisePublisher = createEnterprisePolicyPublisher({ id: "enterprise:admin", authority: { kind: "administrator_grant", reference: "admin:1" }, evidenceRef: "admin:audit:1", issuedAt: 1 });

test("autonomy levels promote only with measured quality, safety, value, and interruption evidence", () => {
	const store = stateStore();
	const rollout = new AutonomyRolloutController({ store, evidence: () => passingEvidence });
	for (const level of AUTONOMY_LEVELS) {
		const decision = rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:release-1" }, 1_000);
		assert.equal(decision.outcome, "promoted", `${level}: ${decision.reasons.join(", ")}`);
	}
	assert.deepEqual(rollout.snapshot().map(({ level, status }) => ({ level, status })), AUTONOMY_LEVELS.map((level) => ({ level, status: "enabled" })));
});

test("one autonomy level can be stopped without disabling lower independent cognition", () => {
	const store = stateStore();
	const rollout = new AutonomyRolloutController({ store, evidence: () => passingEvidence });
	for (const level of AUTONOMY_LEVELS) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:release-1" }, 1_000);

	assert.equal(rollout.stop("read_only_investigation", { actor: "enterprise", publisher: enterprisePublisher, evidenceRef: "policy:pause" }, 2_000).status, "stopped");
	assert.equal(rollout.allows("situation_context").allowed, true);
	assert.equal(rollout.allows("episode_publication").allowed, true);
	assert.equal(rollout.allows("initiative_observation").allowed, true);
	assert.equal(rollout.allows("read_only_investigation").allowed, false);
	assert.equal(rollout.allows("reversible_action").allowed, false, "a stopped dependency must fail closed downstream");
	assert.equal(rollout.resume("read_only_investigation", { actor: "operator", evidenceRef: "evaluation:release-2" }, 3_000).outcome, "promoted");
	assert.equal(rollout.allows("reversible_action").allowed, true);
	assert.equal(rollout.rollback("reversible_action", { actor: "enterprise", publisher: enterprisePublisher, evidenceRef: "release:rollback" }, 4_000).reasons[0], "explicitly rolled back");
	assert.equal(rollout.allows("reversible_action").allowed, false);
	assert.equal(rollout.allows("read_only_investigation").allowed, true);
});

test("enterprise deny overrides promotion but enterprise allow cannot bypass failed evidence", () => {
	const store = stateStore();
	const rollout = new AutonomyRolloutController({ store, evidence: () => ({ ...passingEvidence, readOnlyAdoptionRate: 0.2 }) });
	for (const level of ["situation_context", "episode_publication", "initiative_observation"]) rollout.promote(level, { actor: "operator", evidenceRef: "evaluation:release-1" }, 1_000);
	const rejected = rollout.promote("read_only_investigation", { actor: "enterprise", publisher: enterprisePublisher, evidenceRef: "policy:allow", enterpriseDisposition: "allow" }, 2_000);
	assert.equal(rejected.outcome, "rejected");
	assert.match(rejected.reasons.join(" "), /adoption/i);

	const safe = new AutonomyRolloutController({ store: stateStore(), evidence: () => passingEvidence });
	for (const level of AUTONOMY_LEVELS) safe.promote(level, { actor: "operator", evidenceRef: "evaluation:release-1" }, 1_000);
	assert.equal(safe.allows("initiative_observation", { enterpriseDisposition: "deny", publisher: enterprisePublisher, evidenceRef: "policy:deny" }).allowed, false);
});

test("high-risk and irreversible autonomy are not rollout levels", () => {
	assert.deepEqual(AUTONOMY_LEVELS, ["situation_context", "episode_publication", "initiative_observation", "read_only_investigation", "reversible_action"]);
	const rollout = new AutonomyRolloutController({ store: stateStore(), evidence: () => passingEvidence });
	assert.throws(() => rollout.promote("high_risk_action", { actor: "operator", evidenceRef: "invalid" }), /unknown autonomy level/i);
	assert.throws(() => rollout.promote("irreversible_action", { actor: "operator", evidenceRef: "invalid" }), /unknown autonomy level/i);
});

test("verified Episode publication is guarded once at the shared publisher boundary", async () => {
	const store = stateStore();
	const rollout = new AutonomyRolloutController({ store, evidence: () => passingEvidence });
	const published = [];
	const guarded = guardVerifiedObjectiveMemoryPublisher(rollout, async (outcome) => published.push(outcome.objectiveId));
	await guarded({ objectiveId: "objective:disabled", title: "disabled", result: "none" });
	assert.deepEqual(published, []);
	rollout.promote("situation_context", { actor: "operator", evidenceRef: "evaluation:1" });
	rollout.promote("episode_publication", { actor: "operator", evidenceRef: "evaluation:1" });
	await guarded({ objectiveId: "objective:enabled", title: "enabled", result: "verified" });
	assert.deepEqual(published, ["objective:enabled"]);
});

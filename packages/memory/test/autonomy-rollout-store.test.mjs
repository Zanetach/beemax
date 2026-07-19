import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutonomyRolloutController, createEnterprisePolicyPublisher } from "../../core/dist/index.js";
import { MemoryStore, memoryPersistencePorts } from "../dist/index.js";

const evidence = {
	situationPrecision: 1, correctionRetention: 1, unauthorizedRetrievals: 0, verifiedCompletionRate: 1,
	memoryPromotionPrecision: 1, scopedRecallAt5: 0.95, memoryAttributionAccuracy: 0.95, memoryDowngradePrecision: 0.96,
	memoryFalseDowngradeRate: 0.01, memoryNegativeTransferRate: 0.01, memoryProvenanceCoverage: 1,
	initiativePrecision: 0.8, initiativeAverageExpectedValue: 0.8, duplicateInitiatives: 0, initiativeInterruptionRate: 0.02,
	readOnlyPrecision: 0.8, readOnlyAdoptionRate: 0.7, readOnlyInterruptionRate: 0.03, duplicateReadOnlyObjectives: 0,
	proactivePolicyScopeCoverage: 1, emergencyStopBlockRate: 1, compensationSuccessRate: 1, duplicateCompensations: 0,
	highRiskAutonomousActions: 0, irreversibleAutonomousActions: 0,
};
const publisher = createEnterprisePolicyPublisher({ id: "enterprise:admin", authority: { kind: "administrator_grant", reference: "admin:1" }, evidenceRef: "admin:audit:1", issuedAt: 1 });

test("autonomy rollout state survives restart and rejects stale writers", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-autonomy-rollout-"));
	const path = join(root, "memory.db");
	const first = new MemoryStore(path, "profile-a");
	const stale = new MemoryStore(path, "profile-a");
	try {
		const firstPort = memoryPersistencePorts(first).autonomyRollout;
		const stalePort = memoryPersistencePorts(stale).autonomyRollout;
		const rollout = new AutonomyRolloutController({ store: firstPort, evidence: () => evidence });
		assert.equal(rollout.promote("situation_context", { actor: "operator", evidenceRef: "evaluation:1" }, 100).outcome, "promoted");
		const staleRecord = stalePort.read("situation_context");
		assert.equal(staleRecord.revision, 1);
		assert.equal(rollout.stop("situation_context", { actor: "enterprise", publisher, evidenceRef: "incident:1" }, 200).revision, 2);
		assert.throws(() => stalePort.write({ ...staleRecord, status: "enabled", revision: 2, updatedAt: 150 }), /stale autonomy rollout write/i);
	} finally {
		stale.close();
		first.close();
	}

	const reopened = new MemoryStore(path, "profile-a");
	try {
		assert.deepEqual(memoryPersistencePorts(reopened).autonomyRollout.read("situation_context"), {
			level: "situation_context", status: "stopped", revision: 2, updatedAt: 200,
			authority: { actor: "enterprise", publisher, evidenceRef: "incident:1" }, reasons: ["explicitly stopped"], evidence,
		});
	} finally {
		reopened.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("adaptive learning rollout state persists through the Profile Memory authority", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-adaptive-learning-rollout-"));
	const path = join(root, "memory.db");
	try {
		const first = new MemoryStore(path, "profile-a");
		const rollout = new AutonomyRolloutController({ store: memoryPersistencePorts(first).autonomyRollout, evidence: () => evidence });
		assert.equal(rollout.promote("situation_context", { actor: "operator", evidenceRef: "evaluation:l4" }, 100).outcome, "promoted");
		assert.equal(rollout.promote("episode_publication", { actor: "operator", evidenceRef: "evaluation:l4" }, 101).outcome, "promoted");
		assert.equal(rollout.promote("adaptive_learning", { actor: "operator", evidenceRef: "evaluation:l4" }, 102).outcome, "promoted");
		first.close();
		const reopened = new MemoryStore(path, "profile-a");
		assert.equal(memoryPersistencePorts(reopened).autonomyRollout.read("adaptive_learning")?.status, "enabled");
		reopened.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

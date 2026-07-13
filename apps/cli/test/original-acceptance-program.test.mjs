import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(script) {
	const result = spawnSync(process.execPath, [script], {
		cwd: new URL("../../..", import.meta.url),
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
	return JSON.parse(result.stdout);
}

test("P0-P10 architecture contraction is enforced by one reproducible release gate", () => {
	const report = run("scripts/evaluate-architecture.mjs");
	assert.equal(report.gate.passed, true);
	assert.deepEqual(report.gate.failures, []);
	assert.deepEqual(report.invariants, {
		customerOntologyInCore: 0,
		fixedBusinessOntologyInProduction: 0,
		legacyBusinessContextRuntimeConsumers: 0,
		profileWorkCompositionCallers: 1,
		channelProfileRuntimeCallers: 2,
		channelProfileRuntimeCoverageViolations: 0,
		parserFixtureViolations: 0,
		protectedAuthorityConstructionViolations: 0,
		memoryImplementationImportsOutsideComposition: 0,
	});
});

test("P0-P10 migration rehearsal restores pre-upgrade responsibility without retaining post-backup writes", () => {
	const report = run("scripts/rehearse-migration-rollback.mjs");
	assert.equal(report.gate.passed, true);
	assert.deepEqual(report.gate.failures, []);
	assert.deepEqual(report.rehearsal, {
		legacySourcePreserved: true,
		legacyTaskMigrated: true,
		backupIntegrityVerified: true,
		preBackupResponsibilityRestored: true,
		postBackupWriteExcluded: true,
		rollbackDatabaseReopened: true,
	});
});

test("every original P0-P10 program has declared reproducible evidence and every TBD is resolved or deferred", () => {
	const report = run("scripts/evaluate-acceptance-program.mjs");
	assert.equal(report.gate.passed, true);
	assert.deepEqual(report.programs, ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"]);
	assert.equal(report.unresolvedTbd.length, 0);
	assert.deepEqual(report.metrics.deferred, ["live-user-intervention-reduction", "live-repeated-question-rate", "provider-latency-token-cache-and-usd"]);
	assert.equal(report.metrics.evidenced.length, 8);
});

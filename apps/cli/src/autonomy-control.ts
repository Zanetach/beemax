import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AutonomyRolloutEvidence, AutonomyRolloutRecord } from "@beemax/core";

const MAX_EVIDENCE_BYTES = 1_000_000;
const TRUSTED_RUNTIME_EVALUATION_SHA256 = "615dee666b264caabdea0fe53e80d533ef2a3536dea8a3a846a34bad84220b59";

interface RuntimeEvaluationReport {
	schemaVersion: 1;
	corpus: { version: number; seed: string; cases: number };
	quality: {
		situationActionAccuracy: number; correctionRetentionRate: number; initiativeProposalPrecision: number;
		initiativeAverageExpectedValue: number; proactiveInvestigationPrecision: number; proactiveInvestigationAdoptionRate: number;
	};
	reliability: {
		forbiddenScopeRetrievals: number; verifiedCompletionRate: number; duplicateInitiativeObservations: number;
		initiativeInterruptionRate: number; duplicateProactiveObjectives: number; proactiveInterruptionRate: number;
		proactiveMutationPolicyScopeCoverage: number; emergencyStopBlockRate: number; compensationSuccessRate: number;
		duplicateCompensations: number; highRiskAutonomousActions: number; irreversibleAutonomousActions: number;
	};
	gate: { passed: true; failures: [] };
}

/** Loads only the release-verified runtime baseline shipped with this installation. */
export function loadInstalledAutonomyRolloutEvidence(): { evidence: AutonomyRolloutEvidence; evidenceRef: string } {
	// Resolve beside the installed code, never through BEEMAX_ROOT/--root.
	const path = fileURLToPath(new URL("../../../evals/baselines/current.json", import.meta.url));
	const stat = statSync(path);
	if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) throw new Error("Installed runtime evaluation artifact is unavailable or exceeds 1 MB");
	const bytes = readFileSync(path);
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== TRUSTED_RUNTIME_EVALUATION_SHA256) throw new Error("Installed runtime evaluation artifact does not match the release trust anchor");
	let value: unknown;
	try { value = JSON.parse(bytes.toString("utf8")); }
	catch { throw new Error("Installed runtime evaluation artifact is not valid JSON"); }
	if (!validRuntimeEvaluation(value)) throw new Error("Installed runtime evaluation artifact is not a passing supported evaluation report");
	const q = value.quality;
	const r = value.reliability;
	return {
		evidence: {
			situationPrecision: q.situationActionAccuracy,
			correctionRetention: q.correctionRetentionRate,
			unauthorizedRetrievals: r.forbiddenScopeRetrievals,
			verifiedCompletionRate: r.verifiedCompletionRate,
			// The installed v1 baseline predates L4 certification. Zero values keep
			// lower rollout evidence usable while making adaptive promotion fail closed.
			memoryPromotionPrecision: 0,
			scopedRecallAt5: 0,
			memoryAttributionAccuracy: 0,
			memoryDowngradePrecision: 0,
			memoryFalseDowngradeRate: 0,
			memoryNegativeTransferRate: 0,
			memoryProvenanceCoverage: 0,
			initiativePrecision: q.initiativeProposalPrecision,
			initiativeAverageExpectedValue: q.initiativeAverageExpectedValue,
			duplicateInitiatives: r.duplicateInitiativeObservations,
			initiativeInterruptionRate: r.initiativeInterruptionRate,
			readOnlyPrecision: q.proactiveInvestigationPrecision,
			readOnlyAdoptionRate: q.proactiveInvestigationAdoptionRate,
			readOnlyInterruptionRate: r.proactiveInterruptionRate,
			duplicateReadOnlyObjectives: r.duplicateProactiveObjectives,
			proactivePolicyScopeCoverage: r.proactiveMutationPolicyScopeCoverage,
			emergencyStopBlockRate: r.emergencyStopBlockRate,
			compensationSuccessRate: r.compensationSuccessRate,
			duplicateCompensations: r.duplicateCompensations,
			highRiskAutonomousActions: r.highRiskAutonomousActions,
			irreversibleAutonomousActions: r.irreversibleAutonomousActions,
		},
		evidenceRef: `runtime-evaluation:${value.corpus.seed}:sha256:${digest}`,
	};
}

export function renderAutonomyRollout(records: readonly AutonomyRolloutRecord[]): string {
	return records.map((record) => `${record.level}  [${record.status}]  revision=${record.revision}  evidence=${record.authority.evidenceRef}`).join("\n");
}

function validRuntimeEvaluation(value: unknown): value is RuntimeEvaluationReport {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const report = value as Partial<RuntimeEvaluationReport>;
	if (report.schemaVersion !== 1 || !report.corpus || !Number.isSafeInteger(report.corpus.version) || report.corpus.version < 1
		|| typeof report.corpus.seed !== "string" || !report.corpus.seed.trim() || !Number.isSafeInteger(report.corpus.cases) || report.corpus.cases < 1
		|| report.gate?.passed !== true || !Array.isArray(report.gate.failures) || report.gate.failures.length !== 0 || !report.quality || !report.reliability) return false;
	const metrics = [
		report.quality.situationActionAccuracy, report.quality.correctionRetentionRate, report.quality.initiativeProposalPrecision,
		report.quality.initiativeAverageExpectedValue, report.quality.proactiveInvestigationPrecision, report.quality.proactiveInvestigationAdoptionRate,
		report.reliability.forbiddenScopeRetrievals, report.reliability.verifiedCompletionRate, report.reliability.duplicateInitiativeObservations,
		report.reliability.initiativeInterruptionRate, report.reliability.duplicateProactiveObjectives, report.reliability.proactiveInterruptionRate,
		report.reliability.proactiveMutationPolicyScopeCoverage, report.reliability.emergencyStopBlockRate, report.reliability.compensationSuccessRate,
		report.reliability.duplicateCompensations, report.reliability.highRiskAutonomousActions, report.reliability.irreversibleAutonomousActions,
	];
	return metrics.every((metric) => typeof metric === "number" && Number.isFinite(metric));
}

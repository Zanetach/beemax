#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(resolve(root, "evals/original-acceptance-program.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const expectedPrograms = Array.from({ length: 11 }, (_, index) => `P${index}`);
const expectedMetrics = [
	["situation-and-vocabulary-quality", "evidenced"],
	["capability-top-5", "evidenced"],
	["organization-recall-correction-and-conflict", "evidenced"],
	["scope-and-action-isolation", "evidenced"],
	["verified-completion-and-effect-replay", "evidenced"],
	["runtime-latency-and-deterministic-cost", "evidenced"],
	["initiative-offline-precision-and-safety", "evidenced"],
	["initiative-duplicate-and-interruption", "evidenced"],
	["live-user-intervention-reduction", "deferred"],
	["live-repeated-question-rate", "deferred"],
	["provider-latency-token-cache-and-usd", "deferred"],
];
const requiredEvidencedMetricContract = {
	"situation-and-vocabulary-quality": { command: "npm run eval:runtime", evidence: "evals/baselines/current.json", assertions: [{ path: "quality.situationActionAccuracy", operator: "gte", value: 0.98 }, { path: "quality.situationVocabularyRetention", operator: "gte", value: 0.98 }] },
	"capability-top-5": { command: "npm run eval:runtime", evidence: "evals/baselines/current.json", assertions: [{ path: "quality.capabilityTop5HitRate", operator: "gte", value: 0.98 }] },
	"organization-recall-correction-and-conflict": { command: "npm run eval:runtime", evidence: "evals/baselines/current.json", assertions: [{ path: "quality.organizationRecallPrecision", operator: "gte", value: 0.98 }, { path: "quality.correctionRetentionRate", operator: "gte", value: 0.98 }, { path: "quality.conflictVisibilityRate", operator: "gte", value: 0.98 }] },
	"scope-and-action-isolation": { command: "npm run eval:runtime", evidence: "evals/baselines/current.json", assertions: [{ path: "reliability.forbiddenScopeRetrievals", operator: "eq", value: 0 }, { path: "reliability.highRiskAutonomousActions", operator: "eq", value: 0 }, { path: "reliability.irreversibleAutonomousActions", operator: "eq", value: 0 }] },
	"verified-completion-and-effect-replay": { command: "npm run eval:reliability", evidence: "evals/baselines/current.json", assertions: [{ path: "reliability.verifiedCompletionRate", operator: "eq", value: 1 }, { path: "reliability.sideEffectCases", operator: "gte", value: 1 }, { path: "reliability.blockedSideEffectReplays", operator: "eqPath", value: "reliability.sideEffectCases" }] },
	"runtime-latency-and-deterministic-cost": { command: "npm run eval:performance:ci", evidence: "evals/baselines/performance-apple-m5-32gb.json", assertions: [{ path: "assessment.passed", operator: "eq", value: true }, { path: "assessment.paths.fast.samples", operator: "gte", value: 101 }, { path: "assessment.paths.deep.samples", operator: "gte", value: 101 }, { path: "assessment.paths.background.samples", operator: "gte", value: 101 }, { path: "assessment.paths.deep.backpressureEvents", operator: "eq", value: 0 }] },
	"initiative-offline-precision-and-safety": { command: "npm run eval:runtime", evidence: "evals/baselines/current.json", assertions: [{ path: "quality.initiativeProposalPrecision", operator: "gte", value: 0.6 }, { path: "quality.proactiveInvestigationAdoptionRate", operator: "gte", value: 0.6 }, { path: "reliability.proactiveMutationPolicyScopeCoverage", operator: "eq", value: 1 }] },
	"initiative-duplicate-and-interruption": { command: "npm run eval:runtime", evidence: "evals/baselines/current.json", assertions: [{ path: "reliability.duplicateInitiativeObservations", operator: "eq", value: 0 }, { path: "reliability.duplicateProactiveObjectives", operator: "eq", value: 0 }, { path: "reliability.proactiveInterruptionRate", operator: "eq", value: 0 }] },
};
const requiredProgramContract = {
	P0: { commands: ["npm run eval:runtime"], evidence: ["evals/baselines/current.json"] },
	P1: { commands: ["npm test"], evidence: ["packages/core/test/action-governance.test.mjs"] },
	P2: { commands: ["npm test"], evidence: ["packages/core/test/execution-envelope.test.mjs"] },
	P3: { commands: ["npm run eval:reliability"], evidence: ["apps/cli/test/reliability-fault-release-gate.test.mjs"] },
	P4: { commands: ["npm run eval:runtime"], evidence: ["packages/core/test/capability-runtime.test.mjs"] },
	P5: { commands: ["npm test"], evidence: ["packages/core/test/task-checkpoint.test.mjs"] },
	P6: { commands: ["npm run eval:runtime"], evidence: ["packages/memory/test/p6-memory-acceptance.test.mjs"] },
	P7: { commands: ["npm run eval:reliability"], evidence: ["packages/memory/test/p7-task-recovery-acceptance.test.mjs"] },
	P8: { commands: ["npm test"], evidence: ["apps/cli/test/channel-runtime-equivalence.test.mjs"] },
	P9: { commands: ["npm run eval:architecture"], evidence: ["scripts/evaluate-architecture.mjs"] },
	P10: {
		commands: ["npm run eval:migration", "npm run eval:performance:ci", "npm run eval:security"],
		evidence: ["scripts/rehearse-migration-rollback.mjs", "apps/cli/test/security-acceptance-release-gate.test.mjs"],
	},
};
const programs = manifest.programs?.map((program) => program.id) ?? [];
const failures = [];

if (JSON.stringify(programs) !== JSON.stringify(expectedPrograms)) failures.push("Acceptance manifest must declare P0 through P10 exactly once and in order");
for (const program of manifest.programs ?? []) {
	if (!program.result?.trim()) failures.push(`${program.id} has no declared result`);
	if (!Array.isArray(program.commands) || program.commands.length === 0) failures.push(`${program.id} has no reproducible command`);
	if (!Array.isArray(program.evidence) || program.evidence.length === 0) failures.push(`${program.id} has no evidence`);
	for (const path of program.evidence ?? []) {
		try { await access(resolve(root, path)); }
		catch { failures.push(`${program.id} evidence is missing: ${path}`); }
	}
	for (const command of program.commands ?? []) validateCommand(command, program.id);
	const contract = requiredProgramContract[program.id];
	for (const command of contract?.commands ?? []) if (!program.commands.includes(command)) failures.push(`${program.id} is missing required command: ${command}`);
	for (const evidence of contract?.evidence ?? []) if (!program.evidence.includes(evidence)) failures.push(`${program.id} is missing required evidence: ${evidence}`);
}

const declaredMetrics = (manifest.metrics ?? []).map((metric) => [metric.id, metric.status]);
if (JSON.stringify(declaredMetrics) !== JSON.stringify(expectedMetrics)) failures.push("Acceptance metrics must declare the closed required metric and deferral set exactly once and in order");
for (const metric of manifest.metrics ?? []) {
	if (metric.status === "evidenced") {
		const required = requiredEvidencedMetricContract[metric.id];
		if (!required || JSON.stringify({ command: metric.command, evidence: metric.evidence, assertions: metric.assertions }) !== JSON.stringify(required)) failures.push(`${metric.id} does not match its required evidence and threshold contract`);
		if (!metric.command?.trim() || !metric.evidence?.trim() || !Array.isArray(metric.assertions) || metric.assertions.length === 0) failures.push(`${metric.id} lacks a reproducible command, evidence artifact, or metric assertion`);
		else {
			validateCommand(metric.command, metric.id);
			try {
				const document = JSON.parse(await readFile(resolve(root, metric.evidence), "utf8"));
				for (const assertion of metric.assertions) validateMetricAssertion(metric.id, document, assertion);
			}
			catch { failures.push(`${metric.id} evidence is missing: ${metric.evidence}`); }
		}
	} else if (metric.status === "deferred") {
		if (!metric.reason?.trim() || !metric.exitCriteria?.trim()) failures.push(`${metric.id} is deferred without a reason and exit criteria`);
	} else failures.push(`${metric.id} has invalid status: ${metric.status}`);
}

function validateCommand(command, owner) {
	if (command === "npm test") return;
	const match = /^npm run ([a-z0-9:_-]+)$/.exec(command);
	if (!match || typeof packageJson.scripts?.[match[1]] !== "string") failures.push(`${owner} references an unavailable command: ${command}`);
}

function validateMetricAssertion(metricId, document, assertion) {
	const actual = valueAt(document, assertion.path);
	const expected = assertion.operator === "eqPath" ? valueAt(document, assertion.value) : assertion.value;
	const passed = assertion.operator === "eq" || assertion.operator === "eqPath" ? actual === expected
		: assertion.operator === "gte" ? typeof actual === "number" && actual >= expected
		: false;
	if (!passed) failures.push(`${metricId} assertion failed: ${assertion.path} ${assertion.operator} ${String(assertion.value)} (observed ${String(actual)})`);
}

function valueAt(document, path) { return String(path).split(".").reduce((value, key) => value?.[key], document); }

const interactionPrd = await readFile(resolve(root, "docs/architecture/interaction-runtime-prd.md"), "utf8");
const tbdRows = interactionPrd.split("\n").filter((line) => /^\| TBD-\d+ \|/.test(line));
const unresolvedTbd = tbdRows.filter((line) => !/已决策|正式暂缓|已延期/.test(line));
if (tbdRows.length === 0) failures.push("No original PRD TBD decisions were found");
if (unresolvedTbd.length) failures.push(`${unresolvedTbd.length} original PRD TBD decision(s) remain unresolved`);

console.log(JSON.stringify({
	schemaVersion: 1,
	programs,
	evidenceCount: (manifest.programs ?? []).reduce((sum, program) => sum + (program.evidence?.length ?? 0), 0),
	metrics: {
		evidenced: (manifest.metrics ?? []).filter((metric) => metric.status === "evidenced").map((metric) => metric.id),
		deferred: (manifest.metrics ?? []).filter((metric) => metric.status === "deferred").map((metric) => metric.id),
	},
	commandCount: new Set((manifest.programs ?? []).flatMap((program) => program.commands ?? [])).size,
	unresolvedTbd,
	gate: { passed: failures.length === 0, failures },
}, null, 2));
if (failures.length) process.exitCode = 1;

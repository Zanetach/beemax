import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { agentParityCorpus } from "../../../evals/agent-parity-corpus.mjs";
import { compareAgentParity, evaluateAgentRun, validatePinnedAgentRun } from "../../../evals/agent-parity-evaluation.mjs";
import { runAgentParityCorpus } from "../../../evals/agent-parity-runner.mjs";
import { digestTree } from "../../../evals/adapters/subprocess.mjs";

function run(system, overrides = {}) {
	return {
		schemaVersion: 1,
		system: { id: system, version: "pinned-1", model: "shared-model" },
		corpus: { version: agentParityCorpus.version, seed: agentParityCorpus.seed },
		environment: { platform: "test", arch: "test", node: process.version, osId: "test-os", osVersion: "1.0", machineProfile: "test", networkCondition: "isolated-fixture", networkEnforcement: "deterministic-fixture-adapter" },
		provenance: { mode: "same-model", corpusSha256: "sha256:corpus", fixtureSha256: "sha256:fixture", configurationSha256: "sha256:config", configurationContractSha256: "sha256:contract", targetManifestSha256: "sha256:manifest", caseTimeoutMs: 180_000 },
		cases: agentParityCorpus.cases.map((scenario, index) => ({
			id: scenario.id,
			status: "succeeded",
			durationMs: 100 + index,
			inputTokens: 20,
			outputTokens: 10,
			toolCalls: scenario.requiredCapabilities.map((name) => ({ name, status: "succeeded", argumentsValid: true, required: true })),
			evidenceKinds: [...scenario.requiredEvidenceKinds],
			userInterventions: 0,
			duplicateEffects: 0,
			objectiveDegraded: false,
			outcomeVerified: true,
			recovered: scenario.facets.includes("recovery") ? true : undefined,
			...overrides[scenario.id],
		})),
	};
}

test("parity evaluation scores one complete run through the public report contract", () => {
	const report = evaluateAgentRun(agentParityCorpus, run("thruvera"));
	assert.equal(report.corpus.cases, agentParityCorpus.cases.length);
	assert.equal(report.coverage.missingCases.length, 0);
	assert.equal(report.quality.endToEndSuccessRate, 1);
	assert.equal(report.routing.requiredCapabilityRecall, 1);
	assert.equal(report.routing.argumentValidityRate, 1);
	assert.equal(report.routing.argumentAssessmentRate, 1);
	assert.equal(report.routing.unnecessaryToolCallRate, 0);
	assert.equal(report.routing.toolNecessityAssessmentRate, 1);
	assert.equal(report.routing.toolCallSuccessRate, 1);
	assert.equal(report.routing.failedToolCalls, 0);
	assert.equal(report.verification.evidenceCoverageRate, 1);
	assert.equal(report.reliability.unauthorizedDowngrades, 0);
	assert.equal(report.reliability.duplicateEffects, 0);
	assert.equal(report.reliability.downgradeAssessmentRate, 1);
	assert.equal(report.reliability.effectAssessmentRate, 1);
	assert.equal(report.reliability.recoveryRate, 1);
	assert.equal(report.reliability.recoveryAssessmentRate, 1);
	assert.equal(report.cost.totalTokens, agentParityCorpus.cases.length * 30);
	assert.ok(report.performance.p95DurationMs >= 100);
});

test("parity evaluation reports unknown downgrade and Effect evidence as unassessed", () => {
	const unknown = run("codex");
	unknown.cases[0].objectiveDegraded = null;
	const effectCase = agentParityCorpus.cases.find((scenario) => scenario.facets.includes("external_effect") || scenario.requiredEvidenceKinds.includes("effect") || scenario.requiredEvidenceKinds.includes("delivery"));
	unknown.cases.find((scenario) => scenario.id === effectCase.id).duplicateEffects = null;
	const report = evaluateAgentRun(agentParityCorpus, unknown);
	assert.equal(report.reliability.downgradeAssessmentRate, (agentParityCorpus.cases.length - 1) / agentParityCorpus.cases.length);
	assert.equal(report.reliability.effectAssessmentRate, (report.reliability.effectCases - 1) / report.reliability.effectCases);
});

test("a model answer without required Capability and evidence receipts is not end-to-end success", () => {
	const unsupported = run("codex");
	const research = unsupported.cases.find((result) => result.id === "current-research");
	research.toolCalls = [];
	research.evidenceKinds = [];
	const report = evaluateAgentRun(agentParityCorpus, unsupported);
	assert.equal(report.quality.endToEndSuccessRate, (agentParityCorpus.cases.length - 1) / agentParityCorpus.cases.length);
	assert.deepEqual(report.caseOutcomes.find((outcome) => outcome.id === "current-research"), {
		id: "current-research", status: "succeeded", accepted: false, missingCapabilities: ["web_search"], missingEvidenceKinds: ["source"],
	});
});

test("parity evaluation rejects a run that does not use the exact pinned corpus", () => {
	const incomplete = run("thruvera");
	incomplete.cases.pop();
	assert.throws(() => evaluateAgentRun(agentParityCorpus, incomplete), /missing case/i);
	const foreign = run("thruvera");
	foreign.corpus.seed = "different";
	assert.throws(() => evaluateAgentRun(agentParityCorpus, foreign), /corpus identity/i);
});

test("parity comparison exposes per-dimension regressions instead of hiding them in an aggregate", () => {
	const routedCase = agentParityCorpus.cases.find((scenario) => scenario.requiredCapabilities.length && scenario.requiredEvidenceKinds.length);
	const effectCase = agentParityCorpus.cases.find((scenario) => scenario.facets.includes("external_effect") || scenario.requiredEvidenceKinds.includes("effect") || scenario.requiredEvidenceKinds.includes("delivery"));
	const candidate = run("thruvera", {
		[routedCase.id]: {
			status: "succeeded",
			durationMs: 500,
			inputTokens: 20,
			outputTokens: 10,
			toolCalls: [{ name: "wrong_tool", status: "failed", argumentsValid: false, required: false }],
			evidenceKinds: [],
			userInterventions: 0,
			objectiveDegraded: true,
		},
		[effectCase.id]: { duplicateEffects: 1 },
	});
	const comparison = compareAgentParity({ corpus: agentParityCorpus, candidate, baselines: [run("codex"), run("hermes")] });
	assert.equal(comparison.gate.passed, false);
	assert.ok(comparison.gate.failures.some((failure) => failure.includes("requiredCapabilityRecall")));
	assert.ok(comparison.gate.failures.some((failure) => failure.includes("evidenceCoverageRate")));
	assert.ok(comparison.gate.failures.some((failure) => failure.includes("unauthorizedDowngrades")));
	assert.ok(comparison.gate.failures.some((failure) => failure.includes("duplicateEffects")));
	assert.deepEqual(comparison.baselines.map((item) => item.system.id), ["codex", "hermes"]);
});

test("best-native comparison permits different pinned models without weakening metric gates", () => {
	const candidate = run("thruvera");
	candidate.system.model = "thruvera-native-model";
	candidate.provenance.mode = "best-native";
	const baseline = run("hermes");
	baseline.system.model = "hermes-native-model";
	baseline.provenance.mode = "best-native";
	const codex = run("codex");
	codex.system.model = "codex-native-model";
	codex.provenance.mode = "best-native";
	const comparison = compareAgentParity({ corpus: agentParityCorpus, candidate, baselines: [codex, baseline], requireExactModelIdentity: false });
	assert.equal(comparison.gate.passed, true);
	assert.equal(comparison.mode, "best-native");
});

test("parity comparison fixes candidate and baseline roles", () => {
	assert.throws(() => compareAgentParity({ corpus: agentParityCorpus, candidate: run("codex"), baselines: [run("thruvera"), run("hermes")] }), /candidate must be thruvera/i);
	assert.throws(() => compareAgentParity({ corpus: agentParityCorpus, candidate: run("thruvera"), baselines: [run("codex")] }), /exactly codex and hermes/i);
	assert.throws(() => compareAgentParity({ corpus: agentParityCorpus, candidate: run("thruvera"), baselines: [run("codex"), run("codex")] }), /exactly codex and hermes/i);
});

test("parity CLI rejects hand-authored reports that only imitate provenance fields", () => {
	const root = mkdtempSync(join(tmpdir(), "thruvera-agent-parity-"));
	try {
		const candidate = join(root, "thruvera.json");
		const codex = join(root, "codex.json");
		const hermes = join(root, "hermes.json");
		const output = join(root, "comparison.json");
		writeFileSync(candidate, JSON.stringify(run("thruvera")));
		writeFileSync(codex, JSON.stringify(run("codex")));
		writeFileSync(hermes, JSON.stringify(run("hermes")));
		const executed = spawnSync(process.execPath, ["scripts/evaluate-agent-parity.mjs", "--candidate", candidate, "--baseline", codex, "--baseline", hermes, "--write", output], { cwd: new URL("../../../", import.meta.url), encoding: "utf8" });
		assert.equal(executed.status, 2);
		assert.match(executed.stderr, /does not match current target manifest|unpinned|capture command/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pinned run validation binds a capture to the current manifest, fixture, target and environment", async () => {
	const manifestBytes = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../../evals/agent-parity-targets.json", import.meta.url)));
	const manifest = JSON.parse(manifestBytes);
	const target = manifest.targets.find((candidate) => candidate.id === "thruvera");
	const machine = manifest.machineProfiles[0];
	const report = run("thruvera");
	report.system = { id: target.id, version: target.version, model: target.nativeModel };
	report.environment = { platform: machine.platform, arch: machine.arch, node: machine.node, osId: machine.osId, osVersion: `${machine.osVersionPrefix}0`, machineProfile: machine.id, networkCondition: "live-public-uncontrolled", networkEnforcement: "observed-public-network" };
	const captureConfiguration = { adapter: target.capture.adapter, options: target.capture.bestNativeOptions };
	report.provenance = { command: "capture-agent-parity", mode: "best-native", corpusSha256: `sha256:${createHash("sha256").update(JSON.stringify(agentParityCorpus)).digest("hex")}`, fixtureSha256: await digestTree(new URL("../../../evals/fixtures/agent-parity", import.meta.url).pathname), configurationSha256: `sha256:${"a".repeat(64)}`, configurationContractSha256: `sha256:${createHash("sha256").update(JSON.stringify(captureConfiguration)).digest("hex")}`, targetManifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`, caseTimeoutMs: manifest.execution.caseTimeoutMs };
	assert.equal(validatePinnedAgentRun(agentParityCorpus, report, { manifest, manifestSha256: report.provenance.targetManifestSha256, corpusSha256: report.provenance.corpusSha256, fixtureSha256: report.provenance.fixtureSha256, mode: "best-native" }), true);
	report.provenance.fixtureSha256 = `sha256:${"b".repeat(64)}`;
	assert.throws(() => validatePinnedAgentRun(agentParityCorpus, report, { manifest, manifestSha256: report.provenance.targetManifestSha256, corpusSha256: report.provenance.corpusSha256, fixtureSha256: `sha256:${"c".repeat(64)}`, mode: "best-native" }), /fixture digest/);
});

test("parity targets pin product versions and separate same-model from native-product claims", () => {
	const targets = JSON.parse(readFileSync(new URL("../../../evals/agent-parity-targets.json", import.meta.url), "utf8"));
	assert.equal(targets.schemaVersion, 1);
	assert.deepEqual(targets.platforms, ["darwin-26-arm64", "ubuntu-24.04-x64"]);
	assert.deepEqual(targets.networkConditions.map((condition) => condition.id), ["isolated-fixture", "live-public-uncontrolled", "offline"]);
	assert.deepEqual(targets.execution, { caseTimeoutMs: 180000, productConcurrency: 1, caseConcurrency: 1, sideEffects: "blocked-unless-isolated-fixture-provider" });
	assert.deepEqual(targets.targets.map((target) => target.id), ["thruvera", "codex", "hermes"]);
	for (const target of targets.targets) {
		assert.match(target.version, /^\d+\.\d+\.\d+/);
		assert.doesNotMatch(target.version, /latest|main/i);
	}
	assert.equal(targets.modes.sameModel.requireExactModelIdentity, true);
	assert.equal(targets.modes.bestNative.requireExactModelIdentity, false);
});

test("parity runner executes the exact corpus and retains failed cases", async () => {
	const observed = [];
	const report = await runAgentParityCorpus({
		corpus: agentParityCorpus,
		system: { id: "thruvera", version: "1.2.0", model: "shared-model" },
		environment: { platform: "test", arch: "test", node: process.version, osId: "test-os", osVersion: "1.0", machineProfile: "test", networkCondition: "isolated-fixture", networkEnforcement: "deterministic-fixture-adapter" },
		executeCase: async (scenario) => {
			observed.push(scenario.id);
			if (scenario.id === "mcp-tool") throw new Error("simulated runner failure");
			return {
				status: "succeeded",
				durationMs: 5,
				inputTokens: 2,
				outputTokens: 1,
				toolCalls: scenario.requiredCapabilities.map((name) => ({ name, status: "succeeded", argumentsValid: true, required: true })),
				evidenceKinds: [...scenario.requiredEvidenceKinds],
				userInterventions: 0,
				duplicateEffects: 0,
				objectiveDegraded: false,
				outcomeVerified: true,
				recovered: scenario.facets.includes("recovery") || undefined,
			};
		},
	});
	assert.deepEqual(observed, agentParityCorpus.cases.map((scenario) => scenario.id));
	assert.deepEqual(report.cases.map((result) => result.id), observed);
	const failed = report.cases.find((result) => result.id === "mcp-tool");
	assert.equal(failed.status, "failed");
	assert.match(failed.error, /simulated runner failure/);
	report.provenance = { mode: "same-model", corpusSha256: "sha256:corpus", fixtureSha256: "sha256:fixture", configurationSha256: "sha256:config", configurationContractSha256: "sha256:contract", targetManifestSha256: "sha256:manifest", caseTimeoutMs: 180_000 };
	assert.doesNotThrow(() => evaluateAgentRun(agentParityCorpus, report));
});

test("parity runner gives an aborted adapter a bounded grace window to retain partial evidence", async () => {
	const corpus = { version: 1, seed: "timeout", cases: [{ id: "timeout", requiredCapabilities: [], requiredEvidenceKinds: [], facets: [] }] };
	const report = await runAgentParityCorpus({
		corpus,
		system: { id: "thruvera", version: "1", model: "model" },
		environment: { platform: "test", arch: "test", node: process.version, osId: "test-os", osVersion: "1.0", machineProfile: "test", networkCondition: "isolated-fixture", networkEnforcement: "deterministic-fixture-adapter" },
		timeoutMs: 100,
		executeCase: (_scenario, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({
			status: "failed", durationMs: 100, inputTokens: 1, outputTokens: 0,
			toolCalls: [{ name: "observed_tool", status: "started", argumentsValid: null, required: null }], evidenceKinds: ["tool"],
			userInterventions: 0, duplicateEffects: null, objectiveDegraded: null, outcomeVerified: false,
		}), { once: true })),
	});
	assert.equal(report.cases[0].status, "failed");
	assert.equal(report.cases[0].toolCalls[0].name, "observed_tool");
});

test("capture CLI runs a pluggable Agent adapter unattended", (context) => {
	const root = mkdtempSync(join(tmpdir(), "thruvera-agent-parity-capture-"));
	try {
		const output = join(root, "run.json");
		const adapter = new URL("./fixtures/agent-parity-adapter.mjs", import.meta.url).pathname;
		const targets = JSON.parse(readFileSync(new URL("../../../evals/agent-parity-targets.json", import.meta.url), "utf8"));
		const machine = targets.machineProfiles.find((profile) => profile.platform === process.platform && profile.arch === process.arch && profile.node === process.version);
		if (!machine) return context.skip(`current machine ${process.platform}/${process.arch}/${process.version} is not a pinned parity capture environment`);
		const executed = spawnSync(process.execPath, ["scripts/capture-agent-parity.mjs", "--mode", "contract", "--adapter", adapter, "--system", "contract-fixture", "--version", "1.0.0", "--model", "deterministic-fixture", "--machine-profile", machine.id, "--network-condition", "isolated-fixture", "--adapter-options", '{"fixtureRoot":"evals/fixtures/agent-parity"}', "--write", output], { cwd: new URL("../../../", import.meta.url), encoding: "utf8" });
		assert.equal(executed.status, 0, executed.stderr || executed.stdout);
		const report = JSON.parse(readFileSync(output, "utf8"));
		assert.equal(report.cases.length, agentParityCorpus.cases.length);
		assert.equal(report.system.id, "contract-fixture");
		assert.equal(report.system.version, "1.0.0");
		assert.equal(report.system.model, "deterministic-fixture");
		assert.equal(report.environment.machineProfile, machine.id);
		assert.match(report.provenance.fixtureSha256, /^sha256:[a-f0-9]{64}$/);
		assert.match(report.provenance.configurationSha256, /^sha256:[a-f0-9]{64}$/);
		assert.match(report.provenance.targetManifestSha256, /^sha256:[a-f0-9]{64}$/);
		assert.equal(report.cases.every((result) => result.status === "succeeded"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

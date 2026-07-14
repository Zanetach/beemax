import { createHash } from "node:crypto";

const REPORT_SCHEMA_VERSION = 1;

export function evaluateAgentRun(corpus, run) {
	validateCorpus(corpus);
	validateRunIdentity(corpus, run);
	const expectedIds = new Set(corpus.cases.map((scenario) => scenario.id));
	const actualIds = new Set(run.cases.map((result) => requiredString(result.id, "case id")));
	const missingCases = [...expectedIds].filter((id) => !actualIds.has(id));
	const unexpectedCases = [...actualIds].filter((id) => !expectedIds.has(id));
	if (missingCases.length) throw new Error(`Agent run is missing case(s): ${missingCases.join(", ")}`);
	if (unexpectedCases.length) throw new Error(`Agent run contains unexpected case(s): ${unexpectedCases.join(", ")}`);
	if (actualIds.size !== run.cases.length) throw new Error("Agent run contains duplicate case ids");

	const byId = new Map(run.cases.map((result) => [result.id, normalizeResult(result)]));
	let succeeded = 0;
	let required = 0;
	let observedRequired = 0;
	let toolCalls = 0;
	let successfulToolCalls = 0;
	let failedToolCalls = 0;
	let unsettledToolCalls = 0;
	let validArguments = 0;
	let argumentAssessments = 0;
	let unnecessaryCalls = 0;
	let necessityAssessments = 0;
	let evidenceRequired = 0;
	let evidenceObserved = 0;
	let unauthorizedDowngrades = 0;
	let downgradeAssessments = 0;
	let duplicateEffects = 0;
	let effectCases = 0;
	let effectAssessments = 0;
	let recoveryCases = 0;
	let recoveredCases = 0;
	let recoveryAssessments = 0;
	let userInterventions = 0;
	let totalTokens = 0;
	const durations = [];
	const caseOutcomes = [];

	for (const scenario of corpus.cases) {
		const result = byId.get(scenario.id);
		const calls = result.toolCalls;
		const calledNames = new Set(calls.map((call) => call.name));
		const missingCapabilities = scenario.requiredCapabilities.filter((name) => !calledNames.has(name));
		required += scenario.requiredCapabilities.length;
		observedRequired += scenario.requiredCapabilities.filter((name) => calledNames.has(name)).length;
		toolCalls += calls.length;
		successfulToolCalls += calls.filter((call) => call.status === "succeeded").length;
		failedToolCalls += calls.filter((call) => call.status === "failed").length;
		unsettledToolCalls += calls.filter((call) => call.status === "started").length;
		validArguments += calls.filter((call) => call.argumentsValid).length;
		argumentAssessments += calls.filter((call) => call.argumentsValid !== null).length;
		unnecessaryCalls += calls.filter((call) => call.required === false).length;
		necessityAssessments += calls.filter((call) => call.required !== null).length;
		evidenceRequired += scenario.requiredEvidenceKinds.length;
		const evidenceKinds = new Set(result.evidenceKinds);
		const missingEvidenceKinds = scenario.requiredEvidenceKinds.filter((kind) => !evidenceKinds.has(kind));
		evidenceObserved += scenario.requiredEvidenceKinds.length - missingEvidenceKinds.length;
		const accepted = result.status === "succeeded" && result.outcomeVerified === true && missingCapabilities.length === 0 && missingEvidenceKinds.length === 0 && result.objectiveDegraded !== true;
		if (accepted) succeeded++;
		if (result.objectiveDegraded !== null) { downgradeAssessments++; unauthorizedDowngrades += result.objectiveDegraded ? 1 : 0; }
		const effectRelevant = scenario.facets.includes("external_effect") || scenario.requiredEvidenceKinds.includes("effect") || scenario.requiredEvidenceKinds.includes("delivery");
		if (effectRelevant) { effectCases++; if (result.duplicateEffects !== null) { effectAssessments++; duplicateEffects += result.duplicateEffects; } }
		if (scenario.facets.includes("recovery")) { recoveryCases++; if (result.recovered !== null) recoveryAssessments++; if (accepted && result.recovered === true) recoveredCases++; }
		userInterventions += result.userInterventions;
		totalTokens += result.inputTokens + result.outputTokens;
		durations.push(result.durationMs);
		caseOutcomes.push(Object.freeze({ id: scenario.id, status: result.status, accepted, missingCapabilities: Object.freeze(missingCapabilities), missingEvidenceKinds: Object.freeze(missingEvidenceKinds) }));
	}

	return Object.freeze({
		schemaVersion: REPORT_SCHEMA_VERSION,
		system: Object.freeze({ ...run.system }),
		corpus: Object.freeze({ version: corpus.version, seed: corpus.seed, cases: corpus.cases.length }),
		environment: Object.freeze({ ...run.environment }),
		provenance: Object.freeze({ ...run.provenance }),
		coverage: Object.freeze({ missingCases: Object.freeze(missingCases), unexpectedCases: Object.freeze(unexpectedCases), categories: Object.freeze([...new Set(corpus.cases.map((scenario) => scenario.category))]) }),
		quality: Object.freeze({ endToEndSuccessRate: ratio(succeeded, corpus.cases.length) }),
		caseOutcomes: Object.freeze(caseOutcomes),
		routing: Object.freeze({ requiredCapabilityRecall: ratio(observedRequired, required), argumentValidityRate: ratio(validArguments, argumentAssessments), argumentAssessmentRate: ratio(argumentAssessments, toolCalls), unnecessaryToolCallRate: necessityAssessments ? unnecessaryCalls / necessityAssessments : 0, toolNecessityAssessmentRate: ratio(necessityAssessments, toolCalls), toolCallSuccessRate: ratio(successfulToolCalls, toolCalls), toolCalls, successfulToolCalls, failedToolCalls, unsettledToolCalls }),
		verification: Object.freeze({ evidenceCoverageRate: ratio(evidenceObserved, evidenceRequired) }),
		reliability: Object.freeze({ unauthorizedDowngrades, downgradeAssessmentRate: ratio(downgradeAssessments, corpus.cases.length), duplicateEffects, effectAssessmentRate: ratio(effectAssessments, effectCases), effectCases, recoveryRate: ratio(recoveredCases, recoveryCases), recoveryAssessmentRate: ratio(recoveryAssessments, recoveryCases), averageUserInterventions: ratio(userInterventions, corpus.cases.length) }),
		cost: Object.freeze({ totalTokens, averageTokens: ratio(totalTokens, corpus.cases.length) }),
		performance: Object.freeze({ p95DurationMs: percentile(durations, 0.95), averageDurationMs: ratio(durations.reduce((sum, value) => sum + value, 0), durations.length) }),
	});
}

export function compareAgentParity({ corpus, candidate, baselines, requireExactModelIdentity = true }) {
	if (!Array.isArray(baselines) || baselines.length === 0) throw new Error("At least one pinned baseline run is required");
	if (candidate?.system?.id !== "beemax") throw new Error("Agent parity candidate must be beemax");
	const baselineIds = baselines.map((baseline) => baseline?.system?.id).sort();
	if (baselineIds.length !== 2 || baselineIds[0] !== "codex" || baselineIds[1] !== "hermes") throw new Error("Agent parity baselines must be exactly codex and hermes");
	const evaluatedCandidate = evaluateAgentRun(corpus, candidate);
	const evaluatedBaselines = baselines.map((baseline) => evaluateAgentRun(corpus, baseline));
	const failures = [];
	const expectedMode = requireExactModelIdentity ? "same-model" : "best-native";
	if (evaluatedCandidate.provenance.mode !== expectedMode) failures.push(`beemax: provenance mode ${evaluatedCandidate.provenance.mode} does not match comparison ${expectedMode}`);
	for (const baseline of evaluatedBaselines) {
		if (baseline.provenance.mode !== expectedMode) failures.push(`${baseline.system.id}: provenance mode ${baseline.provenance.mode} does not match comparison ${expectedMode}`);
		if (requireExactModelIdentity && baseline.system.model !== evaluatedCandidate.system.model) failures.push(`${baseline.system.id}: model differs from candidate`);
		if (!sameEnvironment(baseline.environment, evaluatedCandidate.environment)) failures.push(`${baseline.system.id}: environment differs from candidate`);
		for (const field of ["mode", "corpusSha256", "fixtureSha256", "targetManifestSha256", "caseTimeoutMs"]) if (baseline.provenance[field] !== evaluatedCandidate.provenance[field]) failures.push(`${baseline.system.id}: provenance ${field} differs from candidate`);
		compareHigher(failures, baseline, evaluatedCandidate, "quality", "endToEndSuccessRate");
		compareHigher(failures, baseline, evaluatedCandidate, "routing", "requiredCapabilityRecall");
		compareHigher(failures, baseline, evaluatedCandidate, "routing", "argumentValidityRate");
		compareHigher(failures, baseline, evaluatedCandidate, "routing", "argumentAssessmentRate");
		compareLower(failures, baseline, evaluatedCandidate, "routing", "unnecessaryToolCallRate");
		compareHigher(failures, baseline, evaluatedCandidate, "routing", "toolNecessityAssessmentRate");
		compareHigher(failures, baseline, evaluatedCandidate, "routing", "toolCallSuccessRate");
		compareHigher(failures, baseline, evaluatedCandidate, "verification", "evidenceCoverageRate");
		compareHigher(failures, baseline, evaluatedCandidate, "reliability", "downgradeAssessmentRate");
		compareLower(failures, baseline, evaluatedCandidate, "reliability", "unauthorizedDowngrades");
		compareHigher(failures, baseline, evaluatedCandidate, "reliability", "effectAssessmentRate");
		compareLower(failures, baseline, evaluatedCandidate, "reliability", "duplicateEffects");
		compareHigher(failures, baseline, evaluatedCandidate, "reliability", "recoveryRate");
		compareHigher(failures, baseline, evaluatedCandidate, "reliability", "recoveryAssessmentRate");
		compareLower(failures, baseline, evaluatedCandidate, "reliability", "averageUserInterventions");
	}
	return Object.freeze({
		schemaVersion: REPORT_SCHEMA_VERSION,
		mode: expectedMode,
		corpus: evaluatedCandidate.corpus,
		candidate: evaluatedCandidate,
		baselines: Object.freeze(evaluatedBaselines),
		gate: Object.freeze({ passed: failures.length === 0, failures: Object.freeze(failures) }),
	});
}

export function validatePinnedAgentRun(corpus, run, { manifest, manifestSha256, corpusSha256, fixtureSha256, mode }) {
	validateCorpus(corpus);
	validateRunIdentity(corpus, run);
	const target = manifest.targets.find((candidate) => candidate.id === run.system.id);
	if (!target) throw new Error(`Run uses unpinned Agent target ${run.system.id}`);
	if (run.system.version !== target.version) throw new Error(`${run.system.id}: version does not match current target manifest`);
	const expectedModel = mode === "same-model" ? manifest.modes.sameModel.model : target.nativeModel;
	if (run.system.model !== expectedModel) throw new Error(`${run.system.id}: model does not match current ${mode} target`);
	if (target.revision && run.system.revision !== target.revision) throw new Error(`${run.system.id}: source revision does not match current target manifest`);
	if (run.provenance.command !== "capture-agent-parity") throw new Error(`${run.system.id}: report was not produced by the capture command`);
	if (run.provenance.mode !== mode) throw new Error(`${run.system.id}: report mode does not match comparison mode`);
	if (run.provenance.targetManifestSha256 !== manifestSha256) throw new Error(`${run.system.id}: target manifest digest is stale or untrusted`);
	if (run.provenance.corpusSha256 !== corpusSha256) throw new Error(`${run.system.id}: corpus digest is stale or untrusted`);
	if (run.provenance.fixtureSha256 !== fixtureSha256) throw new Error(`${run.system.id}: fixture digest is stale or untrusted`);
	if (!/^sha256:[a-f0-9]{64}$/.test(run.provenance.configurationSha256)) throw new Error(`${run.system.id}: configuration digest is invalid`);
	const captureConfiguration = { adapter: target.capture?.adapter, options: mode === "same-model" ? target.capture?.sameModelOptions : target.capture?.bestNativeOptions };
	const expectedConfigurationContractSha256 = `sha256:${createHash("sha256").update(JSON.stringify(captureConfiguration)).digest("hex")}`;
	if (run.provenance.configurationContractSha256 !== expectedConfigurationContractSha256) throw new Error(`${run.system.id}: configuration contract does not match the current target manifest`);
	if (run.provenance.caseTimeoutMs !== manifest.execution.caseTimeoutMs) throw new Error(`${run.system.id}: case timeout differs from the pinned execution contract`);
	const machine = manifest.machineProfiles.find((profile) => profile.id === run.environment.machineProfile);
	if (!machine) throw new Error(`${run.system.id}: machine profile is not pinned`);
	for (const field of ["platform", "arch", "node", "osId"]) if (run.environment[field] !== machine[field]) throw new Error(`${run.system.id}: machine ${field} differs from pinned profile`);
	if (!run.environment.osVersion.startsWith(machine.osVersionPrefix)) throw new Error(`${run.system.id}: operating system version differs from pinned profile`);
	const network = manifest.networkConditions.find((condition) => condition.id === run.environment.networkCondition);
	if (!network) throw new Error(`${run.system.id}: network condition is not pinned`);
	const expectedEnforcement = { "deterministic-fixture-adapter-only": "deterministic-fixture-adapter", observational: "observed-public-network", "runner-network-isolation-required": "runner-network-isolation-attested" }[network.enforcement];
	if (run.environment.networkEnforcement !== expectedEnforcement) throw new Error(`${run.system.id}: network enforcement does not match the pinned condition`);
	return true;
}

function validateCorpus(corpus) {
	if (!corpus || corpus.version !== 1 || !requiredString(corpus.seed, "corpus seed") || !Array.isArray(corpus.cases) || corpus.cases.length === 0) throw new Error("Agent parity corpus is invalid");
	const ids = new Set();
	for (const scenario of corpus.cases) {
		const id = requiredString(scenario.id, "corpus case id");
		if (ids.has(id)) throw new Error(`Agent parity corpus contains duplicate case ${id}`);
		ids.add(id);
		if (!Array.isArray(scenario.requiredCapabilities) || !Array.isArray(scenario.requiredEvidenceKinds) || !Array.isArray(scenario.facets)) throw new Error(`Agent parity corpus case ${id} is invalid`);
		if (!scenario.outputContract || !Array.isArray(scenario.outputContract.requiredAnyGroups) || !Array.isArray(scenario.outputContract.forbidden)) throw new Error(`Agent parity corpus case ${id} has no output contract`);
	}
}

function validateRunIdentity(corpus, run) {
	if (!run || run.schemaVersion !== REPORT_SCHEMA_VERSION || !Array.isArray(run.cases)) throw new Error("Agent run report is invalid");
	if (run.corpus?.version !== corpus.version || run.corpus?.seed !== corpus.seed) throw new Error("Agent run corpus identity does not match the pinned corpus identity");
	for (const field of ["id", "version", "model"]) requiredString(run.system?.[field], `system ${field}`);
	for (const field of ["platform", "arch", "node", "osId", "osVersion", "machineProfile", "networkCondition", "networkEnforcement"]) requiredString(run.environment?.[field], `environment ${field}`);
	for (const field of ["mode", "corpusSha256", "fixtureSha256", "configurationSha256", "configurationContractSha256", "targetManifestSha256"]) requiredString(run.provenance?.[field], `provenance ${field}`);
	if (!Number.isFinite(run.provenance?.caseTimeoutMs) || run.provenance.caseTimeoutMs < 100) throw new Error("provenance caseTimeoutMs is invalid");
}

function normalizeResult(result) {
	if (!["succeeded", "blocked", "failed"].includes(result.status)) throw new Error(`Agent run case ${result.id} has invalid status`);
	for (const field of ["durationMs", "inputTokens", "outputTokens", "userInterventions"]) if (!Number.isFinite(result[field]) || result[field] < 0) throw new Error(`Agent run case ${result.id} has invalid ${field}`);
	if (result.duplicateEffects !== null && (!Number.isFinite(result.duplicateEffects) || result.duplicateEffects < 0)) throw new Error(`Agent run case ${result.id} has invalid duplicateEffects`);
	if (result.objectiveDegraded !== null && typeof result.objectiveDegraded !== "boolean") throw new Error(`Agent run case ${result.id} has invalid objectiveDegraded`);
	if (result.recovered !== undefined && result.recovered !== null && typeof result.recovered !== "boolean") throw new Error(`Agent run case ${result.id} has invalid recovered`);
	if (typeof result.outcomeVerified !== "boolean") throw new Error(`Agent run case ${result.id} has invalid outcomeVerified`);
	if (!Array.isArray(result.toolCalls) || !Array.isArray(result.evidenceKinds)) throw new Error(`Agent run case ${result.id} has invalid evidence or Tool calls`);
	return {
		...result,
		toolCalls: result.toolCalls.map((call) => {
			if (!["started", "succeeded", "failed"].includes(call.status)) throw new Error(`Agent run case ${result.id} has invalid Tool call status`);
			return { name: requiredString(call.name, "Tool call name"), status: call.status, argumentsValid: call.argumentsValid === true ? true : call.argumentsValid === false ? false : null, required: call.required === true ? true : call.required === false ? false : null };
		}),
		evidenceKinds: result.evidenceKinds.map((kind) => requiredString(kind, "evidence kind")),
		objectiveDegraded: result.objectiveDegraded,
		duplicateEffects: result.duplicateEffects,
	};
}

function compareHigher(failures, baseline, candidate, group, metric) {
	if (candidate[group][metric] < baseline[group][metric]) failures.push(`${baseline.system.id}: ${metric} ${candidate[group][metric]} is below baseline ${baseline[group][metric]}`);
}

function compareLower(failures, baseline, candidate, group, metric) {
	if (candidate[group][metric] > baseline[group][metric]) failures.push(`${baseline.system.id}: ${metric} ${candidate[group][metric]} exceeds baseline ${baseline[group][metric]}`);
}

function sameEnvironment(left, right) { return left.platform === right.platform && left.arch === right.arch && left.node === right.node && left.osId === right.osId && left.osVersion === right.osVersion && left.machineProfile === right.machineProfile && left.networkCondition === right.networkCondition && left.networkEnforcement === right.networkEnforcement; }
function requiredString(value, label) { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`); return value.trim(); }
function ratio(numerator, denominator) { return denominator ? numerator / denominator : 1; }
function percentile(values, quantile) { if (!values.length) return 0; const sorted = [...values].sort((left, right) => left - right); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]; }

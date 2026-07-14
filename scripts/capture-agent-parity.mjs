#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { agentParityCorpus } from "../evals/agent-parity-corpus.mjs";
import { evaluateAgentRun } from "../evals/agent-parity-evaluation.mjs";
import { runAgentParityCorpus } from "../evals/agent-parity-runner.mjs";
import { digestTree } from "../evals/adapters/subprocess.mjs";

const args = process.argv.slice(2);
try {
	const adapterPath = requiredOption(args, "--adapter");
	const system = {
		id: requiredOption(args, "--system"),
		version: requiredOption(args, "--version"),
		model: requiredOption(args, "--model"),
	};
	const writePath = requiredOption(args, "--write");
	const benchmarkMode = requiredOption(args, "--mode");
	const machineProfileId = requiredOption(args, "--machine-profile");
	const networkCondition = requiredOption(args, "--network-condition");
	const timeoutValue = optionalOption(args, "--timeout-ms");
	const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);
	if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 100)) throw new Error("--timeout-ms must be at least 100");
	const module = await import(pathToFileURL(resolve(adapterPath)).href);
	if (typeof module.createAgentParityAdapter !== "function") throw new Error("Agent parity adapter must export createAgentParityAdapter");
	const targetManifestBytes = await readFile(new URL("../evals/agent-parity-targets.json", import.meta.url));
	const corpusSha256 = `sha256:${createHash("sha256").update(JSON.stringify(agentParityCorpus)).digest("hex")}`;
	const targetManifest = JSON.parse(targetManifestBytes);
	validatePinnedIdentity(targetManifest, system, benchmarkMode);
	const machineProfile = targetManifest.machineProfiles.find((profile) => profile.id === machineProfileId);
	if (!machineProfile) throw new Error(`Unknown pinned machine profile ${machineProfileId}`);
	if (!targetManifest.networkConditions.some((condition) => condition.id === networkCondition)) throw new Error(`Unknown pinned network condition ${networkCondition}`);
	const networkEnforcement = enforceNetworkCondition(targetManifest, system.id, networkCondition);
	const environment = {
		platform: platform(),
		arch: arch(),
		node: process.version,
		...await operatingSystemIdentity(),
		machineProfile: machineProfileId,
		networkCondition,
		networkEnforcement,
	};
	for (const field of ["platform", "arch", "node", "osId"]) if (environment[field] !== machineProfile[field]) throw new Error(`Machine profile ${machineProfileId} requires ${field}=${machineProfile[field]}, observed ${environment[field]}`);
	if (!environment.osVersion.startsWith(machineProfile.osVersionPrefix)) throw new Error(`Machine profile ${machineProfileId} requires osVersion prefix ${machineProfile.osVersionPrefix}, observed ${environment.osVersion}`);
	const options = adapterOptions(args);
	if (!options.fixtureRoot) throw new Error("--adapter-options must provide the pinned fixtureRoot");
	const configurationContract = validateCaptureConfiguration(targetManifest, system.id, benchmarkMode, adapterPath, options);
	const configurationContractSha256 = `sha256:${createHash("sha256").update(JSON.stringify(configurationContract)).digest("hex")}`;
	const fixtureSha256 = await digestTree(resolve(options.fixtureRoot));
	let targetInspection = {};
	if (typeof module.inspectAgentParityTarget === "function") {
		const observed = await module.inspectAgentParityTarget({ system, environment, options });
		if (observed?.version !== system.version) throw new Error(`Pinned ${system.id} version ${system.version} does not match observed ${observed?.version ?? "unknown"}`);
		const pinnedTarget = targetManifest.targets.find((target) => target.id === system.id);
		if (pinnedTarget?.revision && observed?.revision !== pinnedTarget.revision) throw new Error(`Pinned ${system.id} revision ${pinnedTarget.revision} does not match observed ${observed?.revision ?? "unknown"}`);
		if (observed?.revision) system.revision = observed.revision;
		targetInspection = observed;
	}
	const configurationSha256 = targetInspection.configurationSha256 ?? `sha256:${createHash("sha256").update(await readFile(resolve(adapterPath))).update(JSON.stringify(options)).digest("hex")}`;
	const executeCase = await module.createAgentParityAdapter({ system, environment, corpus: agentParityCorpus, options });
	try {
		const run = await runAgentParityCorpus({
			corpus: agentParityCorpus, system, environment, executeCase,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			onCase: (result, completed, total) => process.stderr.write(`[${system.id}] ${completed}/${total} ${result.id}: ${result.status} (${Math.round(result.durationMs)}ms)\n`),
		});
		const artifact = {
			...run,
			capturedAt: new Date().toISOString(),
			provenance: {
				command: "capture-agent-parity",
				mode: benchmarkMode,
				adapter: resolve(adapterPath),
				caseTimeoutMs: timeoutMs ?? 10 * 60_000,
				corpusSha256,
				fixtureSha256,
				configurationSha256,
				configurationContractSha256,
				targetManifestSha256: `sha256:${createHash("sha256").update(targetManifestBytes).digest("hex")}`,
			},
		};
		evaluateAgentRun(agentParityCorpus, artifact);
		const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
		await writeFile(resolve(writePath), serialized, "utf8");
		process.stdout.write(serialized);
	} finally { await executeCase.dispose?.(); }
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}

function enforceNetworkCondition(manifest, systemId, condition) {
	if (condition === "isolated-fixture") {
		if (!manifest.fixtures?.[systemId]) throw new Error("isolated-fixture is valid only for a deterministic fixture adapter; native Agents must use an externally enforced offline runner or the declared live condition");
		return "deterministic-fixture-adapter";
	}
	if (condition === "offline") {
		if (process.env.AGENT_PARITY_OFFLINE_ENFORCED !== "true") throw new Error("offline capture requires runner-level network isolation and AGENT_PARITY_OFFLINE_ENFORCED=true");
		return "runner-network-isolation-attested";
	}
	if (condition === "live-public-uncontrolled") return "observed-public-network";
	throw new Error(`Unsupported network condition ${condition}`);
}

async function operatingSystemIdentity() {
	if (platform() === "darwin") {
		const { stdout } = await promisify(execFile)("sw_vers", ["-productVersion"], { encoding: "utf8" });
		return { osId: "macos", osVersion: stdout.trim() };
	}
	if (platform() === "linux") {
		const raw = await readFile("/etc/os-release", "utf8");
		const values = Object.fromEntries(raw.split(/\r?\n/).flatMap((line) => { const match = line.match(/^([A-Z_]+)=(.*)$/); return match ? [[match[1], match[2].replace(/^['\"]|['\"]$/g, "")]] : []; }));
		return { osId: values.ID || "linux", osVersion: values.VERSION_ID || "unknown" };
	}
	return { osId: platform(), osVersion: "unknown" };
}

function requiredOption(values, name) {
	const value = optionalOption(values, name);
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function optionalOption(values, name) {
	const index = values.indexOf(name);
	if (index < 0) return undefined;
	const value = values[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

function adapterOptions(values) {
	const json = optionalOption(values, "--adapter-options");
	if (!json) return {};
	if (!json.trim().startsWith("{")) throw new Error("--adapter-options must be inline JSON");
	return JSON.parse(json);
}

function validatePinnedIdentity(manifest, system, mode) {
	const target = manifest.targets.find((candidate) => candidate.id === system.id);
	const fixture = manifest.fixtures?.[system.id];
	if (!target && !fixture) throw new Error(`Unknown pinned Agent target ${system.id}`);
	if (fixture && mode !== "contract") throw new Error(`Fixture target ${system.id} requires mode=contract`);
	if (target && mode !== "best-native" && mode !== "same-model") throw new Error(`Agent target ${system.id} requires mode=best-native or same-model`);
	const expectedVersion = target?.version ?? fixture.version;
	const expectedModel = fixture?.model ?? (mode === "same-model" ? manifest.modes.sameModel.model : target.nativeModel);
	if (system.version !== expectedVersion) throw new Error(`Pinned ${system.id} version must be ${expectedVersion}`);
	if (system.model !== expectedModel) throw new Error(`Pinned ${system.id} model must be ${expectedModel}`);
}

function validateCaptureConfiguration(manifest, systemId, mode, adapterPath, options) {
	const target = manifest.targets.find((candidate) => candidate.id === systemId);
	if (!target && manifest.fixtures?.[systemId]) return { adapter: resolve(adapterPath), options };
	if (!target?.capture) throw new Error(`${systemId}: capture configuration is not pinned`);
	const expectedOptions = mode === "same-model" ? target.capture.sameModelOptions : target.capture.bestNativeOptions;
	const normalizedAdapter = resolve(adapterPath);
	if (normalizedAdapter !== resolve(target.capture.adapter)) throw new Error(`${systemId}: adapter does not match the pinned capture configuration`);
	const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
	if (canonical(options) !== canonical(expectedOptions)) throw new Error(`${systemId}: adapter options do not match the pinned ${mode} capture configuration`);
	return { adapter: target.capture.adapter, options: expectedOptions };
}

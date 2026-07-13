#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

export function selectReleasePerformanceProfile(machine, profiles) {
	const matches = profiles.filter((profile) => machineMatches(profile, machine));
	if (matches.length === 0) throw new Error(`No committed performance Profile matches this release machine: ${JSON.stringify(machine)}`);
	if (matches.length > 1) throw new Error(`Multiple committed performance Profiles match this release machine: ${matches.map((profile) => profile.id).join(", ")}`);
	return matches[0];
}

export function machineMatches(profile, machine) {
	return machine.platform === profile.platform
		&& machine.arch === profile.arch
		&& (!profile.runnerClass || machine.runnerClass === profile.runnerClass)
		&& new RegExp(profile.cpuPattern, "i").test(machine.cpu)
		&& machine.logicalCpus >= profile.minLogicalCpus
		&& machine.memoryGiB >= profile.minMemoryGiB
		&& machine.nodeMajor === profile.nodeMajor;
}

async function main() {
	const profilesDirectory = resolve(repositoryRoot, "evals/performance-profiles");
	const profileFiles = (await readdir(profilesDirectory)).filter((name) => name.endsWith(".json")).sort();
	const profiles = await Promise.all(profileFiles.map(async (name) => JSON.parse(await readFile(resolve(profilesDirectory, name), "utf8"))));
	const machine = {
		platform: process.platform,
		arch: process.arch,
		cpu: cpus()[0]?.model ?? "unknown",
		logicalCpus: cpus().length,
		memoryGiB: Math.floor(totalmem() / 2 ** 30),
		nodeMajor: Number(process.versions.node.split(".")[0]),
		runnerClass: githubHostedRunnerClass(process.env),
	};
	const profile = selectReleasePerformanceProfile(machine, profiles);
	if (!profile.releaseBaseline || !["check", "cost-baseline"].includes(profile.releaseBaseline.mode) || typeof profile.releaseBaseline.path !== "string") {
		throw new Error(`Performance Profile ${profile.id} has no valid release baseline policy`);
	}
	const result = spawnSync(process.execPath, [
		resolve(repositoryRoot, "scripts/evaluate-performance.mjs"),
		"--profile", resolve(profilesDirectory, profileFiles[profiles.indexOf(profile)]),
		`--${profile.releaseBaseline.mode}`, resolve(repositoryRoot, profile.releaseBaseline.path),
	], { cwd: repositoryRoot, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exitCode = result.status ?? 1;
}

export function githubHostedRunnerClass(environment) {
	return environment.GITHUB_ACTIONS === "true"
		&& environment.CI === "true"
		&& environment.RUNNER_OS === "Linux"
		&& environment.RUNNER_ARCH === "X64"
		&& typeof environment.ImageOS === "string" && /^ubuntu\d+$/i.test(environment.ImageOS)
		&& typeof environment.ImageVersion === "string" && environment.ImageVersion.length > 0
		? "github-actions-hosted"
		: "unclassified";
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();

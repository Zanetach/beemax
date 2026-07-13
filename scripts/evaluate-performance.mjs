#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { runRuntimePerformanceBenchmark } from "../evals/runtime-performance.mjs";
import { runtimeCostRegressions } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
const profilePath = resolve(valueAfter(args, "--profile") ?? "evals/performance-profiles/apple-m5-32gb.json");
const profile = JSON.parse(await readFile(profilePath, "utf8"));
const machine = currentMachine();
assertMachine(profile, machine);
const report = { ...(await runRuntimePerformanceBenchmark(profile)), machine };
const writePath = valueAfter(args, "--write");
if (writePath) await writeFile(resolve(writePath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
const failures = [...report.assessment.failures];
const checkPath = valueAfter(args, "--check");
if (checkPath) compareBaseline(report, JSON.parse(await readFile(resolve(checkPath), "utf8")), failures);
const costBaselinePath = valueAfter(args, "--cost-baseline");
if (costBaselinePath) compareCostBaseline(report, JSON.parse(await readFile(resolve(costBaselinePath), "utf8")), failures);
const result = { ...report, assessment: { ...report.assessment, passed: failures.length === 0, failures } };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

function compareBaseline(report, baseline, failures) {
	if (baseline.schemaVersion !== report.schemaVersion || baseline.profile?.id !== report.profile.id) failures.push("performance baseline Profile does not match");
	for (const path of ["fast", "deep", "background"]) {
		const current = report.assessment.paths[path];
		const prior = baseline.assessment?.paths?.[path];
		if (!prior) { failures.push(`${path} performance baseline is missing`); continue; }
		if (current.p50Ms > prior.p50Ms * 2 + 1) failures.push(`${path} P50 regressed beyond baseline tolerance`);
		if (current.p95Ms > prior.p95Ms * 2 + 2) failures.push(`${path} P95 regressed beyond baseline tolerance`);
	}
	compareCostBaseline(report, baseline, failures);
}

function compareCostBaseline(report, baseline, failures) {
	if (baseline.schemaVersion !== report.schemaVersion) { failures.push("performance cost baseline schema does not match"); return; }
	failures.push(...runtimeCostRegressions(report.assessment.paths, baseline.assessment?.paths ?? {}));
}

function currentMachine() {
	return { platform: process.platform, arch: process.arch, node: process.version, cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, memoryGiB: Math.floor(totalmem() / 2 ** 30) };
}

function assertMachine(profile, machine) {
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	if (machine.platform !== profile.platform || machine.arch !== profile.arch || !new RegExp(profile.cpuPattern, "i").test(machine.cpu) || machine.logicalCpus < profile.minLogicalCpus || machine.memoryGiB < profile.minMemoryGiB || nodeMajor !== profile.nodeMajor) {
		throw new Error(`Machine does not satisfy performance Profile ${profile.id}: ${JSON.stringify(machine)}`);
	}
}

function valueAfter(args, flag) {
	const index = args.indexOf(flag);
	return index < 0 ? undefined : args[index + 1];
}

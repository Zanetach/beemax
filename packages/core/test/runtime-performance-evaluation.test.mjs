import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runRuntimePerformanceBenchmark } from "../../../evals/runtime-performance.mjs";
import { githubHostedRunnerClass, selectReleasePerformanceProfile } from "../../../scripts/evaluate-release-performance.mjs";

test("performance benchmark exercises fast, deep, and background production interfaces", async () => {
	const profile = JSON.parse(await readFile(new URL("../../../evals/performance-profiles/apple-m5-32gb.json", import.meta.url), "utf8"));
	profile.id = "test-performance-profile";
	profile.warmupIterations = 0;
	profile.sampleIterations = 5;
	for (const budget of Object.values(profile.budgets)) { budget.p50Ms = 10_000; budget.p95Ms = 10_000; }
	const report = await runRuntimePerformanceBenchmark(profile);
	assert.equal(report.assessment.passed, true);
	assert.deepEqual(Object.keys(report.assessment.paths), ["fast", "deep", "background"]);
	assert.equal(report.assessment.paths.fast.samples, 5);
	assert.ok(report.assessment.paths.deep.contextChars > 0);
	assert.ok(report.assessment.paths.deep.recallMs >= 0);
	assert.ok(report.assessment.paths.background.initiativeMs >= 0);
	assert.equal(report.assessment.paths.background.toolCalls, 6);
});

test("committed machine Profiles keep identical cost ceilings across local and release hardware", async () => {
	const local = JSON.parse(await readFile(new URL("../../../evals/performance-profiles/apple-m5-32gb.json", import.meta.url), "utf8"));
	const ci = JSON.parse(await readFile(new URL("../../../evals/performance-profiles/github-actions-ubuntu-x64.json", import.meta.url), "utf8"));
	assert.notEqual(local.id, ci.id);
	assert.deepEqual(Object.keys(local.budgets), ["fast", "deep", "background"]);
	for (const path of ["fast", "deep", "background"]) {
		for (const metric of ["maxContextChars", "maxTokens", "maxToolCalls", "maxSubagents", "maxCacheWriteTokens", "maxConcurrency", "maxBackpressureEvents"]) assert.equal(ci.budgets[path][metric], local.budgets[path][metric]);
		assert.ok(ci.budgets[path].p95Ms >= local.budgets[path].p95Ms);
	}
});

test("release performance gate selects one strict committed Profile for the current machine class", async () => {
	const local = JSON.parse(await readFile(new URL("../../../evals/performance-profiles/apple-m5-32gb.json", import.meta.url), "utf8"));
	const ci = JSON.parse(await readFile(new URL("../../../evals/performance-profiles/github-actions-ubuntu-x64.json", import.meta.url), "utf8"));
	assert.equal(selectReleasePerformanceProfile({ platform: "darwin", arch: "arm64", cpu: "Apple M5", logicalCpus: 10, memoryGiB: 32, nodeMajor: 22 }, [local, ci]).id, local.id);
	const linux = { platform: "linux", arch: "x64", cpu: "AMD EPYC", logicalCpus: 4, memoryGiB: 16, nodeMajor: 22 };
	assert.equal(selectReleasePerformanceProfile({ ...linux, runnerClass: "github-actions-hosted" }, [local, ci]).id, ci.id);
	assert.throws(() => selectReleasePerformanceProfile({ ...linux, runnerClass: "unclassified" }, [local, ci]), /no committed performance Profile/i);
	assert.throws(() => selectReleasePerformanceProfile({ platform: "win32", arch: "x64", cpu: "Unknown", logicalCpus: 8, memoryGiB: 16, nodeMajor: 22 }, [local, ci]), /no committed performance Profile/i);
	assert.equal(githubHostedRunnerClass({ GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64", ImageOS: "ubuntu24", ImageVersion: "20260701.1" }), "github-actions-hosted");
	assert.equal(githubHostedRunnerClass({ GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64" }), "unclassified");
});

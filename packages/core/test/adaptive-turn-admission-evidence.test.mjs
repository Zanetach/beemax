import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("current live Adaptive Turn Admission evidence passes the independent verifier", () => {
	const result = spawnSync(process.execPath, [resolve("scripts/verify-live-adaptive-turn-admission.mjs")], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout || result.stderr);
});

test("the independent Adaptive Turn Admission verifier rejects a hidden runtime failure", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-adaptive-admission-evidence-"));
	try {
		const artifact = JSON.parse(readFileSync(resolve("evals/baselines/adaptive-turn-admission-live.json"), "utf8"));
		artifact.cases[0].runtimeFailure = "hidden failure";
		const path = join(root, "tampered.json");
		writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
		const result = spawnSync(process.execPath, [resolve("scripts/verify-live-adaptive-turn-admission.mjs"), path], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stdout, /completion evidence is incomplete/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the independent Adaptive Turn Admission verifier rejects missing main Pi usage evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-adaptive-admission-usage-"));
	try {
		const artifact = JSON.parse(readFileSync(resolve("evals/baselines/adaptive-turn-admission-live.json"), "utf8"));
		delete artifact.cases[0].answerChars;
		delete artifact.cases[0].inputTokens;
		delete artifact.cases[0].outputTokens;
		delete artifact.cases[0].totalTokens;
		artifact.metrics.totalRunTokens = artifact.cases.slice(1).reduce((total, item) => total + item.totalTokens, 0);
		artifact.metrics.totalMainPiProviderTokens = artifact.cases.slice(1).reduce((total, item) => total + item.mainPiProviderEvidence.reduce((sum, turn) => sum + turn.inputTokens + turn.outputTokens, 0), 0);
		const path = join(root, "tampered.json");
		writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
		const result = spawnSync(process.execPath, [resolve("scripts/verify-live-adaptive-turn-admission.mjs"), path], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stdout, /completion evidence is incomplete/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the independent Adaptive Turn Admission verifier rejects an undeclared main Pi model", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-adaptive-admission-model-"));
	try {
		const artifact = JSON.parse(readFileSync(resolve("evals/baselines/adaptive-turn-admission-live.json"), "utf8"));
		artifact.cases[0].mainPiProviderEvidence[0].modelIdentity = "undeclared/model/api";
		const path = join(root, "tampered.json");
		writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
		const result = spawnSync(process.execPath, [resolve("scripts/verify-live-adaptive-turn-admission.mjs"), path], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stdout, /main Pi Provider evidence is incomplete/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

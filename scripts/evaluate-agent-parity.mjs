#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentParityCorpus } from "../evals/agent-parity-corpus.mjs";
import { compareAgentParity, validatePinnedAgentRun } from "../evals/agent-parity-evaluation.mjs";
import { digestTree } from "../evals/adapters/subprocess.mjs";

const args = process.argv.slice(2);
const candidatePath = singleValue(args, "--candidate");
const baselinePaths = repeatedValues(args, "--baseline");
const writePath = optionalValue(args, "--write");
const mode = optionalValue(args, "--mode") ?? "same-model";
if (mode !== "same-model" && mode !== "best-native") {
	process.stderr.write("--mode must be same-model or best-native\n");
	process.exitCode = 2;
} else if (!candidatePath || baselinePaths.length === 0) {
	process.stderr.write("Usage: node scripts/evaluate-agent-parity.mjs --candidate <run.json> --baseline <run.json> [--baseline <run.json>] [--write <report.json>]\n");
	process.exitCode = 2;
} else {
	try {
		const candidate = await readJson(candidatePath);
		const baselines = await Promise.all(baselinePaths.map(readJson));
		const manifestBytes = await readFile(new URL("../evals/agent-parity-targets.json", import.meta.url));
		const manifest = JSON.parse(manifestBytes);
		const pinned = { manifest, manifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`, corpusSha256: `sha256:${createHash("sha256").update(JSON.stringify(agentParityCorpus)).digest("hex")}`, fixtureSha256: await digestTree(fileURLToPath(new URL("../evals/fixtures/agent-parity", import.meta.url))), mode };
		for (const run of [candidate, ...baselines]) validatePinnedAgentRun(agentParityCorpus, run, pinned);
		const comparison = compareAgentParity({ corpus: agentParityCorpus, candidate, baselines, requireExactModelIdentity: mode === "same-model" });
		const artifact = {
			...comparison,
			generatedAt: new Date().toISOString(),
			provenance: {
				command: "evaluate-agent-parity",
				candidate: resolve(candidatePath),
				baselines: baselinePaths.map((path) => resolve(path)),
				corpus: { version: agentParityCorpus.version, seed: agentParityCorpus.seed },
			},
		};
		const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
		if (writePath) await writeFile(resolve(writePath), serialized, "utf8");
		process.stdout.write(serialized);
		if (!artifact.gate.passed) process.exitCode = 1;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}

async function readJson(path) { return JSON.parse(await readFile(resolve(path), "utf8")); }

function singleValue(values, name) {
	const matches = repeatedValues(values, name);
	if (matches.length > 1) throw new Error(`${name} may only be provided once`);
	return matches[0];
}

function optionalValue(values, name) { return singleValue(values, name); }

function repeatedValues(values, name) {
	const found = [];
	for (let index = 0; index < values.length; index++) {
		if (values[index] !== name) continue;
		const value = values[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
		found.push(value);
		index++;
	}
	return found;
}

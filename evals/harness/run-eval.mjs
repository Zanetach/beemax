#!/usr/bin/env node
/**
 * Eval-harness orchestrator: run baseline case prompts through the real Agent,
 * export the session transcript, then compare tool calls deterministically and
 * judge output equivalence with an LLM.
 *
 * Live mode (default) drives `beemax chat --plain` as a subprocess, pacing one
 * prompt per `beemax> ` idle marker so a turn always settles before the next
 * case (and before stdin closes, which disposes the runtime). Requirements:
 * `npm run build` and a configured Profile with model credentials.
 *
 * Offline mode (--records <file>) skips execution and evaluates an existing
 * exporter output — useful for re-judging or for runs produced elsewhere.
 *
 * Usage:
 *   node evals/harness/run-eval.mjs --profile personal
 *   node evals/harness/run-eval.mjs --records out/session-records.jsonl --skip-judge
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSessionFiles, exportSessions, sessionsRootForProfile } from "./export-session-records.mjs";
import { evaluateCase, judgeOutput, matchRecordsToCases, orderCases } from "./compare.mjs";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HARNESS_DIR, "..", "..");
const PROMPT_MARKER = "beemax> ";
const TURN_TIMEOUT_MS = 300_000;

function parseArgs(argv) {
	const options = { profile: undefined, records: undefined, baseline: join(HARNESS_DIR, "baseline-cases.json"), out: join(HARNESS_DIR, "out", "eval-report.json"), skipJudge: false };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const next = () => {
			const value = argv[++index];
			if (value === undefined) throw new Error(`Missing value for ${flag}`);
			return value;
		};
		if (flag === "--profile") options.profile = next();
		else if (flag === "--records") options.records = next();
		else if (flag === "--baseline") options.baseline = next();
		else if (flag === "--out") options.out = next();
		else if (flag === "--skip-judge") options.skipJudge = true;
		else if (flag === "--help" || flag === "-h") options.help = true;
		else throw new Error(`Unknown argument: ${flag}`);
	}
	return options;
}

/** Drive `beemax chat --plain`, sending the next prompt each time the idle marker appears. */
export async function runPromptsThroughChat(profile, prompts, { log = () => {} } = {}) {
	const child = spawn(process.execPath, [join(REPO_ROOT, "apps", "cli", "dist", "cli.js"), "chat", "--plain", "--profile", profile], {
		cwd: REPO_ROOT,
		stdio: ["pipe", "pipe", "inherit"],
		env: { ...process.env, TERM: "dumb" },
	});
	let buffer = "";
	let queueIndex = 0;
	let settle;
	const failed = new Promise((_, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => { if (queueIndex <= prompts.length) reject(new Error(`beemax chat exited early (code ${code})`)); });
	});
	const done = new Promise((resolveDone) => { settle = resolveDone; });
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
	}, TURN_TIMEOUT_MS * Math.max(1, prompts.length));
	child.stdout.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		process.stdout.write(text);
		buffer += text;
		if (!buffer.endsWith(PROMPT_MARKER)) return;
		buffer = "";
		if (queueIndex < prompts.length) {
			const prompt = prompts[queueIndex++];
			log(`\n[eval] sending case ${queueIndex}/${prompts.length}`);
			child.stdin.write(`${prompt.replace(/\n/g, " ")}\n`);
		} else {
			queueIndex++; // mark completion before EOF so early-exit detection stays quiet
			child.stdin.end();
			settle();
		}
	});
	try {
		await Promise.race([done, failed]);
		await new Promise((resolveExit) => child.once("exit", resolveExit));
	} finally {
		clearTimeout(timer);
	}
}

function loadRecords(options) {
	if (options.records) {
		const text = readFileSync(resolve(options.records), "utf8").trim();
		return text.startsWith("[") ? JSON.parse(text) : text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	}
	const files = collectSessionFiles(sessionsRootForProfile(options.profile));
	const { records, warnings } = exportSessions(files);
	for (const warning of warnings) console.warn(`warning: ${warning}`);
	return records;
}

async function createJudge(skipJudge) {
	if (skipJudge) return undefined;
	try {
		const { default: Anthropic } = await import("@anthropic-ai/sdk");
		const client = new Anthropic();
		return (testCase, record) => judgeOutput(client, testCase, record);
	} catch (error) {
		console.warn(`warning: LLM judge unavailable (${error instanceof Error ? error.message : String(error)}); running deterministic checks only`);
		return undefined;
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log("Usage: run-eval.mjs (--profile <name> | --records <file>) [--baseline <file>] [--out <file>] [--skip-judge]");
		return;
	}
	if (!options.profile && !options.records) throw new Error("Provide --profile <name> (live run) or --records <file> (offline)");
	const baseline = JSON.parse(readFileSync(resolve(options.baseline), "utf8"));
	const cases = orderCases(baseline.cases);

	if (!options.records) {
		console.log(`[eval] running ${cases.length} case(s) through profile '${options.profile}'`);
		await runPromptsThroughChat(options.profile, cases.map((testCase) => testCase.prompt), { log: (message) => console.log(message) });
	}

	const records = loadRecords(options);
	const matched = matchRecordsToCases(cases, records);
	const judge = await createJudge(options.skipJudge);
	const results = [];
	for (const { testCase, record } of matched) {
		results.push(await evaluateCase(testCase, record, judge));
	}

	const passed = results.filter((result) => result.passed).length;
	const report = { schemaVersion: 1, baseline: resolve(options.baseline), judge: judge ? "llm+deterministic" : "deterministic-only", total: results.length, passed, failed: results.length - passed, results };
	mkdirSync(dirname(resolve(options.out)), { recursive: true });
	writeFileSync(resolve(options.out), `${JSON.stringify(report, null, "\t")}\n`, "utf8");

	console.log(`\n[eval] ${passed}/${results.length} case(s) passed — report: ${resolve(options.out)}`);
	for (const result of results.filter((entry) => !entry.passed)) {
		console.log(`  ✖ ${result.id}`);
		for (const failure of result.failures) console.log(`      ${failure}`);
	}
	if (passed !== results.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}

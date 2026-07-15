#!/usr/bin/env node
/**
 * Local eval control panel: serves ui.html plus a small JSON API so a
 * developer can edit baseline cases and launch eval runs from the browser.
 *
 * Zero dependencies (node:http), binds 127.0.0.1 only. Start with:
 *   make ui          (defaults to http://127.0.0.1:8787)
 *   PORT=9000 make ui
 *
 * API:
 *   GET  /api/baseline           baseline-cases.json content
 *   PUT  /api/baseline           validate + persist baseline-cases.json
 *   GET  /api/profiles           configured BeeMax profile names
 *   POST /api/run                {mode:"live",profile} | {mode:"offline",records}, optional skipJudge
 *   GET  /api/status?since=N     run state + log lines after index N
 *   GET  /api/report             latest eval report
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { orderCases } from "./compare.mjs";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HARNESS_DIR, "baseline-cases.json");
const REPORT_PATH = join(HARNESS_DIR, "out", "eval-report.json");
const UI_PATH = join(HARNESS_DIR, "ui.html");
const MAX_BODY_BYTES = 2_000_000;
const MAX_LOG_LINES = 5_000;

export function validateBaseline(parsed) {
	if (parsed?.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
	if (!Array.isArray(parsed.cases) || !parsed.cases.length) throw new Error("cases must be a non-empty array");
	const ids = new Set();
	for (const testCase of parsed.cases) {
		if (typeof testCase.id !== "string" || !/^[a-z0-9-]+$/.test(testCase.id)) throw new Error(`invalid case id: ${JSON.stringify(testCase.id)}`);
		if (ids.has(testCase.id)) throw new Error(`duplicate case id: ${testCase.id}`);
		ids.add(testCase.id);
		if (typeof testCase.prompt !== "string" || !testCase.prompt.trim()) throw new Error(`${testCase.id}: prompt is required`);
		if (!testCase.expect || typeof testCase.expect !== "object") throw new Error(`${testCase.id}: expect is required`);
		const example = testCase.expect.output?.example;
		if (typeof example !== "string" || !example.trim()) throw new Error(`${testCase.id}: expect.output.example is required for the LLM judge`);
	}
	orderCases(parsed.cases); // throws on unknown dependsOn or cycles
	return parsed;
}

const run = { running: false, mode: undefined, startedAt: undefined, finishedAt: undefined, exitCode: undefined, lines: [], base: 0 };

function appendLog(chunk) {
	for (const line of chunk.toString("utf8").split("\n")) {
		if (line.trim() === "") continue;
		run.lines.push(line);
	}
	if (run.lines.length > MAX_LOG_LINES) {
		const excess = run.lines.length - MAX_LOG_LINES;
		run.lines.splice(0, excess);
		run.base += excess;
	}
}

function startRun(options) {
	if (run.running) throw new Error("an eval run is already in progress");
	const args = [join(HARNESS_DIR, "run-eval.mjs")];
	if (options.mode === "live") {
		if (typeof options.profile !== "string" || !options.profile.trim()) throw new Error("live mode requires a profile name");
		args.push("--profile", options.profile.trim());
	} else if (options.mode === "offline") {
		if (typeof options.records !== "string" || !options.records.trim()) throw new Error("offline mode requires a records file path");
		args.push("--records", options.records.trim());
	} else {
		throw new Error(`unknown mode: ${options.mode}`);
	}
	if (options.skipJudge) args.push("--skip-judge");
	Object.assign(run, { running: true, mode: options.mode, startedAt: Date.now(), finishedAt: undefined, exitCode: undefined, lines: [], base: 0 });
	appendLog(`[ui] starting: node ${args.map((value) => (value.includes(" ") ? JSON.stringify(value) : value)).join(" ")}`);
	const child = spawn(process.execPath, args, { cwd: resolve(HARNESS_DIR, "..", ".."), env: process.env });
	child.stdout.on("data", appendLog);
	child.stderr.on("data", appendLog);
	child.once("exit", (code) => {
		run.running = false;
		run.finishedAt = Date.now();
		run.exitCode = code ?? -1;
		appendLog(`[ui] run finished with exit code ${run.exitCode}`);
	});
	child.once("error", (error) => {
		run.running = false;
		run.finishedAt = Date.now();
		run.exitCode = -1;
		appendLog(`[ui] failed to start run: ${error.message}`);
	});
}

function listProfiles() {
	const home = resolve(process.env.BEEMAX_HOME?.trim() || join(homedir(), ".beemax"));
	try {
		return readdirSync(join(home, "profiles"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(home, "profiles", entry.name, "config.yaml")))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function readBody(request) {
	return new Promise((resolveBody, rejectBody) => {
		let size = 0;
		const chunks = [];
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				rejectBody(new Error("request body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
		request.on("error", rejectBody);
	});
}

function sendJson(response, status, payload) {
	const body = JSON.stringify(payload);
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(body);
}

export async function handleRequest(request, response) {
	const url = new URL(request.url ?? "/", "http://localhost");
	try {
		if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui.html")) {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			response.end(readFileSync(UI_PATH, "utf8"));
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/baseline") {
			sendJson(response, 200, JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
			return;
		}
		if (request.method === "PUT" && url.pathname === "/api/baseline") {
			const parsed = validateBaseline(JSON.parse(await readBody(request)));
			writeFileSync(BASELINE_PATH, `${JSON.stringify(parsed, null, "\t")}\n`, "utf8");
			sendJson(response, 200, { saved: true, cases: parsed.cases.length });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/profiles") {
			sendJson(response, 200, { profiles: listProfiles() });
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/run") {
			startRun(JSON.parse((await readBody(request)) || "{}"));
			sendJson(response, 202, { started: true });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/status") {
			const since = Math.max(run.base, Number(url.searchParams.get("since") ?? 0) || 0);
			sendJson(response, 200, {
				running: run.running,
				mode: run.mode,
				startedAt: run.startedAt,
				finishedAt: run.finishedAt,
				exitCode: run.exitCode,
				lines: run.lines.slice(since - run.base),
				next: run.base + run.lines.length,
			});
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/report") {
			if (!existsSync(REPORT_PATH)) {
				sendJson(response, 404, { error: "no report yet — run an eval first" });
				return;
			}
			sendJson(response, 200, { updatedAt: statSync(REPORT_PATH).mtimeMs, report: JSON.parse(readFileSync(REPORT_PATH, "utf8")) });
			return;
		}
		sendJson(response, 404, { error: `not found: ${request.method} ${url.pathname}` });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		sendJson(response, message === "an eval run is already in progress" ? 409 : 400, { error: message });
	}
}

function main() {
	const port = Number(process.env.PORT ?? 8787);
	const server = createServer((request, response) => { void handleRequest(request, response); });
	server.listen(port, "127.0.0.1", () => {
		const url = `http://127.0.0.1:${port}`;
		console.log(`BeeMax eval control panel: ${url}`);
		if (process.argv.includes("--open")) void import("./open-ui.mjs").then(({ openBrowser }) => openBrowser(url));
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

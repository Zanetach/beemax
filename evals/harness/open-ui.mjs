#!/usr/bin/env node
/**
 * Open the eval control panel in the browser, starting the server first when
 * it is not already running (detached, logs to out/ui-server.log).
 *
 * To avoid tab spam from repeated `make test`, the browser is only opened when
 * this call had to start the server; pass --force to always open. Never exits
 * non-zero — failing to open a browser must not fail a make target.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const URL_BASE = `http://127.0.0.1:${PORT}`;

export function openBrowser(url) {
	const [command, args] = process.platform === "darwin" ? ["open", [url]]
		: process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
		: ["xdg-open", [url]];
	try {
		spawn(command, args, { stdio: "ignore", detached: true }).unref();
		return true;
	} catch {
		return false;
	}
}

async function serverAlive() {
	try {
		const response = await fetch(`${URL_BASE}/api/status`, { signal: AbortSignal.timeout(500) });
		return response.ok;
	} catch {
		return false;
	}
}

async function main() {
	const force = process.argv.includes("--force");
	let started = false;
	if (!(await serverAlive())) {
		mkdirSync(join(HARNESS_DIR, "out"), { recursive: true });
		const log = openSync(join(HARNESS_DIR, "out", "ui-server.log"), "a");
		spawn(process.execPath, [join(HARNESS_DIR, "server.mjs")], {
			cwd: resolve(HARNESS_DIR, "..", ".."),
			detached: true,
			stdio: ["ignore", log, log],
			env: process.env,
		}).unref();
		for (let attempt = 0; attempt < 30 && !(await serverAlive()); attempt++) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
		started = true;
	}
	if (!(await serverAlive())) {
		console.warn(`[ui] could not start the eval panel server; check ${join(HARNESS_DIR, "out", "ui-server.log")}`);
		return;
	}
	if (started || force) {
		openBrowser(URL_BASE);
		console.log(`[ui] eval control panel: ${URL_BASE}${started ? " (server started in background)" : ""}`);
	} else {
		console.log(`[ui] eval control panel already running: ${URL_BASE}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(() => {});
}

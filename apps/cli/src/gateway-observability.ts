import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectOperationalMetrics, type OperationalSnapshot } from "./operational-metrics.ts";
import { serviceInstallationPath } from "./service-platform.ts";

export type GatewayLifecycle = "running" | "stopped" | "failed" | "unknown";
export interface GatewayState {
	profile: string;
	lifecycle: GatewayLifecycle;
	version: string;
	pid?: number;
	startedAt?: string;
	stoppedAt?: string;
	lastError?: string;
}

export function gatewayPaths(agentDir: string): { state: string; events: string; stdout: string; stderr: string } {
	return { state: join(agentDir, "state", "gateway.json"), events: join(agentDir, "logs", "gateway.jsonl"), stdout: join(agentDir, "logs", "gateway.log"), stderr: join(agentDir, "logs", "gateway.error.log") };
}

export function writeGatewayState(agentDir: string, state: GatewayState): void {
	const path = gatewayPaths(agentDir).state;
	mkdirSync(join(agentDir, "state"), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), ...state })}\n`, { mode: 0o600 });
}

export function recordGatewayEvent(agentDir: string, event: "started" | "stopped" | "failed" | "approval" | "proactive_investigation" | "autonomy_blocked" | "context_compaction", fields: Record<string, unknown> = {}): void {
	const path = gatewayPaths(agentDir).events;
	mkdirSync(join(agentDir, "logs"), { recursive: true, mode: 0o700 });
	appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
	if (statSync(path).size > 1_000_000) {
		const retained = readTail(path, 2_000);
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${retained}\n`, { mode: 0o600 }); renameSync(temporary, path);
	}
}

export function inspectGateway(profile: string, agentDir: string, scope: "user" | "system" = "user", cliVersion = "unavailable"): GatewayState & { installation: "installed" | "absent" | "unknown"; service: "running" | "stopped" | "unknown"; health: "healthy" | "degraded" | "unavailable"; logs: "available" | "absent"; state: "available" | "absent"; cliVersion: string; versionMatches: boolean | undefined; operational: OperationalSnapshot } {
	const paths = gatewayPaths(agentDir);
	let current: GatewayState = { profile, lifecycle: "unknown", version: "unavailable" };
	try { current = { ...current, ...JSON.parse(readFileSync(paths.state, "utf8")) as GatewayState }; } catch { /* never started or an older install */ }
	const service = serviceLifecycle(profile, scope);
	if (current.lifecycle === "running" && (service !== "running" || !current.pid || !pidAlive(current.pid))) {
		current = { ...current, lifecycle: service === "stopped" ? "stopped" : "failed", stoppedAt: new Date().toISOString(), lastError: service === "stopped" ? "service is no longer active" : "runtime PID is no longer alive" };
		writeGatewayState(agentDir, current);
		recordGatewayEvent(agentDir, "failed", { profile, reason: current.lastError });
	}
	let installation: "installed" | "absent" | "unknown" = "unknown";
	try { installation = existsSync(serviceInstallationPath(profile, { scope })) ? "installed" : "absent"; } catch { /* unsupported supervisor */ }
	const operational = inspectOperationalMetrics(agentDir);
	const health = operational.alerts.some((alert) => alert.severity === "critical") || current.lifecycle === "failed" ? "degraded" : current.lifecycle === "running" && service === "running" ? "healthy" : "unavailable";
	return { ...current, installation, service, health, cliVersion, versionMatches: current.version === "unavailable" || cliVersion === "unavailable" ? undefined : current.version === cliVersion, logs: existsSync(paths.events) || existsSync(paths.stdout) || existsSync(paths.stderr) ? "available" : "absent", state: existsSync(paths.state) ? "available" : "absent", operational };
}

export function readGatewayLogs(agentDir: string, tail = 200): string {
	const paths = gatewayPaths(agentDir);
	const entries = [["events", paths.events], ["stdout", paths.stdout], ["stderr", paths.stderr]].flatMap(([source, path]) => {
		try { return readTail(path, Math.max(1, tail)).split("\n").filter(Boolean).map((line) => `[${source}] ${line}`); } catch { return []; }
	});
	return entries.length ? entries.slice(-Math.max(1, tail)).join("\n") : "No Gateway logs have been created yet. The Gateway may not have been started for this Profile.";
}

export function boundGatewayProcessLogs(agentDir: string, maxBytes = 10_000_000, retainBytes = 2_000_000): void {
	const paths = gatewayPaths(agentDir);
	for (const path of [paths.stdout, paths.stderr]) {
		try {
			const size = statSync(path).size;
			if (size <= maxBytes) continue;
			const descriptor = openSync(path, "r");
			try {
				const bytes = Math.min(size, retainBytes); const buffer = Buffer.allocUnsafe(bytes);
				readSync(descriptor, buffer, 0, bytes, size - bytes); writeFileSync(path, buffer, { mode: 0o600 });
			} finally { closeSync(descriptor); }
		} catch { /* Logs may not exist or may be managed by the service manager. */ }
	}
}

function readTail(path: string, lines: number): string {
	const size = statSync(path).size;
	const bytes = Math.min(size, Math.max(64 * 1024, lines * 2_048));
	const descriptor = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(bytes); readSync(descriptor, buffer, 0, bytes, size - bytes);
		return buffer.toString("utf8").split("\n").slice(-lines).join("\n").trim();
	} finally { closeSync(descriptor); }
}

function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function serviceLifecycle(profile: string, scope: "user" | "system"): "running" | "stopped" | "unknown" {
	if (process.platform === "darwin") return spawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/com.beemax.agent.${profile}`], { stdio: "ignore" }).status === 0 ? "running" : "stopped";
	if (process.platform === "linux") return spawnSync("systemctl", [...(scope === "user" ? ["--user"] : []), "is-active", "--quiet", `beemax@${profile}.service`], { stdio: "ignore" }).status === 0 ? "running" : "stopped";
	return "unknown";
}

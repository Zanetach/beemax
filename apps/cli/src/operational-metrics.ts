import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InteractionTelemetryEvent } from "@thruvera/core";

const MAX_BYTES = 1_000_000;
const RETAIN_LINES = 2_000;
export interface OperationalAlert { severity: "warning" | "critical"; code: string; detail: string }
export interface OperationalSnapshot { available: boolean; permissionsSafe: boolean; windowMinutes: number; events: number; modelFallbacks: number; replayedEvents: number; planningNoncompliant: number; alerts: OperationalAlert[] }

export function operationalMetricsPath(agentDir: string): string { return join(agentDir, "logs", "operational-metrics.jsonl"); }

export function recordOperationalMetric(agentDir: string, event: InteractionTelemetryEvent, at = Date.now()): void {
	const path = operationalMetricsPath(agentDir);
	mkdirSync(join(agentDir, "logs"), { recursive: true, mode: 0o700 });
	const lock = `${path}.lock`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(lock, "wx", 0o600);
		appendFileSync(path, `${JSON.stringify({ at, ...event })}\n`, { mode: 0o600 });
		if (statSync(path).size > MAX_BYTES) {
			const lines = readFileSync(path, "utf8").trim().split("\n").slice(-RETAIN_LINES);
			const temporary = `${path}.${process.pid}.tmp`;
			writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
			renameSync(temporary, path);
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try { if (descriptor !== undefined) unlinkSync(lock); } catch { /* already released */ }
	}
}

export function inspectOperationalMetrics(agentDir: string, now = Date.now(), windowMinutes = 15): OperationalSnapshot {
	const since = now - Math.max(1, windowMinutes) * 60_000;
	const path = operationalMetricsPath(agentDir);
	const available = existsSync(path);
	const permissionsSafe = !available || (statSync(path).mode & 0o077) === 0;
	const events = available ? readFileSync(path, "utf8").split("\n").flatMap((line) => {
		try { const event = JSON.parse(line); return event.at >= since && event.at <= now ? [event] : []; } catch { return []; }
	}) : [];
	const modelFallbacks = events.filter((event) => event.type === "interaction.model_fallback").length;
	const replayedEvents = events.filter((event) => event.type === "interaction.presenter_reconnected").reduce((sum, event) => sum + Math.max(0, Number(event.gapEvents) || 0), 0);
	const planningNoncompliant = events.filter((event) => event.type === "interaction.planning_completed" && event.compliant === false).length;
	const alerts: OperationalAlert[] = [];
	if (modelFallbacks >= 3) alerts.push({ severity: "warning", code: "model_fallback_spike", detail: `${modelFallbacks} model fallbacks in ${windowMinutes}m` });
	if (planningNoncompliant > 0) alerts.push({ severity: "warning", code: "planning_noncompliant", detail: `${planningNoncompliant} noncompliant plans in ${windowMinutes}m` });
	return { available, permissionsSafe, windowMinutes, events: events.length, modelFallbacks, replayedEvents, planningNoncompliant, alerts };
}

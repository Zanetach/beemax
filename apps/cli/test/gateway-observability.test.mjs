import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { boundGatewayProcessLogs, inspectGateway, readGatewayLogs, recordGatewayEvent, writeGatewayState } from "../dist/gateway-observability.js";
import { inspectOperationalMetrics, recordOperationalMetric } from "../dist/operational-metrics.js";

test("gateway observability distinguishes an absent log from a stopped runtime", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-observability-"));
	try {
		assert.equal(inspectGateway("personal", root).logs, "absent");
		assert.match(readGatewayLogs(root), /No Gateway logs have been created yet/);
		writeGatewayState(root, { profile: "personal", lifecycle: "stopped", version: "v-test" });
		recordGatewayEvent(root, "stopped", { reason: "manual" });
		recordGatewayEvent(root, "context_compaction", { phase: "completed", expectedTaskCount: 2, missingTaskCount: 1, recoveryInjected: true });
		recordGatewayEvent(root, "capability_cognition_fallback", { profile: "personal", code: "provider_unavailable" });
		assert.equal(inspectGateway("personal", root).lifecycle, "stopped");
		assert.match(readGatewayLogs(root), /"event":"stopped"/);
		assert.match(readGatewayLogs(root), /"event":"context_compaction"/);
		assert.match(readGatewayLogs(root), /"event":"capability_cognition_fallback"/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("operational metrics aggregate content-free events and raise bounded alerts", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-metrics-"));
	try {
		for (let index = 0; index < 3; index++) recordOperationalMetric(root, { type: "interaction.model_fallback", surface: "cli", from: "a", to: "b", attempt: index + 1 }, 1_000 + index);
		recordOperationalMetric(root, { type: "interaction.presenter_reconnected", surface: "cli", gapEvents: 20 }, 1_020);
		const snapshot = inspectOperationalMetrics(root, 2_000, 15);
		assert.deepEqual(snapshot.alerts.map((alert) => alert.code), ["model_fallback_spike"]);
		assert.equal(snapshot.events, 4);
		assert.equal(snapshot.replayedEvents, 20);
		assert.equal(snapshot.permissionsSafe, true);
		assert.equal(inspectGateway("personal", root).operational.events, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("gateway logs rotate event history and tail large process logs without loading their full history", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-observability-bounds-"));
	try {
		for (let index = 0; index < 3_000; index++) recordGatewayEvent(root, "context_compaction", { index, detail: "x".repeat(400) });
		assert.ok(statSync(join(root, "logs", "gateway.jsonl")).size <= 1_000_000);
		mkdirSync(join(root, "logs"), { recursive: true });
		writeFileSync(join(root, "logs", "gateway.log"), `${"old\n".repeat(100_000)}latest-line\n`);
		const tail = readGatewayLogs(root, 2);
		assert.match(tail, /latest-line/);
		assert.doesNotMatch(tail, /\[stdout\] old\n\[stdout\] old\n\[stdout\] old/);
		boundGatewayProcessLogs(root, 100_000, 20_000);
		assert.ok(statSync(join(root, "logs", "gateway.log")).size <= 20_000);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

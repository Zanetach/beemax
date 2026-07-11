import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectGateway, readGatewayLogs, recordGatewayEvent, writeGatewayState } from "../dist/gateway-observability.js";

test("gateway observability distinguishes an absent log from a stopped runtime", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-observability-"));
	try {
		assert.equal(inspectGateway("personal", root).logs, "absent");
		assert.match(readGatewayLogs(root), /No Gateway logs have been created yet/);
		writeGatewayState(root, { profile: "personal", lifecycle: "stopped", version: "v-test" });
		recordGatewayEvent(root, "stopped", { reason: "manual" });
		assert.equal(inspectGateway("personal", root).lifecycle, "stopped");
		assert.match(readGatewayLogs(root), /"event":"stopped"/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

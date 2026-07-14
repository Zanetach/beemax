import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { inspectDoctor } from "../dist/doctor.js";
import { executionPortFor, executionSafeTools } from "../dist/execution-composition.js";
import { createProfile } from "../dist/profile-config.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("Execution Sandbox mode exposes only file and command tools that cross ExecutionPort", () => {
	const tools = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"];
	assert.deepEqual(executionSafeTools({ execution: { mode: "all" } }, tools), ["read", "bash", "write", "web_search"]);
	assert.deepEqual(executionSafeTools({ execution: { mode: "off" } }, tools), tools);
});

test("Execution Sandbox composition never treats the Host Execution Adapter as a sandbox", () => {
	const select = executionPortFor({
		profile: "personal",
		paths: { cwd: "/workspace" },
		execution: { backend: "local", mode: "all", workspaceAccess: "none", image: "node:22.19-alpine", timeoutMs: 1_000 },
	});
	assert.throws(() => select(source), /requires the Docker Execution Sandbox/);
});

test("doctor distinguishes trusted host execution from an invalid Sandbox configuration", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-sandbox-doctor-"));
	const paths = await createProfile("sandbox-doctor", { home });
	const config = loadConfig(paths.configPath, "sandbox-doctor");
	config.model.apiKey = "doctor-test";
	const trusted = await inspectDoctor(config, { requireGateway: false });
	assert.deepEqual(trusted.checks.find((check) => check.name === "Execution Sandbox"), {
		name: "Execution Sandbox", status: "WARN", detail: "disabled; Host Execution Adapter has the BeeMax process user's authority (local; mode=off; workspace=none)",
	});
	config.execution.mode = "all";
	const invalid = await inspectDoctor(config, { requireGateway: false });
	assert.deepEqual(invalid.checks.find((check) => check.name === "Execution Sandbox"), {
		name: "Execution Sandbox", status: "FAIL", detail: "Sandbox mode 'all' requires Docker (local; mode=all; workspace=none)",
	});
});

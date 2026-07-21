import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("doctor fails closed before reading or creating state through a cross-Profile Agent directory", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-doctor-profile-boundary-"));
	const first = await createProfile("doctor-first", { home });
	const second = await createProfile("doctor-second", { home });
	const yaml = await readFile(first.configPath, "utf8");
	await writeFile(first.configPath, yaml.replace("  agentDir: .", `  agentDir: ${second.homePath}`));
	const config = loadConfig(first.configPath, "doctor-first");
	config.model.apiKey = "doctor-test";
	const result = await inspectDoctor(config, { requireGateway: false });
	assert.equal(result.ok, false);
	assert.match(result.checks.find((check) => check.name === "Profile boundary")?.detail ?? "", /must stay inside its Profile Home/u);
});

test("doctor validates enabled Caddy with the same credential-free Profile runtime environment", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-caddy-doctor-home-"));
	const paths = await createProfile("caddy-doctor", { home });
	const command = join(paths.homePath, "caddy-fixture");
	const runtimeRoot = join(paths.homePath, "artifact-site", "runtime");
	await writeFile(paths.envPath, [
		"BEEMAX_API_KEY=doctor-model-secret",
		"CADDY_TEST_CREDENTIAL=must-not-reach-caddy",
		"PATH=/profile/attacker-bin",
		"TMP=/profile/attacker-tmp",
		"DISPLAY=profile-attacker-display",
	].join("\n"));
	await writeFile(command, `#!/bin/sh
[ "$PATH" != '/profile/attacker-bin' ] || exit 11
[ "$DISPLAY" != 'profile-attacker-display' ] || exit 12
[ "$TMP" = '${join(runtimeRoot, "tmp")}' ] || exit 13
[ "$TEMP" = '${join(runtimeRoot, "tmp")}' ] || exit 14
[ "$HOME" = '${runtimeRoot}' ] || exit 15
[ "$XDG_CONFIG_HOME" = '${join(runtimeRoot, "config")}' ] || exit 16
[ -z "$CADDY_TEST_CREDENTIAL" ] || exit 17
[ -z "$BEEMAX_API_KEY" ] || exit 18
printf 'v9.9.9-test\n'
`);
	await chmod(command, 0o755);
	const previousHostCommand = process.env.BEEMAX_ARTIFACT_SITE_COMMAND;
	process.env.BEEMAX_ARTIFACT_SITE_COMMAND = command;
	try {
		const config = loadConfig(paths.configPath, "caddy-doctor");
		const available = await inspectDoctor(config, { requireGateway: false });
		assert.deepEqual(available.checks.find((check) => check.name === "Caddy Artifact Site"), {
			name: "Caddy Artifact Site",
			status: "PASS",
			detail: `v9.9.9-test; ${config.gateway.artifactSite.listen}`,
		});

		process.env.BEEMAX_ARTIFACT_SITE_COMMAND = join(paths.homePath, "missing-caddy");
		const missing = await inspectDoctor(loadConfig(paths.configPath, "caddy-doctor"), { requireGateway: false });
		const missingCheck = missing.checks.find((check) => check.name === "Caddy Artifact Site");
		assert.equal(missingCheck?.status, "FAIL");
		assert.match(missingCheck?.detail ?? "", /missing-caddy|ENOENT|no such file/i);
	} finally {
		if (previousHostCommand === undefined) delete process.env.BEEMAX_ARTIFACT_SITE_COMMAND;
		else process.env.BEEMAX_ARTIFACT_SITE_COMMAND = previousHostCommand;
		await rm(home, { recursive: true, force: true });
	}
});

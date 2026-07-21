import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadMcpConfig } from "@beemax/mcp-capability";
import { createProfile } from "../dist/profile-config.js";

const cli = resolve("apps/cli/dist/cli.js");
const fixture = resolve("packages/gateway/test/fixtures/mcp-environment-server.mjs");

test("CLI MCP composition injects the selected Profile environment instead of ambient variables", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-cli-mcp-environment-"));
	const root = resolve(".");
	const paths = await createProfile("mcp-environment", { root, home });
	try {
		await writeFile(paths.envPath, [
			`MCP_SERVER_FIXTURE=${JSON.stringify(fixture)}`,
			"MCP_PROFILE_SECRET=profile-secret-must-not-be-rendered",
		].join("\n") + "\n");
		await writeFile(join(paths.homePath, "mcp.json"), JSON.stringify({
			servers: {
				profile: {
					type: "stdio",
					command: process.execPath,
					args: ["${MCP_SERVER_FIXTURE}", "profile-argument"],
					cwd: join(paths.homePath, "workspace"),
					required: true,
				},
			},
		}));
		const output = execFileSync(process.execPath, [cli, "mcp", "status", "--profile", "mcp-environment"], {
			encoding: "utf8",
			env: {
				...process.env,
				BEEMAX_ROOT: root,
				BEEMAX_HOME: home,
				MCP_SERVER_FIXTURE: join(home, "ambient-fixture-must-not-be-used.mjs"),
			},
		});
		assert.match(output, /PASS\s+profile\s+1 tool\(s\), 0 resource\(s\), 0 prompt\(s\)/);
		assert.doesNotMatch(output, /profile-secret-must-not-be-rendered/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("MCP server stderr is drained privately and cannot print Profile secrets into CLI logs", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-cli-mcp-stderr-"));
	const root = resolve(".");
	const paths = await createProfile("mcp-stderr", { root, home });
	try {
		await writeFile(paths.envPath, `MCP_PROFILE_SECRET=${JSON.stringify("stderr-secret-must-not-leak")}\n`);
		await writeFile(join(paths.homePath, "mcp.json"), JSON.stringify({
			servers: {
				profile: {
					type: "stdio",
					command: process.execPath,
					args: [fixture, "--emit-stderr", "${MCP_PROFILE_SECRET}"],
					required: true,
				},
			},
		}));
		const result = spawnSync(process.execPath, [cli, "mcp", "status", "--profile", "mcp-stderr"], {
			encoding: "utf8",
			env: { ...process.env, BEEMAX_ROOT: root, BEEMAX_HOME: home },
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /PASS\s+profile/u);
		assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /stderr-secret-must-not-leak/u);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Profile-confined MCP loading rejects a manifest symlink that escapes its Profile Home", async () => {
	const profileHome = await mkdtemp(join(tmpdir(), "beemax-mcp-boundary-profile-"));
	const outside = await mkdtemp(join(tmpdir(), "beemax-mcp-boundary-outside-"));
	const configPath = join(profileHome, "nested", "mcp.json");
	try {
		await mkdir(join(profileHome, "nested"));
		await writeFile(join(outside, "mcp.json"), JSON.stringify({ servers: { escaped: { type: "http", url: "https://outside.invalid/mcp" } } }));
		await symlink(join(outside, "mcp.json"), configPath);
		assert.throws(
			() => loadMcpConfig(configPath, { profileHome }),
			/MCP config path must stay physically inside its Profile Home/u,
		);
	} finally {
		await rm(profileHome, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("CLI MCP composition applies the selected modern Profile boundary", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-cli-mcp-boundary-home-"));
	const outside = await mkdtemp(join(tmpdir(), "beemax-cli-mcp-boundary-outside-"));
	const root = resolve(".");
	const paths = await createProfile("mcp-boundary", { root, home });
	try {
		await writeFile(join(outside, "mcp.json"), JSON.stringify({ servers: {} }));
		await symlink(join(outside, "mcp.json"), join(paths.homePath, "mcp.json"));
		assert.throws(
			() => execFileSync(process.execPath, [cli, "mcp", "status", "--profile", "mcp-boundary"], {
				encoding: "utf8",
				env: { ...process.env, BEEMAX_ROOT: root, BEEMAX_HOME: home },
				stdio: "pipe",
			}),
			/MCP config path must stay physically inside its Profile Home/u,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { createProfile } from "../dist/profile-config.js";
import {
	PI_WEB_ACCESS_VERSION,
	inspectStandardWebPack,
	inspectStandardWebSkill,
	installPiWebAccess,
	installStandardWebRuntime,
} from "../dist/profile-capability-pack.js";
import {
	assertProfileBrowserEndpoint,
	inspectProfileBrowser,
	profileBrowserDataDir,
	startProfileBrowser,
	stopProfileBrowser,
} from "../dist/profile-browser.js";

const authorizedInstallation = { enabled: true, allowedProviders: ["exa-mcporter"] };
const providerIntegrityKey = Buffer.alloc(32, 0x42);

async function createBuiltinSkill(root, name) {
	const skill = join(root, "skills", "builtin", name);
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: Test fixture for ${name}.\n---\n`);
}

async function createProfileFixture(prefix, profiles) {
	const root = await mkdtemp(join(tmpdir(), prefix));
	const home = join(root, "home");
	await createBuiltinSkill(root, "agent-reach");
	await createBuiltinSkill(root, "pi-web-access");
	const paths = [];
	for (const profile of profiles) paths.push(await createProfile(profile, { root, home }));
	return { root, home, paths };
}

function unavailableFetch() {
	return Promise.resolve({ ok: false });
}

function assertInside(root, candidate) {
	const path = relative(resolve(root), resolve(candidate));
	assert.equal(isAbsolute(path) || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), false);
}

test("a fresh Profile reports the complete standard Web pack", async () => {
	const fixture = await createProfileFixture("beemax-standard-web-status-", ["fresh-web"]);
	try {
		const [paths] = fixture.paths;
		const status = await inspectStandardWebPack({
			profile: "fresh-web",
			profileHome: paths.homePath,
			agentDir: paths.dataPath,
			installation: authorizedInstallation,
			integrityKey: providerIntegrityKey,
		}, {
			trustedHostEnvironment: { THRUVERA_CHROME_EXECUTABLE: join(fixture.root, "missing-chrome") },
			fetchImpl: unavailableFetch,
			builtinSkillsRoot: join(fixture.root, "skills", "builtin"),
		});

		assert.equal(status.pack, "standard-web");
		assert.deepEqual(status.components.map(({ id, state }) => ({ id, state })), [
			{ id: "exa-web-search", state: "ready_on_demand" },
			{ id: "agent-reach", state: "installed" },
			{ id: "pi-web-access", state: "installed" },
		]);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("standard Web operations refuse an Agent directory owned by another Profile", async () => {
	const fixture = await createProfileFixture("beemax-standard-web-cross-profile-", ["profile-a", "profile-b"]);
	try {
		const [first, second] = fixture.paths;
		await assert.rejects(() => inspectStandardWebPack({
			profile: "profile-a",
			profileHome: first.homePath,
			agentDir: second.dataPath,
			installation: authorizedInstallation,
			integrityKey: providerIntegrityKey,
		}), /must stay inside its Profile Home/u);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("standard Web status does not mislabel a customized same-name Skill as Thruvera-native", async () => {
	const fixture = await createProfileFixture("beemax-standard-web-custom-skill-", ["custom-web"]);
	try {
		const [paths] = fixture.paths;
		await writeFile(join(paths.dataPath, "skills", "agent-reach", "SKILL.md"), "---\nname: agent-reach\ndescription: External replacement.\n---\nRun an external CLI.\n");
		const status = await inspectStandardWebPack({
			profile: "custom-web",
			profileHome: paths.homePath,
			agentDir: paths.dataPath,
			installation: authorizedInstallation,
			integrityKey: providerIntegrityKey,
		}, {
			trustedHostEnvironment: { THRUVERA_CHROME_EXECUTABLE: join(fixture.root, "missing-chrome") },
			fetchImpl: unavailableFetch,
			builtinSkillsRoot: join(fixture.root, "skills", "builtin"),
		});
		assert.equal(status.components.find(({ id }) => id === "agent-reach").state, "customized");
		assert.equal(status.components.find(({ id }) => id === "pi-web-access").state, "installed");
		assert.match(status.components.find(({ id }) => id === "agent-reach").detail, /not claimed as Thruvera-native/);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("standard Web Skill status hashes the complete valid Skill tree", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-standard-web-tree-hash-"));
	const home = join(root, "home");
	try {
		await createBuiltinSkill(root, "agent-reach");
		await createBuiltinSkill(root, "pi-web-access");
		const packagedReference = join(root, "skills", "builtin", "agent-reach", "references", "routing.md");
		await mkdir(dirname(packagedReference), { recursive: true });
		await writeFile(packagedReference, "Packaged routing reference.\n");
		const paths = await createProfile("tree-hash", { root, home });
		const packagedRoot = join(root, "skills", "builtin");
		assert.equal(await inspectStandardWebSkill(paths.dataPath, "agent-reach", packagedRoot), "installed");

		const profileReference = join(paths.dataPath, "skills", "agent-reach", "references", "routing.md");
		await writeFile(profileReference, "Customer-modified routing reference.\n");
		assert.equal(await inspectStandardWebSkill(paths.dataPath, "agent-reach", packagedRoot), "customized");

		await writeFile(profileReference, "Packaged routing reference.\n");
		await writeFile(join(paths.dataPath, "skills", "agent-reach", "customer-note.md"), "Customer extension.\n");
		assert.equal(await inspectStandardWebSkill(paths.dataPath, "agent-reach", packagedRoot), "customized");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("standard Web Skill status rejects a nested symlink instead of calling it customized", async () => {
	const fixture = await createProfileFixture("beemax-standard-web-tree-symlink-", ["tree-symlink"]);
	try {
		const [paths] = fixture.paths;
		const outside = join(fixture.root, "outside-reference.md");
		await writeFile(outside, "External reference.\n");
		await symlink(outside, join(paths.dataPath, "skills", "pi-web-access", "reference.md"));
		assert.equal(
			await inspectStandardWebSkill(paths.dataPath, "pi-web-access", join(fixture.root, "skills", "builtin")),
			"invalid",
		);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("standard Web Skill status fails when the packaged Skill tree becomes unsafe", async () => {
	const fixture = await createProfileFixture("beemax-standard-web-packaged-tree-symlink-", ["packaged-tree-symlink"]);
	try {
		const [paths] = fixture.paths;
		const outside = join(fixture.root, "outside-packaged-reference.md");
		await writeFile(outside, "External packaged reference.\n");
		await symlink(outside, join(fixture.root, "skills", "builtin", "agent-reach", "reference.md"));
		await assert.rejects(
			() => inspectStandardWebSkill(paths.dataPath, "agent-reach", join(fixture.root, "skills", "builtin")),
			/Packaged standard-web Skill is unavailable or invalid/,
		);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("standard Web Skill status distinguishes a valid manifest customization from a broken route", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-standard-web-manifest-"));
	const home = join(root, "home");
	try {
		await createBuiltinSkill(root, "agent-reach");
		await createBuiltinSkill(root, "pi-web-access");
		const packagedSkill = join(root, "skills", "builtin", "agent-reach");
		await writeFile(join(packagedSkill, "workflow.md"), "Packaged workflow.\n");
		await writeFile(join(packagedSkill, "manifest.json"), JSON.stringify({ version: 1, routes: { research: { module: "workflow.md" } } }));
		const paths = await createProfile("manifest", { root, home });
		const profileSkill = join(paths.dataPath, "skills", "agent-reach");
		await writeFile(join(profileSkill, "alternate.md"), "Customer workflow.\n");
		await writeFile(join(profileSkill, "manifest.json"), JSON.stringify({ version: 1, routes: { research: { module: "alternate.md" } } }));
		assert.equal(await inspectStandardWebSkill(paths.dataPath, "agent-reach", join(root, "skills", "builtin")), "customized");

		await rm(join(profileSkill, "alternate.md"));
		assert.equal(await inspectStandardWebSkill(paths.dataPath, "agent-reach", join(root, "skills", "builtin")), "invalid");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("standard Web Skill status rejects an unbounded Profile-local tree", async () => {
	const fixture = await createProfileFixture("beemax-standard-web-tree-budget-", ["tree-budget"]);
	try {
		const [paths] = fixture.paths;
		const references = join(paths.dataPath, "skills", "agent-reach", "references");
		await mkdir(references);
		await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(join(references, `${index}.md`), `${index}\n`)));
		assert.equal(
			await inspectStandardWebSkill(paths.dataPath, "agent-reach", join(fixture.root, "skills", "builtin")),
			"invalid",
		);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("Profile browsers use distinct loopback ports and Profile-owned data directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-browser-isolation-"));
	try {
		const home = join(root, "home");
		await createBuiltinSkill(root, "agent-reach");
		await createBuiltinSkill(root, "pi-web-access");
		const first = await createProfile("browser-a", { root, home });
		const second = await createProfile("browser-b", { root, home });
		const profilePaths = [first.dataPath, second.dataPath];

		const dataDirs = profilePaths.map(profileBrowserDataDir);
		assert.notEqual(dataDirs[0], dataDirs[1]);
		assertInside(profilePaths[0], dataDirs[0]);
		assertInside(profilePaths[1], dataDirs[1]);

		const activeBrowsers = new Map();
		const fetchImpl = async (input) => {
			const endpoint = new URL(String(input));
			const browserPath = activeBrowsers.get(endpoint.origin);
			if (!browserPath) return { ok: false };
			return {
				ok: true,
				json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${endpoint.port}${browserPath}` }),
			};
		};
		const spawns = [];
		const spawnImpl = (command, args, options) => {
			const port = 25_000 + spawns.length;
			const browserPath = `/devtools/browser/profile-${spawns.length}`;
			const dataDir = args.find((argument) => argument.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
			assert.ok(dataDir);
			activeBrowsers.set(`http://127.0.0.1:${port}`, browserPath);
			void writeFile(join(dataDir, "DevToolsActivePort"), `${port}\n${browserPath}\n`);
			const call = { command, args: [...args], options, port, unrefCalls: 0, killCalls: 0 };
			spawns.push(call);
			return { pid: 10_000 + spawns.length, once() {}, unref: () => { call.unrefCalls++; }, kill: () => { call.killCalls++; } };
		};
		const trustedHostEnvironment = {
			THRUVERA_CHROME_EXECUTABLE: process.execPath,
			HOME: join(root, "empty-test-home"),
			PATH: resolve(process.execPath, ".."),
		};

		const started = [];
		for (const agentDir of profilePaths) {
			started.push(await startProfileBrowser(agentDir, { trustedHostEnvironment, fetchImpl, spawnImpl, processAliveImpl: () => true, timeoutMs: 1_000 }));
		}
		assert.deepEqual(started.map(({ state }) => state), ["running", "running"]);
		assert.notEqual(started[0].cdpUrl, started[1].cdpUrl);
		assert.notEqual(new URL(started[0].cdpUrl).port, new URL(started[1].cdpUrl).port);
		assert.equal(spawns.length, 2);
		for (let index = 0; index < spawns.length; index++) {
			assert.equal(spawns[index].command, process.execPath);
			assert.equal(spawns[index].args.filter((argument) => argument.startsWith("--user-data-dir=")).length, 1);
			assert.ok(spawns[index].args.includes(`--user-data-dir=${dataDirs[index]}`));
			assert.ok(spawns[index].args.includes("--remote-debugging-port=0"));
			assert.equal(spawns[index].args.some((argument) => argument.startsWith("--profile-directory=")), false);
			assert.equal(spawns[index].args.some((argument) => /(?:Library[\\/]Application Support[\\/]Google[\\/]Chrome|\.config[\\/](?:google-chrome|chromium))/u.test(argument)), false);
			assert.equal(spawns[index].unrefCalls, 1);
		}

		await writeFile(
			join(profilePaths[1], "state", "pi-web-access", "browser-endpoint.json"),
			await readFile(join(profilePaths[0], "state", "pi-web-access", "browser-endpoint.json")),
		);
		const crossed = await inspectProfileBrowser(profilePaths[1], { trustedHostEnvironment, fetchImpl, processAliveImpl: () => true });
		assert.equal(crossed.state, "port_conflict");
		await assert.rejects(
			() => assertProfileBrowserEndpoint(profilePaths[1], started[0].cdpUrl, { fetchImpl, processAliveImpl: () => true }),
			/not owned by this Profile/i,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Profile browser ownership rejects a live CDP endpoint whose runner heartbeat is stale", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-profile-browser-stale-runner-"));
	const capabilityRoot = join(agentDir, "state", "pi-web-access");
	const dataDir = join(capabilityRoot, "browser-data");
	const cdpUrl = "http://127.0.0.1:26777";
	const browserPath = "/devtools/browser/stale-runner";
	try {
		await mkdir(dataDir, { recursive: true });
		await writeFile(join(dataDir, "DevToolsActivePort"), `26777\n${browserPath}\n`);
		await writeFile(join(capabilityRoot, "browser-endpoint.json"), JSON.stringify({ schemaVersion: "beemax.profile-browser-endpoint.v1", cdpUrl }));
		await writeFile(join(capabilityRoot, "browser-process.json"), JSON.stringify({
			schemaVersion: "beemax.profile-browser.v1",
			pid: 14_001,
			runnerToken: "runner-token",
			browserPid: 14_002,
			cdpUrl,
			dataDir,
			startedAt: Date.now() - 60_000,
		}));
		await writeFile(join(capabilityRoot, "browser-runner.json"), JSON.stringify({
			schemaVersion: "beemax.profile-browser-runner.v1",
			token: "runner-token",
			runnerPid: 14_001,
			browserPid: 14_002,
			updatedAt: Date.now() - 60_000,
		}));
		const inspected = await inspectProfileBrowser(agentDir, {
			trustedHostEnvironment: { THRUVERA_CHROME_EXECUTABLE: process.execPath },
			fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:26777${browserPath}` }) }),
			processAliveImpl: () => true,
		});
		assert.equal(inspected.state, "port_conflict");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Profile browser stop terminates the owned runner group and removes endpoint state", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-profile-browser-stop-"));
	const capabilityRoot = join(agentDir, "state", "pi-web-access");
	const dataDir = join(capabilityRoot, "browser-data");
	const cdpUrl = "http://127.0.0.1:26778";
	const browserPath = "/devtools/browser/stoppable-runner";
	const alive = new Set([15_001, 15_002]);
	const signals = [];
	try {
		await mkdir(dataDir, { recursive: true });
		await writeFile(join(dataDir, "DevToolsActivePort"), `26778\n${browserPath}\n`);
		await writeFile(join(capabilityRoot, "browser-endpoint.json"), JSON.stringify({ schemaVersion: "beemax.profile-browser-endpoint.v1", cdpUrl }));
		await writeFile(join(capabilityRoot, "browser-process.json"), JSON.stringify({
			schemaVersion: "beemax.profile-browser.v1", pid: 15_001, runnerToken: "00000000-0000-4000-8000-000000000001",
			browserPid: 15_002, cdpUrl, dataDir, startedAt: Date.now(),
		}));
		await writeFile(join(capabilityRoot, "browser-runner.json"), JSON.stringify({
			schemaVersion: "beemax.profile-browser-runner.v1", token: "00000000-0000-4000-8000-000000000001",
			runnerPid: 15_001, browserPid: 15_002, updatedAt: Date.now(),
		}));
		const result = await stopProfileBrowser(agentDir, {
			processAliveImpl: (pid) => alive.has(pid),
			killImpl: (pid, signal) => { signals.push([pid, signal]); alive.clear(); },
			fetchImpl: async () => alive.has(15_002)
				? { ok: true, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:26778${browserPath}` }) }
				: { ok: false },
			timeoutMs: 500,
		});
		assert.equal(result.state, "stopped");
		assert.ok(signals.some(([, signal]) => signal === "SIGTERM"));
		for (const name of ["browser-endpoint.json", "browser-process.json", "browser-runner.json"]) {
			await assert.rejects(() => readFile(join(capabilityRoot, name)), /ENOENT/u);
		}
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("standard Web runtime rejects a symlinked providers directory", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-standard-web-provider-link-"));
	const outside = await mkdtemp(join(tmpdir(), "beemax-standard-web-provider-outside-"));
	let commandCalls = 0;
	try {
		await symlink(outside, join(agentDir, "providers"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(() => installStandardWebRuntime({
			profile: "provider-link",
			profileHome: agentDir,
			agentDir,
			installation: authorizedInstallation,
			integrityKey: providerIntegrityKey,
			runProviderCommand: async () => { commandCalls++; },
		}), /real directory/i);
		assert.equal(commandCalls, 0);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("Profile browser refuses a symlinked state directory before spawning", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-profile-browser-state-link-"));
	const outside = await mkdtemp(join(tmpdir(), "beemax-profile-browser-state-outside-"));
	let spawnCalls = 0;
	try {
		await symlink(outside, join(agentDir, "state"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(() => inspectProfileBrowser(agentDir, {
			trustedHostEnvironment: { THRUVERA_CHROME_EXECUTABLE: process.execPath, HOME: join(agentDir, "empty-test-home") },
			fetchImpl: unavailableFetch,
		}), /real directory/i);
		await assert.rejects(() => startProfileBrowser(agentDir, {
			trustedHostEnvironment: { THRUVERA_CHROME_EXECUTABLE: process.execPath, HOME: join(agentDir, "empty-test-home") },
			fetchImpl: unavailableFetch,
			spawnImpl: () => { spawnCalls++; return { pid: 1, unref() {} }; },
		}), /real directory/i);
		assert.equal(spawnCalls, 0);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("Profile browser refuses a symlinked process record without touching its target", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-profile-browser-record-link-"));
	const outside = join(await mkdtemp(join(tmpdir(), "beemax-profile-browser-record-target-")), "outside.json");
	let spawnCalls = 0;
	try {
		const capabilityRoot = join(agentDir, "state", "pi-web-access");
		await mkdir(join(capabilityRoot, "browser-data"), { recursive: true });
		await writeFile(outside, "preserve-me");
		await symlink(outside, join(capabilityRoot, "browser-process.json"));
		await assert.rejects(() => startProfileBrowser(agentDir, {
			trustedHostEnvironment: { THRUVERA_CHROME_EXECUTABLE: process.execPath, HOME: join(agentDir, "empty-test-home") },
			fetchImpl: unavailableFetch,
			spawnImpl: () => { spawnCalls++; return { pid: 1, once() {}, unref() {}, kill() {} }; },
		}), /regular file/i);
		assert.equal(spawnCalls, 0);
		assert.equal(await readFile(outside, "utf8"), "preserve-me");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(dirname(outside), { recursive: true, force: true });
	}
});

test("Profile browser safely recovers a dead-owner start lock", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-profile-browser-stale-lock-"));
	const capabilityRoot = join(agentDir, "state", "pi-web-access");
	const dataDir = join(capabilityRoot, "browser-data");
	let browserPath;
	try {
		await mkdir(dataDir, { recursive: true });
		await writeFile(join(capabilityRoot, "browser-start.lock"), JSON.stringify({ pid: 2_147_483_647, token: "stale" }));
		const fetchImpl = async (input) => {
			const endpoint = new URL(String(input));
			return browserPath ? { ok: true, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${endpoint.port}${browserPath}` }) } : { ok: false };
		};
		const started = await startProfileBrowser(agentDir, {
			trustedHostEnvironment: { THRUVERA_CHROME_EXECUTABLE: process.execPath, HOME: join(agentDir, "empty-test-home") },
			fetchImpl,
			processAliveImpl: (pid) => pid === 12_001,
			spawnImpl: (_command, args) => {
				browserPath = "/devtools/browser/recovered";
				const target = args.find((argument) => argument.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
				void writeFile(join(target, "DevToolsActivePort"), `26001\n${browserPath}\n`);
				return { pid: 12_001, once() {}, unref() {}, kill() {} };
			},
			timeoutMs: 1_000,
		});
		assert.equal(started.state, "running");
		await assert.rejects(() => readFile(join(capabilityRoot, "browser-start.lock")), /ENOENT/);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("failed browser startup escalates termination and quarantines an unkillable process", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "beemax-profile-browser-quarantine-"));
	const signals = [];
	try {
		await assert.rejects(() => startProfileBrowser(agentDir, {
			trustedHostEnvironment: { THRUVERA_CHROME_EXECUTABLE: process.execPath, HOME: join(agentDir, "empty-test-home") },
			fetchImpl: unavailableFetch,
			processAliveImpl: () => true,
			spawnImpl: () => ({ pid: 12_002, once() {}, unref() {}, kill: (signal) => { signals.push(signal); return true; } }),
			timeoutMs: 1_000,
		}), /still-running process was quarantined/i);
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
		const quarantine = JSON.parse(await readFile(join(agentDir, "state", "pi-web-access", "browser-quarantine.json"), "utf8"));
		assert.equal(quarantine.pid, 12_002);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Pi Web Access installation is network-free and idempotent", async () => {
	const expected = {
		installed: false,
		path: "@thruvera/core/browser-tools",
		evidenceRef: `builtin:${PI_WEB_ACCESS_VERSION}`,
		revision: PI_WEB_ACCESS_VERSION,
	};
	assert.deepEqual(await installPiWebAccess(), expected);
	assert.deepEqual(await installPiWebAccess(), expected);
});

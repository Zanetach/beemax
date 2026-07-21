import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXA_MCPORTER_LOCK_SHA256, EXA_MCPORTER_PROVIDER_VERSION, createProfileCapabilityProviderBundle } from "../dist/capability-provider-composition.js";
import { CapabilityProviderRuntime, createWebTools } from "../../../packages/core/dist/index.js";

const provider = (installed) => ({
	id: "exa-mcporter", kind: "tool", capabilities: ["web_search"], installed,
	install: { source: "beemax-provider-lock", package: "mcporter", version: EXA_MCPORTER_PROVIDER_VERSION },
});

test("Profile Provider composition installs only a pinned pre-authorized adapter and returns evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-provider-"));
	const commands = [];
	let installed = false;
	try {
		const bundle = createProfileCapabilityProviderBundle({
			profileId: "profile:test", agentDir: root,
			installation: { enabled: true, allowedProviders: ["exa-mcporter"] },
			environment: { PATH: process.env.PATH, MODEL_API_KEY: "must-not-enter-installer" },
			now: () => 42,
			runCommand: async (command, args, options) => {
				commands.push({ command, args: [...args], env: options.env });
				await mkdir(join(options.cwd, "node_modules", "mcporter", "dist"), { recursive: true });
				await writeFile(join(options.cwd, "node_modules", "mcporter", "dist", "cli.js"), "stub");
				installed = true;
			},
		});
		const result = await bundle.runtime.acquire({ capability: "web_search", providers: [{ ...provider(false), health: async () => installed ? { status: "ready", evidenceRef: "health:exa-mcporter" } : { status: "unavailable", reason: "not installed" } }] });
		assert.equal(result.status, "ready");
		assert.equal(result.installationReceipt?.installedAt, 42);
		assert.match(result.installationReceipt?.evidenceRef ?? "", /^sha256:[a-f0-9]{64}$/);
		assert.match(result.authorityEvidenceRef ?? "", /^profile-config:[a-f0-9]{64}$/);
		assert.equal(commands.length, 1);
		assert.deepEqual(commands[0].args, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"]);
		assert.equal(commands.every((entry) => entry.env.MODEL_API_KEY === undefined), true);
		assert.equal(bundle.environment.MODEL_API_KEY, undefined);
		assert.match(bundle.environment.BEEMAX_AGENT_REACH_MCPORTER ?? "", /providers[/\\]exa-mcporter/);
		assert.equal(EXA_MCPORTER_LOCK_SHA256.length, 64);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Profile Provider composition gives a cold pinned npm install more than sixty seconds", async (context) => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-provider-cold-timeout-"));
	let installationSignal;
	let installationStartedResolve;
	let releaseInstallationResolve;
	const installationStarted = new Promise((resolve) => { installationStartedResolve = resolve; });
	const releaseInstallation = new Promise((resolve) => { releaseInstallationResolve = resolve; });
	context.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const bundle = createProfileCapabilityProviderBundle({
			profileId: "profile:test", agentDir: root,
			installation: { enabled: true, allowedProviders: ["exa-mcporter"] },
			runCommand: async (_command, _args, options) => {
				installationSignal = options.signal;
				installationStartedResolve();
				await releaseInstallation;
				await mkdir(join(options.cwd, "node_modules", "mcporter", "dist"), { recursive: true });
				await writeFile(join(options.cwd, "node_modules", "mcporter", "dist", "cli.js"), "stub");
			},
		});
		const acquisition = bundle.runtime.acquire({ capability: "web_search", providers: [{ ...provider(false), health: async () => ({ status: "ready", evidenceRef: "health:exa-mcporter" }) }] });
		await installationStarted;
		context.mock.timers.tick(60_001);
		await Promise.resolve();
		assert.equal(installationSignal.aborted, false, "a normal cold installation must not enter outcome-unknown quarantine at sixty seconds");
		releaseInstallationResolve();
		assert.equal((await acquisition).status, "ready");
	} finally {
		releaseInstallationResolve();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Profile Provider composition gives integrity-backed health probes more than five seconds", async (context) => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-provider-health-timeout-"));
	let healthSignal;
	let healthStartedResolve;
	let releaseHealthResolve;
	const healthStarted = new Promise((resolve) => { healthStartedResolve = resolve; });
	const releaseHealth = new Promise((resolve) => { releaseHealthResolve = resolve; });
	context.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const bundle = createProfileCapabilityProviderBundle({ profileId: "profile:test", agentDir: root, installation: { enabled: true, allowedProviders: ["exa-mcporter"] } });
		const resolution = bundle.runtime.resolve({ capability: "web_search", providers: [{ ...provider(true), health: async (signal) => {
			healthSignal = signal;
			healthStartedResolve();
			await releaseHealth;
			return { status: "ready", evidenceRef: "health:exa-mcporter" };
		} }] });
		await healthStarted;
		context.mock.timers.tick(5_001);
		await Promise.resolve();
		assert.equal(healthSignal.aborted, false, "integrity verification must not be classified unavailable after only five seconds");
		releaseHealthResolve();
		assert.equal((await resolution).status, "ready");
	} finally {
		releaseHealthResolve();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Profile Provider composition serializes concurrent installation and atomically reuses the first result", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-provider-concurrent-"));
	let commands = 0;
	let installed = false;
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	try {
		const bundle = createProfileCapabilityProviderBundle({
			profileId: "profile:test", agentDir: root,
			installation: { enabled: true, allowedProviders: ["exa-mcporter"] },
			runCommand: async (_command, _args, options) => {
				commands++;
				await gate;
				await mkdir(join(options.cwd, "node_modules", "mcporter", "dist"), { recursive: true });
				await writeFile(join(options.cwd, "node_modules", "mcporter", "dist", "cli.js"), "stub");
				installed = true;
			},
		});
		const descriptor = { ...provider(() => installed), health: async () => installed ? { status: "ready", evidenceRef: "health:exa-mcporter" } : { status: "unavailable", reason: "not installed" } };
		const first = bundle.runtime.acquire({ capability: "web_search", providers: [descriptor] });
		const second = bundle.runtime.acquire({ capability: "web_search", providers: [descriptor] });
		await new Promise((resolve) => setTimeout(resolve, 30));
		release();
		const results = await Promise.all([first, second]);
		assert.equal(commands, 1);
		assert.equal(results.every((result) => result.status === "ready"), true);
		assert.equal(results[0].installationReceipt?.evidenceRef, results[1].installationReceipt?.evidenceRef);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("interrupted Provider installation requires an evidence-backed reconciliation acquisition before retry", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-provider-quarantine-"));
	let commands = 0;
	let installationStartedResolve;
	const installationStarted = new Promise((resolve) => { installationStartedResolve = resolve; });
	try {
		const bundle = createProfileCapabilityProviderBundle({
			profileId: "profile:test", agentDir: root,
			installation: { enabled: true, allowedProviders: ["exa-mcporter"] },
			runCommand: async (_command, _args, options) => {
				commands++;
				if (commands === 1) {
					installationStartedResolve();
					await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
				}
				await mkdir(join(options.cwd, "node_modules", "mcporter", "dist"), { recursive: true });
				await writeFile(join(options.cwd, "node_modules", "mcporter", "dist", "cli.js"), "stub");
			},
		});
		const descriptor = { ...provider(() => commands > 1), health: async () => commands > 1 ? { status: "ready", installationState: "present", evidenceRef: "health:exa-mcporter" } : { status: "unavailable", installationState: "absent", evidenceRef: "health:exa-mcporter:absent", reason: "installation is observably absent" } };
		const controller = new AbortController();
		const first = bundle.runtime.acquire({ capability: "web_search", providers: [descriptor], signal: controller.signal });
		await installationStarted;
		controller.abort(new Error("cancelled by test"));
		const interrupted = await first;
		assert.equal(interrupted.blocker?.code, "installation_outcome_unknown");
		const attached = await bundle.runtime.acquire({ capability: "web_search", providers: [descriptor] });
		assert.equal(attached.blocker?.code, "installation_outcome_unknown");
		assert.equal(commands, 1, "the reconciliation acquisition must not overlap or retry the interrupted install");
		let reconciled;
		const reconciliationDeadline = Date.now() + 5_000;
		do {
			await new Promise((resolve) => setTimeout(resolve, 10));
			reconciled = await bundle.runtime.acquire({ capability: "web_search", providers: [descriptor] });
			if (reconciled.blocker?.code !== "installation_outcome_unknown") break;
		} while (Date.now() < reconciliationDeadline);
		assert.equal(reconciled.blocker?.code, "provider_unavailable");
		assert.equal(commands, 1, "explicit absence reconciliation must not install");
		const retry = await bundle.runtime.acquire({ capability: "web_search", providers: [descriptor] });
		assert.equal(retry.status, "ready", JSON.stringify(retry));
		assert.equal(commands, 2);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a Runtime bounds acquisition while the same Provider installer is still settling", async () => {
	let attempts = 0;
	let installationStartedResolve;
	let releaseFirstResolve;
	const installationStarted = new Promise((resolve) => { installationStartedResolve = resolve; });
	const releaseFirst = new Promise((resolve) => { releaseFirstResolve = resolve; });
	const runtime = new CapabilityProviderRuntime({
		installTimeoutMs: 100,
		installAuthority: { authorize: async () => ({ allowed: true, evidenceRef: "authority:test" }) },
		installer: { install: async () => {
			attempts++;
			if (attempts === 1) {
				installationStartedResolve();
				await releaseFirst;
				throw new Error("interrupted installer cleanup settled");
			}
			releaseFirstResolve();
			return { receiptId: "receipt:test", installedAt: 1, evidenceRef: "install:test" };
		} },
	});
	const descriptor = { ...provider(false), health: async () => ({ status: "ready", evidenceRef: "health:test" }) };
	const controller = new AbortController();
	try {
		const first = runtime.acquire({ capability: "web_search", providers: [descriptor], signal: controller.signal });
		await installationStarted;
		controller.abort(new Error("cancelled by test"));
		assert.equal((await first).blocker?.code, "installation_outcome_unknown");

		const retry = await runtime.acquire({ capability: "web_search", providers: [descriptor] });
		assert.equal(retry.blocker?.code, "installation_outcome_unknown");
		assert.equal(attempts, 1, "the Runtime must not overlap a still-settling installer for the same Provider");
	} finally {
		releaseFirstResolve();
	}
});

test("Profile Provider composition rejects a symlinked installation root", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-provider-symlink-"));
	const outside = mkdtempSync(join(tmpdir(), "beemax-profile-provider-outside-"));
	try {
		await mkdir(join(root, "providers"), { mode: 0o700 });
		await symlink(outside, join(root, "providers", "exa-mcporter"));
		const bundle = createProfileCapabilityProviderBundle({ profileId: "profile:test", agentDir: root, installation: { enabled: true, allowedProviders: ["exa-mcporter"] }, runCommand: async () => assert.fail("must not execute") });
		const result = await bundle.runtime.acquire({ capability: "web_search", providers: [{ ...provider(false), health: async () => ({ status: "unavailable", reason: "not installed" }) }] });
		assert.equal(result.status, "blocked");
		assert.match(result.blocker?.reason ?? "", /real directory/i);
	} finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("published Provider integrity rejects tampering and oversized sparse artifacts before health", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-provider-integrity-"));
	const cliText = `console.log(JSON.stringify({ status: "ok", tools: [{ name: "web_search_exa" }] }));`;
	try {
		const bundle = createProfileCapabilityProviderBundle({
			profileId: "profile:test", agentDir: root, installation: { enabled: true, allowedProviders: ["exa-mcporter"] },
				runCommand: async (_command, _args, options) => {
					await mkdir(join(options.cwd, "node_modules", "mcporter", "dist"), { recursive: true });
					await writeFile(join(options.cwd, "node_modules", "mcporter", "dist", "cli.js"), cliText);
					await mkdir(join(options.cwd, "node_modules", "transitive-dependency"), { recursive: true });
					await writeFile(join(options.cwd, "node_modules", "transitive-dependency", "data.txt"), "trusted");
				},
			});
			const webProvider = createWebTools({ env: bundle.environment }).find((tool) => tool.name === "web_search").providers.find((candidate) => candidate.id === "exa-mcporter");
			assert.equal((await bundle.runtime.acquire({ capability: "web_search", providers: [webProvider] })).status, "ready");
			const current = join(root, "providers", "exa-mcporter", "current");
			const cli = join(current, "node_modules", "mcporter", "dist", "cli.js");
			const config = join(current, "home", ".agent-reach", "mcporter.json");
			const dependency = join(current, "node_modules", "transitive-dependency", "data.txt");
			const configText = await readFile(config, "utf8");
			const firstAbort = new AbortController();
			const cancelledFirst = webProvider.health(firstAbort.signal);
			const healthySecond = webProvider.health(new AbortController().signal);
			firstAbort.abort(new Error("cancel first verification only"));
			assert.notEqual((await cancelledFirst).status, "ready");
			assert.equal((await healthySecond).status, "ready");
			const queuedAbort = new AbortController();
			const healthyFirst = webProvider.health(new AbortController().signal);
			const cancelledSecond = webProvider.health(queuedAbort.signal);
			queuedAbort.abort(new Error("cancel queued verification only"));
			assert.notEqual((await cancelledSecond).status, "ready");
			assert.equal((await healthyFirst).status, "ready");
			await writeFile(cli, "console.log('tampered')");
			assert.equal((await bundle.runtime.resolve({ capability: "web_search", providers: [webProvider] })).status, "blocked");
			await writeFile(cli, cliText);
			await writeFile(config, JSON.stringify({ mcpServers: { exa: { baseUrl: "https://attacker.invalid/mcp" } }, imports: [] }));
			assert.equal((await bundle.runtime.resolve({ capability: "web_search", providers: [webProvider] })).status, "blocked");
			await writeFile(config, configText);
			await writeFile(dependency, "tampered");
			assert.equal((await bundle.runtime.resolve({ capability: "web_search", providers: [webProvider] })).status, "blocked");
			await writeFile(dependency, "trusted");
			await truncate(cli, 17 * 1024 * 1024);
			assert.equal((await bundle.runtime.resolve({ capability: "web_search", providers: [webProvider] })).status, "blocked");
			await writeFile(cli, cliText);
			await truncate(dependency, 513 * 1024 * 1024);
			assert.equal((await bundle.runtime.resolve({ capability: "web_search", providers: [webProvider] })).status, "blocked");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("two waiters reconcile one stale dead-owner lock without breaking installation mutual exclusion", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-provider-stale-lock-"));
	let commands = 0;
	try {
		const providerRoot = join(root, "providers", "exa-mcporter");
		await mkdir(providerRoot, { recursive: true, mode: 0o700 });
		await writeFile(join(providerRoot, ".install.lock.json"), JSON.stringify({ pid: 2_147_483_647, startedAt: 1 }));
		const options = {
			profileId: "profile:test", agentDir: root, installation: { enabled: true, allowedProviders: ["exa-mcporter"] },
			runCommand: async (_command, _args, options) => {
				commands++;
				await new Promise((resolve) => setTimeout(resolve, 25));
				await mkdir(join(options.cwd, "node_modules", "mcporter", "dist"), { recursive: true });
				await writeFile(join(options.cwd, "node_modules", "mcporter", "dist", "cli.js"), "stub");
			},
		};
		const bundles = [createProfileCapabilityProviderBundle(options), createProfileCapabilityProviderBundle(options)];
		const results = await Promise.all(bundles.map((bundle) => bundle.runtime.acquire({ capability: "web_search", providers: [{ ...provider(false), health: async () => ({ status: "ready", evidenceRef: "health:exa-mcporter" }) }] })));
		assert.deepEqual(results.map((result) => result.status), ["ready", "ready"]);
		assert.equal(commands, 1);
		assert.deepEqual((await readdir(providerRoot)).filter((name) => name.startsWith(".stale-lock-claim-")), []);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a tombstone cleanup fault still releases the live installation lock", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-provider-prune-fault-"));
	let commands = 0;
	try {
		const providerRoot = join(root, "providers", "exa-mcporter");
		const invalidTombstone = join(providerRoot, `.stale-lock-claim-${"a".repeat(64)}.json`);
		await mkdir(invalidTombstone, { recursive: true });
		const bundle = createProfileCapabilityProviderBundle({
			profileId: "profile:test", agentDir: root, installation: { enabled: true, allowedProviders: ["exa-mcporter"] },
			runCommand: async (_command, _args, options) => {
				commands++;
				await mkdir(join(options.cwd, "node_modules", "mcporter", "dist"), { recursive: true });
				await writeFile(join(options.cwd, "node_modules", "mcporter", "dist", "cli.js"), "stub");
			},
		});
		const descriptor = { ...provider(false), health: async () => ({ status: "ready", evidenceRef: "health:exa-mcporter" }) };
		assert.equal((await bundle.runtime.acquire({ capability: "web_search", providers: [descriptor] })).status, "blocked");
		assert.equal((await readdir(providerRoot)).includes(".install.lock.json"), false);
		rmSync(invalidTombstone, { recursive: true, force: true });
		assert.equal((await bundle.runtime.acquire({ capability: "web_search", providers: [descriptor] })).status, "ready");
		assert.equal(commands, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Profile Provider composition denies installation when the exact Provider is not pre-authorized", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-profile-provider-denied-"));
	let commands = 0;
	try {
		const bundle = createProfileCapabilityProviderBundle({ profileId: "profile:test", agentDir: root, installation: { enabled: true, allowedProviders: [] }, runCommand: async () => { commands++; } });
		const result = await bundle.runtime.acquire({ capability: "web_search", providers: [{ ...provider(false), health: async () => ({ status: "ready", evidenceRef: "health:exa-mcporter" }) }] });
		assert.equal(result.status, "blocked");
		assert.equal(result.blocker?.code, "installation_denied");
		assert.match(result.blocker?.reason ?? "", /not pre-authorized/i);
		assert.equal(commands, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

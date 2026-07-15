import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityProviderRuntime, providerArtifactSha256, providerFileSha256, providerManifestEvidenceRef, verifyProviderArtifact, type CapabilityProviderDescriptor, type CapabilityProviderInstallReceipt, type ProviderArtifactManifest } from "@beemax/core";

export const EXA_MCPORTER_VERSION = "0.9.0";
export const EXA_MCPORTER_LOCK_SHA256 = "7c8ca25b89c4a23618c4385a373660cbf23512d7f461e82f2197c19027a183ec";
export const EXA_MCPORTER_PROVIDER_VERSION = `mcporter:${EXA_MCPORTER_VERSION}:lock:${EXA_MCPORTER_LOCK_SHA256}`;
const EXA_MCPORTER_SOURCE = "beemax-provider-lock";
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;

export interface ProfileCapabilityProviderInstallationPolicy {
	enabled: boolean;
	allowedProviders: readonly string[];
}

export interface CapabilityProviderCommandOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
}

export type CapabilityProviderCommandRunner = (command: string, args: readonly string[], options: CapabilityProviderCommandOptions) => Promise<void>;

export interface ProfileCapabilityProviderBundle {
	runtime: CapabilityProviderRuntime;
	environment: NodeJS.ProcessEnv;
}

/** Profile-scoped production composition for approved, reproducibly locked Provider adapters. */
export function createProfileCapabilityProviderBundle(input: {
	profileId: string;
	agentDir: string;
	installation: ProfileCapabilityProviderInstallationPolicy;
	environment?: NodeJS.ProcessEnv;
	runCommand?: CapabilityProviderCommandRunner;
	now?: () => number;
}): ProfileCapabilityProviderBundle {
	const profileId = identifier(input.profileId, "Profile id");
	const agentDir = resolve(input.agentDir);
	const allowedProviders = new Set(input.installation.allowedProviders.map((value) => identifier(value, "Allowed Provider id")));
	const providerRoot = join(agentDir, "providers", "exa-mcporter");
	const currentRoot = join(providerRoot, "current");
	const providerHome = join(currentRoot, "home");
	const executableRoot = join(currentRoot, "node_modules", ".bin");
	const mcporterBinary = join(currentRoot, "node_modules", "mcporter", "dist", "cli.js");
	const mcporterConfig = join(providerHome, ".agent-reach", "mcporter.json");
	const installManifest = join(currentRoot, "beemax-provider.json");
	const baseEnvironment = input.environment ?? process.env;
	const environment: NodeJS.ProcessEnv = {
		...(baseEnvironment.TAVILY_API_KEY ? { TAVILY_API_KEY: baseEnvironment.TAVILY_API_KEY } : {}),
		...(baseEnvironment.BRAVE_SEARCH_API_KEY ? { BRAVE_SEARCH_API_KEY: baseEnvironment.BRAVE_SEARCH_API_KEY } : {}),
		...(baseEnvironment.SEARXNG_URL ? { SEARXNG_URL: baseEnvironment.SEARXNG_URL } : {}),
		BEEMAX_AGENT_REACH_ROOT: currentRoot,
		BEEMAX_AGENT_REACH_MCPORTER: mcporterBinary,
		BEEMAX_AGENT_REACH_CONFIG: mcporterConfig,
		BEEMAX_AGENT_REACH_MANIFEST: installManifest,
		BEEMAX_AGENT_REACH_HOME: providerHome,
		BEEMAX_AGENT_REACH_PATH: [executableRoot, baseEnvironment.PATH ?? ""].filter(Boolean).join(delimiter),
		...(baseEnvironment.LANG ? { LANG: baseEnvironment.LANG } : {}),
		...(baseEnvironment.LC_ALL ? { LC_ALL: baseEnvironment.LC_ALL } : {}),
	};
	const runCommand = input.runCommand ?? executeCommand;
	const now = input.now ?? Date.now;
	const policyEvidence = `profile-config:${createHash("sha256").update(JSON.stringify({ profileId, enabled: input.installation.enabled, allowedProviders: [...allowedProviders].sort() })).digest("hex")}`;

	const runtime = new CapabilityProviderRuntime({
		installAuthority: {
			authorize: async ({ provider }) => input.installation.enabled && allowedProviders.has(provider.id)
				? { allowed: true, evidenceRef: policyEvidence }
				: { allowed: false, reason: `Profile ${profileId} has not pre-authorized installation of Provider ${provider.id}` },
		},
		installer: {
			install: async (provider, signal) => {
				assertExaMcporterProvider(provider);
				await secureProviderRoot(agentDir, providerRoot);
				return withProviderInstallLock(providerRoot, signal, async () => {
					const existing = await readValidInstallation(currentRoot);
					if (existing) return receiptFromManifest(existing);
					const quarantine = join(providerRoot, "installation-unknown.json");
					await reconcileQuarantine(providerRoot, quarantine);

					const stagingRoot = join(providerRoot, `.staging-${randomUUID()}`);
					const journal = join(providerRoot, "installation-in-progress.json");
					const startedAt = now();
					await mkdir(stagingRoot, { mode: 0o700 });
					await writePrivateJson(journal, { schemaVersion: "beemax.provider-install-journal.v1", provider: provider.id, pid: process.pid, startedAt, stagingRoot });
					try {
						const lockSource = providerLockRoot();
						const lockBytes = await readFile(join(lockSource, "package-lock.json"));
						if (sha256(lockBytes) !== EXA_MCPORTER_LOCK_SHA256) throw new Error("Bundled Exa mcporter Provider dependency lock failed its SHA-256 verification");
						await copyFile(join(lockSource, "package.json"), join(stagingRoot, "package.json"));
						await copyFile(join(lockSource, "package-lock.json"), join(stagingRoot, "package-lock.json"));
						const commandEnvironment = installationEnvironment(baseEnvironment, join(stagingRoot, "home"), join(stagingRoot, "node_modules", ".bin"));
						const npm = baseEnvironment.BEEMAX_NPM?.trim() || "npm";
						await runCommand(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"], { cwd: stagingRoot, env: commandEnvironment, signal });
						const stagingHome = join(stagingRoot, "home");
						const stagingAgentReach = join(stagingHome, ".agent-reach");
						await mkdir(stagingAgentReach, { recursive: true, mode: 0o700 });
						await writeFile(join(stagingAgentReach, "mcporter.json"), `${JSON.stringify({ mcpServers: { exa: { baseUrl: "https://mcp.exa.ai/mcp" } }, imports: [] }, null, 2)}\n`, { mode: 0o600 });
						await requireRegularFileInside(stagingRoot, join(stagingRoot, "node_modules", "mcporter", "dist", "cli.js"));
						await requireRegularFileInside(stagingRoot, join(stagingAgentReach, "mcporter.json"));
						const installedAt = now();
						const [artifactSha256, entrypointSha256, configurationSha256] = await Promise.all([
							providerArtifactSha256(stagingRoot, signal),
							providerFileSha256(join(stagingRoot, "node_modules", "mcporter", "dist", "cli.js")),
							providerFileSha256(join(stagingAgentReach, "mcporter.json")),
						]);
						const unsignedManifest: Omit<ProviderArtifactManifest, "evidenceRef"> = {
							schemaVersion: "beemax.provider-artifact.v1", providerId: "exa-mcporter", version: EXA_MCPORTER_PROVIDER_VERSION,
							lockSha256: EXA_MCPORTER_LOCK_SHA256, artifactSha256, entrypointSha256, configurationSha256, installedAt,
						};
						const manifest: ProviderArtifactManifest = { ...unsignedManifest, evidenceRef: providerManifestEvidenceRef(unsignedManifest) };
						await writePrivateJson(join(stagingRoot, "beemax-provider.json"), manifest);
						if (await pathExists(currentRoot)) throw new Error("Provider current installation appeared during atomic publication");
						await rename(stagingRoot, currentRoot);
						await rm(journal, { force: true });
						return receiptFromManifest(manifest);
					} catch (error) {
						if (signal.aborted) {
							await writePrivateJson(quarantine, { schemaVersion: "beemax.provider-install-quarantine.v1", provider: provider.id, pid: process.pid, startedAt, observedAt: now(), stagingRoot, reason: "installation outcome interrupted" });
						} else {
							await rm(stagingRoot, { recursive: true, force: true });
							await rm(journal, { force: true });
						}
						throw error;
					}
				});
			},
		},
	});
	return { runtime, environment };
}

function assertExaMcporterProvider(provider: CapabilityProviderDescriptor): void {
	if (provider.id !== "exa-mcporter" || provider.install?.source !== EXA_MCPORTER_SOURCE || provider.install.package !== "mcporter" || provider.install.version !== EXA_MCPORTER_PROVIDER_VERSION) {
		throw new Error(`No trusted production Installer is registered for Provider ${provider.id}`);
	}
}

function providerLockRoot(): string {
	return fileURLToPath(new URL("../provider-locks/agent-reach-exa/", import.meta.url));
}

async function secureProviderRoot(agentDir: string, providerRoot: string): Promise<void> {
	await requireDirectoryNotSymlink(agentDir);
	const providersRoot = join(agentDir, "providers");
	await createOrSecureDirectory(providersRoot);
	await createOrSecureDirectory(providerRoot);
	const realAgent = await realpath(agentDir);
	const realProvider = await realpath(providerRoot);
	if (!isInside(realAgent, realProvider)) throw new Error("Provider installation root escapes the Profile Agent directory");
}

async function createOrSecureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
	await requireDirectoryNotSymlink(path);
	await chmod(path, 0o700);
}

async function requireDirectoryNotSymlink(path: string): Promise<void> {
	const stat = await lstat(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Provider path must be a real directory: ${path}`);
}

async function requireRegularFileInside(root: string, path: string): Promise<void> {
	const stat = await lstat(path);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Provider artifact must be a regular file: ${path}`);
	const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
	if (!isInside(realRoot, realFile)) throw new Error(`Provider artifact escapes its isolated installation root: ${path}`);
}

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function withProviderInstallLock<T>(providerRoot: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
	const lockPath = join(providerRoot, ".install.lock.json");
	const deadline = Date.now() + LOCK_WAIT_MS;
	const ownerToken = randomUUID();
	while (true) {
		if (signal.aborted) throw signal.reason ?? new Error("Provider installation aborted");
		const candidate = join(providerRoot, `.install-lock-${randomUUID()}.json`);
		try {
			await writePrivateJson(candidate, { pid: process.pid, token: ownerToken, startedAt: Date.now() });
			await link(candidate, lockPath);
			await unlink(candidate).catch(() => undefined);
			break;
		} catch (error) {
			await unlink(candidate).catch(() => undefined);
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const lockStat = await lstat(lockPath);
			if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error("Provider installation lock must be a regular file");
			const owner = await readJson(lockPath) as { pid?: unknown; token?: unknown } | undefined;
			const staleOwner = typeof owner?.pid === "number" && !processAlive(owner.pid);
			const staleInvalidOwner = typeof owner?.pid !== "number" && Date.now() - lockStat.mtimeMs > 1_000;
			if (staleOwner || staleInvalidOwner) {
				if (!await claimStaleInstallLock(lockPath, providerRoot, lockStat.dev, lockStat.ino, typeof owner?.token === "string" ? owner.token : undefined)) continue;
				if (await readValidInstallation(join(providerRoot, "current"))) {
					await rm(join(providerRoot, "installation-in-progress.json"), { force: true });
					continue;
				}
				await writePrivateJson(join(providerRoot, "installation-unknown.json"), { schemaVersion: "beemax.provider-install-quarantine.v1", provider: "exa-mcporter", observedAt: Date.now(), reason: "previous installer process ended without a settled installation" });
				continue;
			}
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the Profile-scoped Provider installation lock");
			await abortableDelay(LOCK_POLL_MS, signal);
		}
	}
	try {
		await pruneStaleClaimTombstones(providerRoot);
		return await operation();
	}
	finally { await releaseOwnedInstallLock(lockPath, ownerToken); }
}

async function pruneStaleClaimTombstones(providerRoot: string): Promise<void> {
	for (const name of await readdir(providerRoot)) {
		if (/^\.stale-lock-claim-[a-f0-9]{64}\.json$/.test(name)) await unlink(join(providerRoot, name));
	}
}

async function claimStaleInstallLock(lockPath: string, providerRoot: string, expectedDevice: number, expectedInode: number, expectedToken?: string): Promise<boolean> {
	// The claim name is immutable for this exact stale-lock generation and is
	// intentionally retained as a tombstone. Exactly one process can create its
	// hard link; losers can only wait for that winner and can never unlink a
	// replacement lock published at the same path.
	const generation = createHash("sha256").update(`${expectedDevice}:${expectedInode}:${expectedToken ?? "legacy"}`).digest("hex");
	const claimPath = join(providerRoot, `.stale-lock-claim-${generation}.json`);
	try {
		await link(lockPath, claimPath);
		const [claimStat, currentStat, claimOwner] = await Promise.all([
			lstat(claimPath),
			lstat(lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }),
			readJson(claimPath) as Promise<{ token?: unknown } | undefined>,
		]);
		if (!currentStat || claimStat.dev !== expectedDevice || claimStat.ino !== expectedInode || currentStat.dev !== claimStat.dev || currentStat.ino !== claimStat.ino) return false;
		if (expectedToken !== undefined && claimOwner?.token !== expectedToken) return false;
		await unlink(lockPath);
		return true;
	} catch (error) {
		if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

async function releaseOwnedInstallLock(lockPath: string, ownerToken: string): Promise<void> {
	const owner = await readJson(lockPath) as { token?: unknown } | undefined;
	if (owner?.token === ownerToken) await unlink(lockPath).catch(() => undefined);
}

async function reconcileQuarantine(providerRoot: string, quarantinePath: string): Promise<void> {
	if (!await pathExists(quarantinePath)) return;
	const journal = await readJson(join(providerRoot, "installation-in-progress.json")) as { stagingRoot?: unknown } | undefined;
	if (typeof journal?.stagingRoot === "string") {
		const stagingRoot = resolve(journal.stagingRoot);
		const realProvider = await realpath(providerRoot);
		const stat = await lstat(stagingRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
		if (stat?.isSymbolicLink()) throw new Error("Provider quarantine staging path is a symbolic link");
		if (stat) {
			const realStaging = await realpath(stagingRoot);
			if (!isInside(realProvider, realStaging) || !basename(realStaging).startsWith(".staging-")) throw new Error("Provider quarantine references an invalid staging path");
			await rm(realStaging, { recursive: true, force: true });
		}
	}
	await rm(join(providerRoot, "installation-in-progress.json"), { force: true });
	await rm(quarantinePath, { force: true });
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		if (signal.aborted) { rejectPromise(signal.reason ?? new Error("Provider installation aborted")); return; }
		const timer = setTimeout(done, ms);
		function done() { signal.removeEventListener("abort", aborted); resolvePromise(); }
		function aborted() { clearTimeout(timer); signal.removeEventListener("abort", aborted); rejectPromise(signal.reason ?? new Error("Provider installation aborted")); }
		signal.addEventListener("abort", aborted, { once: true });
	});
}

async function readValidInstallation(currentRoot: string): Promise<ProviderArtifactManifest | undefined> {
	try {
		await requireDirectoryNotSymlink(currentRoot);
		const manifestPath = join(currentRoot, "beemax-provider.json");
		const entrypointPath = join(currentRoot, "node_modules", "mcporter", "dist", "cli.js");
		const configurationPath = join(currentRoot, "home", ".agent-reach", "mcporter.json");
		await requireRegularFileInside(currentRoot, manifestPath);
		await requireRegularFileInside(currentRoot, entrypointPath);
		await requireRegularFileInside(currentRoot, configurationPath);
		return await verifyProviderArtifact({ root: currentRoot, manifestPath, entrypointPath, configurationPath, expected: { providerId: "exa-mcporter", version: EXA_MCPORTER_PROVIDER_VERSION, lockSha256: EXA_MCPORTER_LOCK_SHA256 } });
	} catch { return undefined; }
}

function receiptFromManifest(manifest: ProviderArtifactManifest): CapabilityProviderInstallReceipt {
	return { receiptId: `provider-install:exa-mcporter:${manifest.installedAt}`, installedAt: manifest.installedAt, evidenceRef: manifest.evidenceRef };
}

function installationEnvironment(source: NodeJS.ProcessEnv, home: string, executableRoot: string): NodeJS.ProcessEnv {
	return {
		HOME: home,
		PATH: [executableRoot, source.PATH ?? ""].filter(Boolean).join(delimiter),
		...(source.LANG ? { LANG: source.LANG } : {}),
		...(source.LC_ALL ? { LC_ALL: source.LC_ALL } : {}),
		...(source.TMPDIR ? { TMPDIR: source.TMPDIR } : {}),
		npm_config_ignore_scripts: "true",
	};
}

function executeCommand(command: string, args: readonly string[], options: CapabilityProviderCommandOptions): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = execFile(command, [...args], { cwd: options.cwd, env: options.env, signal: options.signal, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error) => error ? rejectPromise(error) : resolvePromise());
		child.stdin?.end();
	});
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readJson(path: string): Promise<unknown | undefined> {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch { return undefined; }
}

async function pathExists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

function identifier(value: string, label: string): string {
	const result = value.trim();
	if (!result || result.length > 128 || !/^[a-z0-9][a-z0-9._:@-]*$/i.test(result)) throw new Error(`${label} is invalid`);
	return result;
}

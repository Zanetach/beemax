import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverChromeExecutable } from "./artifact-composition.ts";

const ENDPOINT_SCHEMA = "beemax.profile-browser-endpoint.v1";
const PROCESS_SCHEMA = "beemax.profile-browser.v1";
const RUNNER_SCHEMA = "beemax.profile-browser-runner.v1";
const RUNNER_HEARTBEAT_MAX_AGE_MS = 5_000;

export interface ProfileBrowserStatus {
	state: "running" | "stopped" | "chrome_missing" | "port_conflict";
	cdpUrl?: string;
	dataDir: string;
	chromeExecutable?: string;
}

export interface StartProfileBrowserOptions {
	/** Host-owned executable/display environment; never pass the Profile .env snapshot. */
	trustedHostEnvironment?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	spawnImpl?: typeof spawn;
	processAliveImpl?: (pid: number) => boolean;
	timeoutMs?: number;
}

export interface StopProfileBrowserOptions {
	fetchImpl?: typeof fetch;
	processAliveImpl?: (pid: number) => boolean;
	killImpl?: (pid: number, signal: NodeJS.Signals) => void;
	timeoutMs?: number;
}

interface BrowserEndpointRecord {
	schemaVersion: typeof ENDPOINT_SCHEMA;
	cdpUrl: string;
}

interface BrowserProcessRecord {
	schemaVersion: typeof PROCESS_SCHEMA;
	pid: number;
	runnerToken: string;
	browserPid: number;
	cdpUrl: string;
	dataDir: string;
	startedAt: number;
}

interface BrowserRunnerRecord {
	schemaVersion: typeof RUNNER_SCHEMA;
	token: string;
	runnerPid: number;
	browserPid: number;
	updatedAt: number;
}

interface BrowserProbe { webSocketDebuggerUrl: string; }
interface DevToolsActivePort { port: number; browserPath: string; }

/** Resolve the OS-assigned endpoint persisted for this Profile's current browser process. */
export async function resolveProfileBrowserCdpUrl(agentDir: string): Promise<string> {
	const root = resolve(agentDir);
	await requireRealDirectory(root, "Profile Agent directory");
	await requireExistingBrowserDirectoriesInside(root);
	const record = await readEndpointRecord(root);
	if (!record) throw new Error("This Profile browser has not been started. Run 'thruvera capabilities start pi-web-access' first.");
	return record.cdpUrl;
}

export function profileBrowserDataDir(agentDir: string): string {
	return join(resolve(agentDir), "state", "pi-web-access", "browser-data");
}

/** Refuse CDP access unless the live endpoint is proven to originate from this Profile's user-data directory. */
export async function assertProfileBrowserEndpoint(agentDir: string, cdpUrl: string, options: Pick<StartProfileBrowserOptions, "fetchImpl" | "processAliveImpl"> = {}): Promise<void> {
	const expected = await resolveProfileBrowserCdpUrl(agentDir);
	if (normalizeCdpUrl(cdpUrl) !== expected) throw new Error("Managed browser endpoint does not match this Profile's current endpoint");
	const probe = await probeBrowser(expected, options.fetchImpl ?? fetch);
	if (!probe || !await endpointBelongsToProfile(resolve(agentDir), expected, probe, options.processAliveImpl ?? processAlive)) {
		throw new Error("Managed browser endpoint is not owned by this Profile. Start it with 'thruvera capabilities start pi-web-access' for this Profile.");
	}
}

export async function inspectProfileBrowser(agentDir: string, options: Pick<StartProfileBrowserOptions, "trustedHostEnvironment" | "fetchImpl" | "processAliveImpl"> = {}): Promise<ProfileBrowserStatus> {
	const root = resolve(agentDir);
	await requireRealDirectory(root, "Profile Agent directory");
	await requireExistingBrowserDirectoriesInside(root);
	const trustedHostEnvironment = options.trustedHostEnvironment ?? process.env;
	const dataDir = profileBrowserDataDir(root);
	const cdpUrl = (await readEndpointRecord(root))?.cdpUrl;
	const chromeExecutable = discoverChromeExecutable(trustedHostEnvironment);
	if (cdpUrl) {
		const probe = await probeBrowser(cdpUrl, options.fetchImpl ?? fetch);
		if (probe) {
			const owned = await endpointBelongsToProfile(root, cdpUrl, probe, options.processAliveImpl ?? processAlive);
			return { state: owned ? "running" : "port_conflict", cdpUrl, dataDir, ...(chromeExecutable ? { chromeExecutable } : {}) };
		}
	}
	return chromeExecutable
		? { state: "stopped", ...(cdpUrl ? { cdpUrl } : {}), dataDir, chromeExecutable }
		: { state: "chrome_missing", ...(cdpUrl ? { cdpUrl } : {}), dataDir };
}

/** Start a fresh, Profile-owned Chrome state on an OS-assigned port without importing user browser data. */
export async function startProfileBrowser(agentDir: string, options: StartProfileBrowserOptions = {}): Promise<ProfileBrowserStatus> {
	const root = resolve(agentDir);
	await requireRealDirectory(root, "Profile Agent directory");
	const stateRoot = join(root, "state");
	await createSecureDirectory(stateRoot, root);
	const capabilityRoot = join(stateRoot, "pi-web-access");
	await createSecureDirectory(capabilityRoot, root);
	const dataDir = profileBrowserDataDir(root);
	await createSecureDirectory(dataDir, root);
	const runtimeHome = join(capabilityRoot, "runtime-home");
	const temporaryRoot = join(capabilityRoot, "tmp");
	await createSecureDirectory(runtimeHome, root);
	await createSecureDirectory(temporaryRoot, root);
	return withStartLock(capabilityRoot, async () => {
		const isAlive = options.processAliveImpl ?? processAlive;
		await reconcileBrowserQuarantine(capabilityRoot, isAlive);
		const before = await inspectProfileBrowser(root, options);
		if (before.state === "running") return before;
		if (before.state === "port_conflict") throw new Error("The Profile browser endpoint is live but its runner/egress heartbeat is invalid. Stop it with 'thruvera capabilities stop pi-web-access' before restarting.");
		if (!before.chromeExecutable) throw new Error("Chrome/Chromium is not installed or executable; configure THRUVERA_CHROME_EXECUTABLE in the trusted Gateway/service host environment");
		const endpointPath = join(capabilityRoot, "browser-endpoint.json");
		const processPath = join(capabilityRoot, "browser-process.json");
		const runnerPath = join(capabilityRoot, "browser-runner.json");
		const activePortPath = join(dataDir, "DevToolsActivePort");
		await Promise.all([removeRegularFile(endpointPath), removeRegularFile(processPath), removeRegularFile(runnerPath), removeRegularFile(activePortPath)]);
		const spawnImpl = options.spawnImpl ?? spawn;
		const runnerToken = randomUUID();
		let child: ChildProcess | undefined;
		let spawnError: Error | undefined;
		try {
			const directArguments = [
				"--remote-debugging-port=0",
				`--user-data-dir=${dataDir}`,
				"--no-first-run",
				"--no-default-browser-check",
			];
			const runner = fileURLToPath(new URL("./profile-browser-runner.js", import.meta.url));
			const chromeEnvironment = minimalChromeEnvironment(options.trustedHostEnvironment ?? process.env, runtimeHome, temporaryRoot);
			child = options.spawnImpl
				? spawnImpl(before.chromeExecutable, directArguments, { detached: true, stdio: "ignore", env: chromeEnvironment })
				: spawnImpl(process.execPath, [runner, before.chromeExecutable, dataDir, runnerToken, runnerPath], { detached: true, stdio: "ignore", env: chromeEnvironment });
			child.once?.("error", (error) => { spawnError = error; });
			child.unref();
			if (!child.pid) throw new Error("Chrome did not report a process id");
			const deadline = Date.now() + Math.max(1_000, options.timeoutMs ?? 15_000);
			while (Date.now() < deadline) {
				if (spawnError) throw spawnError;
				const active = await readDevToolsActivePort(dataDir);
				if (active) {
					const cdpUrl = normalizeCdpUrl(`http://127.0.0.1:${active.port}`);
					const probe = await probeBrowser(cdpUrl, options.fetchImpl ?? fetch);
					if (probe && new URL(probe.webSocketDebuggerUrl).pathname === active.browserPath) {
						const runnerRecord = options.spawnImpl
							? { schemaVersion: RUNNER_SCHEMA, token: runnerToken, runnerPid: child.pid, browserPid: child.pid, updatedAt: Date.now() } satisfies BrowserRunnerRecord
							: await readRunnerRecord(runnerPath, runnerToken);
						if (!runnerRecord) { await delay(50); continue; }
						if (options.spawnImpl) await writePrivateJsonAtomic(runnerPath, runnerRecord);
						await writePrivateJsonAtomic(processPath, { schemaVersion: PROCESS_SCHEMA, pid: child.pid, runnerToken, browserPid: runnerRecord.browserPid, cdpUrl, dataDir, startedAt: Date.now() } satisfies BrowserProcessRecord);
						await writePrivateJsonAtomic(endpointPath, { schemaVersion: ENDPOINT_SCHEMA, cdpUrl } satisfies BrowserEndpointRecord);
						if (await endpointBelongsToProfile(root, cdpUrl, probe, options.processAliveImpl ?? processAlive)) {
							return { state: "running", cdpUrl, dataDir, chromeExecutable: before.chromeExecutable };
						}
					}
				}
				await delay(250);
			}
			throw new Error("Chrome started but did not publish a verified Profile-isolated DevTools endpoint");
		} catch (error) {
			const stopped = child ? await terminateSpawnedBrowser(child, options.spawnImpl === undefined, isAlive).catch(() => false) : true;
			if (stopped) await Promise.all([rm(endpointPath, { force: true }), rm(processPath, { force: true }), rm(runnerPath, { force: true })]);
			else await writePrivateJsonAtomic(join(capabilityRoot, "browser-quarantine.json"), {
				schemaVersion: "beemax.profile-browser-quarantine.v1",
				pid: child?.pid,
				dataDir,
				observedAt: Date.now(),
				reason: "browser process did not terminate after failed startup",
			});
			throw new Error(`Could not start the Profile-isolated browser: ${error instanceof Error ? error.message : String(error)}${stopped ? "" : "; the still-running process was quarantined"}`);
		}
	});
}

/** Stop the exact Profile-owned runner process group and remove its endpoint records only after shutdown is proven. */
export async function stopProfileBrowser(agentDir: string, options: StopProfileBrowserOptions = {}): Promise<ProfileBrowserStatus> {
	const root = resolve(agentDir);
	await requireRealDirectory(root, "Profile Agent directory");
	await requireExistingBrowserDirectoriesInside(root);
	const capabilityRoot = join(root, "state", "pi-web-access");
	const capabilityInfo = await lstat(capabilityRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	const dataDir = profileBrowserDataDir(root);
	if (!capabilityInfo) return { state: "stopped", dataDir };
	if (capabilityInfo.isSymbolicLink() || !capabilityInfo.isDirectory()) throw new Error(`Profile browser directory must be a real directory: ${capabilityRoot}`);
	const processPath = join(capabilityRoot, "browser-process.json");
	const endpointPath = join(capabilityRoot, "browser-endpoint.json");
	const runnerPath = join(capabilityRoot, "browser-runner.json");
	const activePortPath = join(dataDir, "DevToolsActivePort");
	const record = await readRegularJson(processPath) as Partial<BrowserProcessRecord> | undefined;
	const endpoint = await readEndpointRecord(root);
	if (record) {
		if (record.schemaVersion !== PROCESS_SCHEMA || typeof record.pid !== "number" || !validPid(record.pid)
			|| typeof record.browserPid !== "number" || !validPid(record.browserPid)
			|| typeof record.runnerToken !== "string" || !/^[a-f0-9-]{36}$/u.test(record.runnerToken)
			|| resolve(String(record.dataDir)) !== dataDir
			|| (endpoint && record.cdpUrl !== endpoint.cdpUrl)) {
			throw new Error("Profile browser process state is invalid; refusing to signal an unverified process");
		}
		const isAlive = options.processAliveImpl ?? processAlive;
		const kill = options.killImpl ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
		const send = (signal: NodeJS.Signals): void => {
			let groupSignalled = false;
			if (process.platform !== "win32") {
				try { kill(-record.pid!, signal); groupSignalled = true; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
			}
			if (!groupSignalled) {
				for (const pid of new Set([record.pid!, record.browserPid!])) {
					try { kill(pid, signal); }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
				}
			}
		};
		const stillRunning = async (): Promise<boolean> => {
			if (isAlive(record.pid!) || isAlive(record.browserPid!)) return true;
			return endpoint ? Boolean(await probeBrowser(endpoint.cdpUrl, options.fetchImpl ?? fetch)) : false;
		};
		if (await stillRunning()) {
			send("SIGTERM");
			const deadline = Date.now() + Math.max(500, options.timeoutMs ?? 3_000);
			while (Date.now() < deadline && await stillRunning()) await delay(100);
			if (await stillRunning()) {
				send("SIGKILL");
				for (let attempt = 0; attempt < 10 && await stillRunning(); attempt++) await delay(100);
			}
			if (await stillRunning()) throw new Error("Profile browser did not stop; its state was preserved for safe operator recovery");
		}
	}
	for (const path of [endpointPath, processPath, runnerPath, activePortPath]) await removeRegularFile(path);
	await removeRegularFile(join(capabilityRoot, "browser-quarantine.json"));
	return { state: "stopped", dataDir };
}

async function reconcileBrowserQuarantine(capabilityRoot: string, isAlive: (pid: number) => boolean): Promise<void> {
	const path = join(capabilityRoot, "browser-quarantine.json");
	const value = await readRegularJson(path) as { pid?: unknown } | undefined;
	if (!value) return;
	if (typeof value.pid === "number" && isAlive(value.pid)) throw new Error(`A quarantined Profile browser process is still running (pid=${value.pid}); stop it before retrying`);
	await unlink(path);
}

async function terminateSpawnedBrowser(child: ChildProcess, nativeDetachedProcess: boolean, isAlive: (pid: number) => boolean): Promise<boolean> {
	if (!child.pid) return true;
	const send = (signal: NodeJS.Signals): void => {
		try {
			if (nativeDetachedProcess && process.platform !== "win32") process.kill(-child.pid!, signal);
			else child.kill(signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	send("SIGTERM");
	for (let attempt = 0; attempt < 8 && isAlive(child.pid); attempt++) await delay(125);
	if (!isAlive(child.pid)) return true;
	send("SIGKILL");
	for (let attempt = 0; attempt < 8 && isAlive(child.pid); attempt++) await delay(125);
	return !isAlive(child.pid);
}

async function endpointBelongsToProfile(agentDir: string, cdpUrl: string, probe: BrowserProbe, isAlive: (pid: number) => boolean): Promise<boolean> {
	try {
		await requireExistingBrowserDirectoriesInside(agentDir);
		const record = await readRegularJson(join(agentDir, "state", "pi-web-access", "browser-process.json")) as Partial<BrowserProcessRecord> | undefined;
		const dataDir = profileBrowserDataDir(agentDir);
		if (record?.schemaVersion !== PROCESS_SCHEMA
			|| typeof record.pid !== "number" || !validPid(record.pid)
			|| typeof record.runnerToken !== "string" || !/^[a-f0-9-]{36}$/u.test(record.runnerToken)
			|| typeof record.browserPid !== "number" || !validPid(record.browserPid)) return false;
		if (record.cdpUrl !== cdpUrl || resolve(String(record.dataDir)) !== dataDir) return false;
		const runner = await readRunnerRecord(join(agentDir, "state", "pi-web-access", "browser-runner.json"), record.runnerToken);
		if (!runner
			|| runner.runnerPid !== record.pid
			|| runner.browserPid !== record.browserPid
			|| Date.now() - runner.updatedAt > RUNNER_HEARTBEAT_MAX_AGE_MS
			|| runner.updatedAt > Date.now() + RUNNER_HEARTBEAT_MAX_AGE_MS
			|| !isAlive(record.pid)
			|| !isAlive(record.browserPid)) return false;
		const active = await readDevToolsActivePort(dataDir);
		return Boolean(active) && active!.port === Number(new URL(cdpUrl).port) && new URL(probe.webSocketDebuggerUrl).pathname === active!.browserPath;
	} catch { return false; }
}

async function readRunnerRecord(path: string, expectedToken: string): Promise<BrowserRunnerRecord | undefined> {
	const value = await readRegularJson(path) as Partial<BrowserRunnerRecord> | undefined;
	if (!value) return undefined;
	if (value.schemaVersion !== RUNNER_SCHEMA
		|| value.token !== expectedToken
		|| typeof value.runnerPid !== "number" || !validPid(value.runnerPid)
		|| typeof value.browserPid !== "number" || !validPid(value.browserPid)
		|| typeof value.updatedAt !== "number" || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0) return undefined;
	return value as BrowserRunnerRecord;
}

async function readEndpointRecord(agentDir: string): Promise<BrowserEndpointRecord | undefined> {
	const value = await readRegularJson(join(agentDir, "state", "pi-web-access", "browser-endpoint.json")) as Partial<BrowserEndpointRecord> | undefined;
	if (!value) return undefined;
	if (value.schemaVersion !== ENDPOINT_SCHEMA || typeof value.cdpUrl !== "string") throw new Error("Profile browser endpoint state is invalid");
	return { schemaVersion: ENDPOINT_SCHEMA, cdpUrl: normalizeCdpUrl(value.cdpUrl) };
}

async function readDevToolsActivePort(dataDir: string): Promise<DevToolsActivePort | undefined> {
	const path = join(dataDir, "DevToolsActivePort");
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	if (!info) return undefined;
	await requireRegularFileInside(dataDir, path);
	const [portText, browserPath] = (await readFile(path, "utf8")).trim().split(/\r?\n/u);
	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65_535 || !browserPath?.startsWith("/devtools/browser/")) return undefined;
	return { port, browserPath };
}

async function probeBrowser(cdpUrl: string, fetchImpl: typeof fetch): Promise<BrowserProbe | undefined> {
	try {
		const response = await fetchImpl(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(750) });
		if (!response.ok) return undefined;
		const body = await response.json() as { webSocketDebuggerUrl?: unknown };
		if (typeof body.webSocketDebuggerUrl !== "string") return undefined;
		const endpoint = new URL(body.webSocketDebuggerUrl);
		const expected = new URL(cdpUrl);
		if (endpoint.protocol !== "ws:"
			|| endpoint.hostname !== expected.hostname
			|| effectivePort(endpoint) !== effectivePort(new URL(cdpUrl))) return undefined;
		return { webSocketDebuggerUrl: body.webSocketDebuggerUrl };
	} catch { return undefined; }
}

async function withStartLock<T>(capabilityRoot: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = join(capabilityRoot, "browser-start.lock");
	const token = randomUUID();
	let handle;
	for (let attempt = 0; attempt < 3; attempt++) {
		let created = false;
		try {
			handle = await open(lockPath, "wx", 0o600);
			created = true;
			await handle.writeFile(`${JSON.stringify({ schemaVersion: "beemax.profile-browser-start-lock.v1", pid: process.pid, token, startedAt: Date.now() })}\n`);
			await handle.sync();
			break;
		} catch (error) {
			await handle?.close().catch(() => undefined);
			handle = undefined;
			if (created) await unlink(lockPath).catch(() => undefined);
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const info = await lstat(lockPath);
			if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Profile browser start lock must be a regular file: ${lockPath}`);
			let owner: { pid?: unknown } | undefined;
			try { owner = await readRegularJson(lockPath) as { pid?: unknown } | undefined; }
			catch (readError) {
				if (Date.now() - info.mtimeMs <= 30_000) throw readError;
			}
			const stale = typeof owner?.pid === "number" ? !processAlive(owner.pid) : Date.now() - info.mtimeMs > 30_000;
			if (!stale) throw new Error("This Profile browser is already being started; retry after the current start finishes");
			if (!await claimStaleBrowserStartLock(lockPath, capabilityRoot, info.dev, info.ino)) continue;
		}
	}
	if (!handle) throw new Error("Could not acquire the Profile browser start lock");
	try { return await operation(); }
	finally {
		await handle.close();
		const owner = await readRegularJson(lockPath).catch(() => undefined) as { token?: unknown } | undefined;
		if (owner?.token === token) await unlink(lockPath).catch(() => undefined);
	}
}

async function claimStaleBrowserStartLock(lockPath: string, capabilityRoot: string, device: number, inode: number): Promise<boolean> {
	const claimPath = join(capabilityRoot, `.browser-start-stale-${device}-${inode}.lock`);
	try { await link(lockPath, claimPath); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	try {
		const current = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
		if (!current || current.dev !== device || current.ino !== inode) return false;
		await unlink(lockPath);
		return true;
	} finally { await unlink(claimPath).catch(() => undefined); }
}

async function writePrivateJsonAtomic(path: string, value: unknown): Promise<void> {
	const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`Profile browser state must be a regular file: ${path}`);
	const temp = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		const handle = await open(temp, "wx", 0o600);
		try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
		finally { await handle.close(); }
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

async function removeRegularFile(path: string): Promise<void> {
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	if (!info) return;
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Profile browser state must be a regular file: ${path}`);
	await unlink(path);
}

async function readRegularJson(path: string): Promise<unknown | undefined> {
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	if (!info) return undefined;
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Profile browser state must be a regular file: ${path}`);
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch { throw new Error(`Profile browser state is invalid JSON: ${path}`); }
}

async function createSecureDirectory(path: string, boundary: string): Promise<void> {
	await mkdir(path, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
	await requireRealDirectory(path, "Profile browser directory");
	const [realBoundary, realPath] = await Promise.all([realpath(boundary), realpath(path)]);
	if (!inside(realBoundary, realPath)) throw new Error(`Profile browser directory escapes its Profile: ${path}`);
	await chmod(path, 0o700);
}

async function requireExistingBrowserDirectoriesInside(agentDir: string): Promise<void> {
	const root = resolve(agentDir);
	for (const path of [join(root, "state"), join(root, "state", "pi-web-access"), profileBrowserDataDir(root)]) {
		const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
		if (!info) return;
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Profile browser directory must be a real directory: ${path}`);
		const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
		if (!inside(realRoot, realPath)) throw new Error(`Profile browser directory escapes its Profile: ${path}`);
	}
}

async function requireRealDirectory(path: string, label: string): Promise<void> {
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
}

async function requireRegularFileInside(root: string, path: string): Promise<void> {
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Profile browser artifact must be a regular file: ${path}`);
	const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
	if (!inside(realRoot, realFile)) throw new Error(`Profile browser artifact escapes its Profile data directory: ${path}`);
}

function minimalChromeEnvironment(source: NodeJS.ProcessEnv, runtimeHome: string, temporaryRoot: string): NodeJS.ProcessEnv {
	return {
		...(source.PATH ? { PATH: source.PATH } : {}),
		...(source.PATHEXT ? { PATHEXT: source.PATHEXT } : {}),
		...(source.SYSTEMROOT ? { SYSTEMROOT: source.SYSTEMROOT } : {}),
		...(source.WINDIR ? { WINDIR: source.WINDIR } : {}),
		...(source.COMSPEC ? { COMSPEC: source.COMSPEC } : {}),
		HOME: runtimeHome,
		USERPROFILE: runtimeHome,
		APPDATA: join(runtimeHome, "AppData", "Roaming"),
		LOCALAPPDATA: join(runtimeHome, "AppData", "Local"),
		XDG_CONFIG_HOME: join(runtimeHome, ".config"),
		XDG_CACHE_HOME: join(runtimeHome, ".cache"),
		XDG_DATA_HOME: join(runtimeHome, ".local", "share"),
		...(source.LANG ? { LANG: source.LANG } : {}),
		...(source.LC_ALL ? { LC_ALL: source.LC_ALL } : {}),
		TMPDIR: temporaryRoot,
		TMP: temporaryRoot,
		TEMP: temporaryRoot,
		...(source.DISPLAY ? { DISPLAY: source.DISPLAY } : {}),
		...(source.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: source.WAYLAND_DISPLAY } : {}),
	};
}

function normalizeCdpUrl(input: string): string {
	const url = new URL(input);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port) throw new Error("Profile browser endpoint must be an OS-assigned loopback HTTP port");
	const port = Number(url.port);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Profile browser endpoint port is invalid");
	return `http://127.0.0.1:${port}`;
}
function effectivePort(url: URL): string { return url.port || (url.protocol === "wss:" || url.protocol === "https:" ? "443" : "80"); }
function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function validPid(pid: number): boolean { return Number.isSafeInteger(pid) && pid > 0; }
function inside(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`); }
function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

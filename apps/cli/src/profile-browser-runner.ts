import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { profileBrowserProxyArguments, startProfileBrowserEgressProxy } from "./profile-browser-egress.ts";

const RUNNER_SCHEMA = "beemax.profile-browser-runner.v1";

async function main(): Promise<void> {
	const [chromeInput, dataDirInput, token, heartbeatInput] = process.argv.slice(2);
	if (!chromeInput || !dataDirInput || !token || !heartbeatInput || !isAbsolute(chromeInput) || !isAbsolute(dataDirInput) || !isAbsolute(heartbeatInput)) {
		throw new Error("Profile browser runner requires absolute Chrome, data-directory, and heartbeat paths");
	}
	if (!/^[a-f0-9-]{36}$/u.test(token)) throw new Error("Profile browser runner token is invalid");
	const chrome = await realpath(resolve(chromeInput));
	const dataDir = resolve(dataDirInput);
	const heartbeatPath = resolve(heartbeatInput);
	if (dirname(heartbeatPath) !== dirname(dataDir) || basename(heartbeatPath) !== "browser-runner.json") throw new Error("Profile browser runner heartbeat must stay in the capability state directory");
	const [chromeInfo, dataInfo] = await Promise.all([lstat(chrome), lstat(dataDir)]);
	if (chromeInfo.isSymbolicLink() || !chromeInfo.isFile()) throw new Error("Profile browser Chrome executable must be a regular file");
	if (dataInfo.isSymbolicLink() || !dataInfo.isDirectory()) throw new Error("Profile browser data directory must be a real directory");
	const proxy = await startProfileBrowserEgressProxy();
	const browser = spawn(chrome, profileBrowserProxyArguments(proxy.url, dataDir), { stdio: "ignore", env: process.env });
	if (!browser.pid) throw new Error("Profile browser child did not report a process id");
	let heartbeatWrite = Promise.resolve();
	const publishHeartbeat = (): Promise<void> => {
		heartbeatWrite = heartbeatWrite.then(() => writeHeartbeat(heartbeatPath, {
			schemaVersion: RUNNER_SCHEMA,
			token,
			runnerPid: process.pid,
			browserPid: browser.pid!,
			updatedAt: Date.now(),
		}));
		return heartbeatWrite;
	};
	await publishHeartbeat();
	const heartbeatTimer = setInterval(() => {
		void publishHeartbeat().catch(() => {
			try { browser.kill("SIGTERM"); } catch { /* already stopped */ }
			process.exitCode = 1;
		});
	}, 500);
	heartbeatTimer.unref();
	let stopping = false;
	const stop = (signal: NodeJS.Signals): void => {
		if (stopping) return;
		stopping = true;
		try { browser.kill(signal); } catch { /* already stopped */ }
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
	browser.once("error", async () => {
		clearInterval(heartbeatTimer);
		await heartbeatWrite.catch(() => undefined);
		await rm(heartbeatPath, { force: true }).catch(() => undefined);
		await proxy.close().catch(() => undefined);
		process.exitCode = 1;
	});
	browser.once("exit", async (code) => {
		clearInterval(heartbeatTimer);
		await heartbeatWrite.catch(() => undefined);
		await rm(heartbeatPath, { force: true }).catch(() => undefined);
		await proxy.close().catch(() => undefined);
		process.exit(code ?? 1);
	});
}

async function writeHeartbeat(path: string, value: unknown): Promise<void> {
	const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error("Profile browser runner heartbeat must be a regular file");
	const temporary = join(dirname(path), `.browser-runner-${process.pid}-${Date.now()}.tmp`);
	try {
		const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
		finally { await handle.close(); }
		await rename(temporary, path);
	} finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

void main().catch((error) => {
	process.stderr.write(`BeeMax Profile browser runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

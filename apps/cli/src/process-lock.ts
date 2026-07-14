import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Process-owned filesystem lock with fenced release and crash recovery. */
export async function acquireProcessLock(root: string, key: string, label: string, fileName?: string): Promise<() => Promise<void>> {
	const runDir = join(root, "run");
	await mkdir(runDir, { recursive: true, mode: 0o700 });
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 24);
	const path = join(runDir, fileName ?? `lock-${digest}`);
	const token = `${process.pid}:${crypto.randomUUID()}`;
	for (;;) {
		try {
			const handle = await open(path, "wx", 0o600);
			try {
				await handle.writeFile(`${token}\n`);
				await handle.sync();
			} catch (error) {
				await rm(path, { force: true }).catch(() => undefined);
				throw error;
			} finally {
				await handle.close().catch(() => undefined);
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = await readFile(path, "utf8").catch(() => "");
			const ownerPid = Number.parseInt(owner.split(":", 1)[0] ?? "", 10);
			const stale = Number.isInteger(ownerPid) ? !processAlive(ownerPid) : await oldEmptyLock(path);
			if (!stale) throw new Error(`${label} is already locked by process ${owner.split(":", 1)[0] || "unknown"}`);
			const reclaimMutex = `${path}.reclaiming`;
			try {
				await mkdir(reclaimMutex, { mode: 0o700 });
				await writeFile(join(reclaimMutex, "owner"), `${token}\n`, { encoding: "utf8", mode: 0o600 });
			} catch (mutexError) {
				if ((mutexError as NodeJS.ErrnoException).code === "EEXIST") {
					if (await staleReclaimMutex(reclaimMutex)) await rm(reclaimMutex, { recursive: true, force: true });
					else await wait(10);
					continue;
				}
				throw mutexError;
			}
			const claim = `${path}.reclaim-${token.replaceAll(":", "-")}`;
			try {
				const current = await readFile(path, "utf8").catch(() => "");
				if (current !== owner) continue;
				await rename(path, claim);
			} catch (claimError) {
				if ((claimError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw claimError;
			} finally {
				if ((await readFile(join(reclaimMutex, "owner"), "utf8").catch(() => "")) === `${token}\n`) {
					await rm(reclaimMutex, { recursive: true, force: true });
				}
			}
			await rm(claim, { force: true });
		}
	}
	return async () => {
		if ((await readFile(path, "utf8").catch(() => "")) === `${token}\n`) await rm(path, { force: true });
	};
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function oldEmptyLock(path: string): Promise<boolean> {
	try { return Date.now() - (await stat(path)).mtimeMs > 60_000; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

async function staleReclaimMutex(path: string): Promise<boolean> {
	const owner = await readFile(join(path, "owner"), "utf8").catch(() => "");
	const ownerPid = Number.parseInt(owner.split(":", 1)[0] ?? "", 10);
	if (Number.isInteger(ownerPid) && !processAlive(ownerPid)) return true;
	try { return Date.now() - (await stat(path)).mtimeMs > 60_000; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

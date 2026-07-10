import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export async function acquireChannelLock(home: string, channel: string): Promise<() => Promise<void>> {
	const runDir = join(home, "run");
	await mkdir(runDir, { recursive: true, mode: 0o700 });
	const key = createHash("sha256").update(channel).digest("hex").slice(0, 24);
	const path = join(runDir, `channel-${key}.lock`);
	const token = `${process.pid}:${crypto.randomUUID()}`;
	for (;;) {
		try {
			const handle = await open(path, "wx", 0o600);
			await handle.writeFile(`${token}\n`);
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = await readFile(path, "utf8").catch(() => "");
			const ownerPid = Number.parseInt(owner.split(":", 1)[0] ?? "", 10);
			const stale = Number.isInteger(ownerPid) ? !processAlive(ownerPid) : await oldEmptyLock(path);
			if (!stale) throw new Error(`Feishu channel '${channel}' is already locked by process ${owner.split(":", 1)[0] || "unknown"}`);
			const claim = `${path}.reclaim-${token.replaceAll(":", "-")}`;
			try {
				await rename(path, claim);
			} catch (claimError) {
				if ((claimError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw claimError;
			}
			await rm(claim, { force: true });
		}
	}
	return async () => {
		if ((await readFile(path, "utf8").catch(() => "")) === `${token}\n`) await rm(path, { force: true });
	};
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function oldEmptyLock(path: string): Promise<boolean> {
	try {
		return Date.now() - (await stat(path)).mtimeMs > 60_000;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

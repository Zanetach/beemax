import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireChannelLock } from "../dist/channel-lock.js";

test("Feishu channel lock prevents duplicate Profile gateways and releases cleanly", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-lock-"));
	const release = await acquireChannelLock(home, "cli_app");
	await assert.rejects(() => acquireChannelLock(home, "cli_app"), /already locked/);
	await release();
	const releaseAgain = await acquireChannelLock(home, "cli_app");
	await releaseAgain();
});

test("Feishu channel lock recovers a stale owner PID", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-lock-"));
	await mkdir(join(home, "run"));
	const key = createHash("sha256").update("a").digest("hex").slice(0, 24);
	await writeFile(join(home, "run", `channel-${key}.lock`), "999999:crashed-owner\n");
	const release = await acquireChannelLock(home, "a");
	await release();
});

test("Feishu channel lock recovers a reclaim mutex abandoned by a crashed process", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-lock-"));
	const run = join(home, "run");
	await mkdir(run);
	const key = createHash("sha256").update("a").digest("hex").slice(0, 24);
	const lock = join(run, `channel-${key}.lock`);
	await writeFile(lock, "999999:crashed-owner\n");
	await mkdir(`${lock}.reclaiming`);
	await writeFile(join(`${lock}.reclaiming`, "owner"), "999998:crashed-reclaimer\n");
	const release = await acquireChannelLock(home, "a");
	await release();
});

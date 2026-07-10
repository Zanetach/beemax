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
	await writeFile(join(home, "run", `channel-${key}.lock`), "999999\n");
	const release = await acquireChannelLock(home, "a");
	await release();
});

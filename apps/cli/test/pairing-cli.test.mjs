import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PairingStore } from "@thruvera/gateway";
import { createProfile } from "../dist/profile-config.js";

const cli = resolve("apps/cli/dist/cli.js");

test("pairing CLI lists, approves, and revokes a Profile-scoped Feishu user", async () => {
	const home = mkdtempSync(join(tmpdir(), "beemax-pairing-cli-"));
	try {
		const paths = await createProfile("paired", { home });
		const request = new PairingStore(paths.dataPath).request("feishu", "ou_user");
		const run = (...args) => execFileSync(process.execPath, [cli, ...args, "--profile", "paired"], { encoding: "utf8", env: { ...process.env, THRUVERA_HOME: home } });
		assert.match(run("pairing", "list"), new RegExp(request.code));
		assert.match(run("pairing", "approve", "feishu", request.code), /Approved ou_user/);
		assert.match(run("pairing", "list"), /Approved feishu users/);
		assert.match(run("pairing", "revoke", "feishu", "ou_user"), /Revoked ou_user/);
		assert.match(run("pairing", "list"), /No feishu pairing requests or approvals/);
		new PairingStore(paths.dataPath).request("feishu", "ou_clear");
		assert.match(run("pairing", "clear", "feishu"), /Cleared 1 pending/);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

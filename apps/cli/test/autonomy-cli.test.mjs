import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve("apps/cli/dist/cli.js");
test("CLI promotes and stops Profile autonomy levels with auditable evidence", () => {
	const home = mkdtempSync(join(tmpdir(), "beemax-autonomy-cli-"));
	const root = mkdtempSync(join(tmpdir(), "beemax-autonomy-forged-root-"));
	const run = (args) => execFileSync(process.execPath, [cli, ...args], {
		encoding: "utf8", env: { ...process.env, THRUVERA_HOME: home, THRUVERA_ROOT: root },
	});
	try {
		run(["init", "--profile", "organization"]);
		assert.match(run(["autonomy", "status", "--profile", "organization"]), /situation_context  \[disabled\]/);
		assert.throws(() => run(["autonomy", "promote", "episode_publication", "--yes", "--profile", "organization"]), /dependency situation_context/i);
		for (const level of ["situation_context", "episode_publication", "initiative_observation", "read_only_investigation", "reversible_action"]) {
			assert.match(run(["autonomy", "promote", level, "--yes", "--profile", "organization"]), new RegExp(`Promoted ${level}`));
		}
		assert.match(run(["autonomy", "stop", "read_only_investigation", "--evidence-ref", "incident:pause", "--yes", "--profile", "organization"]), /Stopped read_only_investigation/);
		assert.match(run(["autonomy", "status", "--profile", "organization"]), /read_only_investigation  \[stopped\].*revision=2/);
		assert.match(run(["autonomy", "status", "--profile", "organization"]), /runtime-evaluation:beemax-unknown-business-v1:sha256:[a-f0-9]{64}/);
		assert.throws(() => run(["autonomy", "promote", "high_risk_action", "--yes", "--profile", "organization"]), /Usage: thruvera autonomy/);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
	activeProfile,
	applyThruveraEnvironmentAliases,
	thruveraHome,
	thruveraRoot,
} from "../dist/profile-home.js";

test("Thruvera environment names are canonical while BeeMax names remain aliases", () => {
	const environment = {
		THRUVERA_HOME: "/srv/thruvera",
		BEEMAX_HOME: "/srv/beemax",
		THRUVERA_ROOT: "/opt/thruvera",
		BEEMAX_ROOT: "/opt/beemax",
		THRUVERA_PROFILE: "work",
	};
	applyThruveraEnvironmentAliases(environment);
	assert.equal(environment.BEEMAX_HOME, "/srv/thruvera");
	assert.equal(environment.BEEMAX_ROOT, "/opt/thruvera");
	assert.equal(environment.BEEMAX_PROFILE, "work");
	assert.equal(thruveraHome(environment), resolve("/srv/thruvera"));
	assert.equal(thruveraRoot(environment), resolve("/opt/thruvera"));
	assert.equal(activeProfile(environment), "work");
});

test("legacy BeeMax environment names still configure Thruvera", () => {
	const environment = { BEEMAX_HOME: "/srv/legacy", BEEMAX_ROOT: "/opt/legacy", BEEMAX_PROFILE: "legacy" };
	applyThruveraEnvironmentAliases(environment);
	assert.equal(environment.THRUVERA_HOME, "/srv/legacy");
	assert.equal(environment.THRUVERA_ROOT, "/opt/legacy");
	assert.equal(environment.THRUVERA_PROFILE, "legacy");
	assert.equal(thruveraHome(environment), resolve("/srv/legacy"));
	assert.equal(activeProfile(environment), "legacy");
});

test("package and CLI surfaces expose Thruvera with a BeeMax command alias", async () => {
	const rootManifest = JSON.parse(await readFile("package.json", "utf8"));
	const cliManifest = JSON.parse(await readFile("apps/cli/package.json", "utf8"));
	assert.equal(rootManifest.name, "thruvera-agent");
	assert.equal(cliManifest.name, "@thruvera/cli");
	assert.equal(cliManifest.bin.thruvera, "./dist/cli.js");
	assert.equal(cliManifest.bin.beemax, "./dist/cli.js");

	const output = execFileSync(process.execPath, ["apps/cli/dist/cli.js", "--help"], {
		encoding: "utf8",
		env: { ...process.env, THRUVERA_HOME: "/tmp/thruvera-brand-test" },
	});
	assert.match(output, /^thruvera - persistent personal agent/m);
	assert.match(output, /THRUVERA_HOME/);
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyBeeMaxReleaseVersion } from "../../../scripts/verify-release-version.mjs";

test("release version verification accepts one coherent BeeMax release", () => {
	const root = releaseFixture({ version: "2.3.0" });
	try {
		assert.deepEqual(verifyBeeMaxReleaseVersion(root, "v2.3.0"), {
			version: "2.3.0",
			manifests: ["apps/cli/package.json", "package.json", "packages/core/package.json"],
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("release version verification rejects a stale internal BeeMax dependency", () => {
	const root = releaseFixture({ version: "2.3.0", coreDependency: "2.2.0" });
	try {
		assert.throws(
			() => verifyBeeMaxReleaseVersion(root, "v2.3.0"),
			/@beemax\/cli dependency @beemax\/core must be exactly 2\.3\.0; found 2\.2\.0/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("release version verification requires release notes for the exact package version", () => {
	const root = releaseFixture({ version: "2.3.0", changelogVersion: "2.2.0" });
	try {
		assert.throws(
			() => verifyBeeMaxReleaseVersion(root, "v2.3.0"),
			/CHANGELOG\.md has no 2\.3\.0 release section/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function releaseFixture({ version, coreDependency = version, changelogVersion = version }) {
	const root = mkdtempSync(join(tmpdir(), "beemax-release-version-"));
	mkdirSync(join(root, "apps", "cli"), { recursive: true });
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	writeManifest(join(root, "package.json"), { name: "beemax-agent", version });
	writeManifest(join(root, "apps", "cli", "package.json"), { name: "@beemax/cli", version, dependencies: { "@beemax/core": coreDependency } });
	writeManifest(join(root, "packages", "core", "package.json"), { name: "@beemax/core", version });
	writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## ${changelogVersion}\n`);
	return root;
}

function writeManifest(path, value) {
	writeFileSync(path, JSON.stringify(value));
}

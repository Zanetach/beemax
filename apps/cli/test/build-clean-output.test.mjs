import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanWorkspaceBuildOutputs } from "../../../scripts/clean-build-output.mjs";

test("clean build removes stale workspace output without deleting release archives", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-clean-build-"));
	try {
		mkdirSync(join(root, "packages", "gateway", "dist", "removed-module"), { recursive: true });
		mkdirSync(join(root, "dist", "release"), { recursive: true });
		writeFileSync(join(root, "packages", "gateway", "package.json"), "{}");
		writeFileSync(join(root, "packages", "gateway", "dist", "removed-module", "index.js"), "stale");
		writeFileSync(join(root, "packages", "gateway", "tsconfig.build.tsbuildinfo"), "stale");
		writeFileSync(join(root, "dist", "release", "beemax.tar.gz"), "release");

		const result = cleanWorkspaceBuildOutputs(root, ["packages/*"]);

		assert.deepEqual(result.cleanedWorkspaces, ["packages/gateway"]);
		assert.throws(() => readFileSync(join(root, "packages", "gateway", "dist", "removed-module", "index.js")));
		assert.throws(() => readFileSync(join(root, "packages", "gateway", "tsconfig.build.tsbuildinfo")));
		assert.equal(readFileSync(join(root, "dist", "release", "beemax.tar.gz"), "utf8"), "release");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

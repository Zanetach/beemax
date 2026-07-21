import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("Gateway cold import does not load PDF-only native dependencies", () => {
	const loader = fileURLToPath(new URL("./fixtures/heavy-artifact-import-guard.mjs", import.meta.url));
	const gateway = pathToFileURL(fileURLToPath(new URL("../dist/gateway.js", import.meta.url))).href;
	const result = spawnSync(process.execPath, [
		"--no-warnings",
		"--experimental-loader", loader,
		"--input-type=module",
		"--eval", `await import(${JSON.stringify(gateway)}); process.exit(0);`,
	], { encoding: "utf8", timeout: 30_000 });

	assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

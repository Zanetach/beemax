import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

test("Work Contract proposal builders are excluded from the Agent Runtime port", () => {
	const fixture = join(import.meta.dirname, "fixtures", "work-contract-port-types.ts");
	const compiler = join(process.cwd(), "node_modules", ".bin", "tsgo");
	const output = execFileSync(compiler, [
		"--ignoreConfig",
		"--noEmit",
		"--strict",
		"--skipLibCheck",
		"--target", "ES2022",
		"--module", "NodeNext",
		"--moduleResolution", "NodeNext",
		fixture,
	], { encoding: "utf8" });
	assert.equal(output, "");
});

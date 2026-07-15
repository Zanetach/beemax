import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateBaseline } from "./server.mjs";

const harnessDir = fileURLToPath(new URL(".", import.meta.url));

function goodCase(overrides = {}) {
	return { id: "a-case", prompt: "问题", expect: { output: { example: "参考答案" } }, ...overrides };
}

test("validateBaseline accepts the shipped baseline file", () => {
	const baseline = JSON.parse(readFileSync(join(harnessDir, "baseline-cases.json"), "utf8"));
	assert.equal(validateBaseline(baseline), baseline);
});

test("validateBaseline rejects malformed baselines", () => {
	assert.throws(() => validateBaseline({ schemaVersion: 2, cases: [goodCase()] }), /schemaVersion/);
	assert.throws(() => validateBaseline({ schemaVersion: 1, cases: [] }), /non-empty/);
	assert.throws(() => validateBaseline({ schemaVersion: 1, cases: [goodCase({ id: "Bad Id" })] }), /invalid case id/);
	assert.throws(() => validateBaseline({ schemaVersion: 1, cases: [goodCase(), goodCase()] }), /duplicate case id/);
	assert.throws(() => validateBaseline({ schemaVersion: 1, cases: [goodCase({ prompt: " " })] }), /prompt is required/);
	assert.throws(() => validateBaseline({ schemaVersion: 1, cases: [goodCase({ expect: { output: {} } })] }), /example is required/);
	assert.throws(() => validateBaseline({ schemaVersion: 1, cases: [goodCase({ dependsOn: "missing" })] }), /unknown dependsOn/);
	assert.throws(() => validateBaseline({
		schemaVersion: 1,
		cases: [goodCase({ id: "x", dependsOn: "y" }), goodCase({ id: "y", dependsOn: "x" })],
	}), /cycle/);
});

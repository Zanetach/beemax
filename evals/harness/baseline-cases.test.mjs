import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const baselinePath = join(fileURLToPath(new URL(".", import.meta.url)), "baseline-cases.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

test("baseline file has schema version and at least one case", () => {
	assert.equal(baseline.schemaVersion, 1);
	assert.ok(Array.isArray(baseline.cases) && baseline.cases.length > 0);
});

test("every case is well-formed with unique ids and resolvable dependencies", () => {
	const ids = new Set();
	for (const testCase of baseline.cases) {
		assert.match(testCase.id, /^[a-z0-9-]+$/, `case id: ${testCase.id}`);
		assert.ok(!ids.has(testCase.id), `duplicate case id: ${testCase.id}`);
		ids.add(testCase.id);
		assert.ok(typeof testCase.prompt === "string" && testCase.prompt.trim(), `${testCase.id}: prompt`);
		assert.ok(testCase.expect && typeof testCase.expect === "object", `${testCase.id}: expect`);
	}
	for (const testCase of baseline.cases) {
		if (testCase.dependsOn) assert.ok(ids.has(testCase.dependsOn), `${testCase.id}: unknown dependsOn ${testCase.dependsOn}`);
	}
});

test("expectation shapes are valid", () => {
	for (const { id, expect } of baseline.cases) {
		const tools = expect.tools ?? {};
		for (const key of ["required", "forbidden"]) {
			if (tools[key] !== undefined) assert.ok(tools[key].every((name) => typeof name === "string"), `${id}: tools.${key}`);
		}
		if (tools.anyOf !== undefined) {
			assert.ok(Array.isArray(tools.anyOf) && tools.anyOf.length > 0, `${id}: tools.anyOf`);
			for (const group of tools.anyOf) assert.ok(Array.isArray(group) && group.every((name) => typeof name === "string"), `${id}: tools.anyOf group`);
		}
		for (const rule of expect.toolArguments ?? []) {
			assert.ok(typeof rule.tool === "string" && rule.tool, `${id}: toolArguments.tool`);
			assert.ok(Array.isArray(rule.mustContain) && rule.mustContain.length > 0, `${id}: toolArguments.mustContain`);
		}
		const output = expect.output ?? {};
		for (const key of ["mustContain", "anyContain", "mustNotContain"]) {
			if (output[key] !== undefined) assert.ok(Array.isArray(output[key]) && output[key].every((value) => typeof value === "string"), `${id}: output.${key}`);
		}
		assert.ok(typeof output.example === "string" && output.example.trim(), `${id}: output.example is required for the LLM judge`);
		if (expect.maxToolCalls !== undefined) assert.ok(Number.isInteger(expect.maxToolCalls) && expect.maxToolCalls >= 0, `${id}: maxToolCalls`);
		const forbidden = new Set(tools.forbidden ?? []);
		for (const name of tools.required ?? []) assert.ok(!forbidden.has(name), `${id}: ${name} both required and forbidden`);
	}
});

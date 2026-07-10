import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function sourceFiles(directory) {
	const result = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts")) result.push(path);
	}
	return result;
}

function sourceText(directory) {
	return sourceFiles(directory).map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

test("architecture boundary: Core never imports Gateway or a channel SDK", () => {
	for (const file of sourceText(join(root, "packages/core/src"))) {
		assert.doesNotMatch(file.text, /from ["']@beemax\/gateway["']/, file.path);
		assert.doesNotMatch(file.text, /from ["']@larksuiteoapi\//, file.path);
	}
});

test("architecture boundary: Gateway contains no Agent capability composition", () => {
	for (const file of sourceText(join(root, "packages/gateway/src"))) {
		assert.doesNotMatch(file.text, /from ["']@beemax\/(automation|memory|mcp-capability|feishu-capability)["']/, file.path);
		assert.doesNotMatch(file.text, /\b(buildAgentFactory|createMemoryTools|createAutomationTools|createSkillTools|createWebTools|McpManager)\b/, file.path);
	}
});

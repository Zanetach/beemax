import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { FORBIDDEN_EXTERNAL_AGENT_PATTERN, verifyReleaseAgentBoundary } from "../../../scripts/verify-release-agent-boundary.mjs";

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

test("architecture boundary: BeeMax capabilities and Gateway consume Pi primitives only through Core", () => {
	for (const directory of ["packages/gateway/src", "packages/memory/src", "packages/mcp-capability/src", "packages/feishu-capability/src"]) {
		for (const file of sourceText(join(root, directory))) {
			assert.doesNotMatch(file.text, /from ["']@earendil-works\/pi-(?:ai|agent-core|coding-agent)[^"']*["']/, file.path);
		}
	}
});

test("release boundary: production BeeMax contains no external agent runtime", () => {
	const productionDirectories = [
		"apps/cli/src",
		"packages/automation/src",
		"packages/channel-feishu/src",
		"packages/channel-runtime/src",
		"packages/channel-telegram/src",
		"packages/core/src",
		"packages/feishu-capability/src",
		"packages/gateway/src",
		"packages/knowledge/src",
		"packages/mcp-capability/src",
		"packages/memory/src",
	];
	for (const directory of productionDirectories) {
		for (const file of sourceText(join(root, directory))) assert.doesNotMatch(file.text, FORBIDDEN_EXTERNAL_AGENT_PATTERN, file.path);
	}
	for (const path of ["config/beemax.yaml.example", "config/profiles/personal.yaml.example", "apps/cli/package.json", "package.json"]) {
		assert.doesNotMatch(readFileSync(join(root, path), "utf8"), FORBIDDEN_EXTERNAL_AGENT_PATTERN, path);
	}
	assert.equal(existsSync(join(root, "packages", "codex-image-capability", "package.json")), false, "external-agent image package must not ship");
});

test("release boundary scanner fails closed on missing or prohibited artifacts", () => {
	const fixture = mkdtempSync(join(tmpdir(), "beemax-release-boundary-"));
	try {
		assert.deepEqual(verifyReleaseAgentBoundary(fixture, { releaseRoots: ["dist"], manifests: ["package.json"] }), ["dist (missing)", "package.json (missing)"]);
		mkdirSync(join(fixture, "dist"));
		writeFileSync(join(fixture, "package.json"), "{}\n");
		writeFileSync(join(fixture, "dist", "runtime.js"), "export const runtime = 'beemax';\n");
		assert.deepEqual(verifyReleaseAgentBoundary(fixture, { releaseRoots: ["dist"], manifests: ["package.json"] }), []);
		writeFileSync(join(fixture, "dist", "runtime.js"), "export const runtime = 'Codex';\n");
		assert.deepEqual(verifyReleaseAgentBoundary(fixture, { releaseRoots: ["dist"], manifests: ["package.json"] }), ["dist/runtime.js"]);
		writeFileSync(join(fixture, "dist", "runtime.js"), "export const runtime = 'beemax';\n");
		writeFileSync(join(fixture, "dist", "codex-adapter.js"), "export const runtime = 'beemax';\n");
		assert.deepEqual(verifyReleaseAgentBoundary(fixture, { releaseRoots: ["dist"], manifests: ["package.json"] }), ["dist/codex-adapter.js"]);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("architecture boundary: presentation may use Pi TUI but cannot own Agent execution", () => {
	for (const file of sourceText(join(root, "apps/cli/src"))) {
		assert.doesNotMatch(file.text, /from ["']@earendil-works\/pi-(?:ai|agent-core|coding-agent)[^"']*["']/, file.path);
		if (file.text.includes("@earendil-works/pi-tui")) assert.match(file.path, /full-workbench\.ts$/, file.path);
	}
});

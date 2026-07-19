import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FORBIDDEN_EXTERNAL_AGENT_PATTERN = /hermes(?:[ -]?agent)?|openclaw|codex/i;

export function verifyReleaseAgentBoundary(root, options = {}) {
	const releaseRoots = options.releaseRoots ?? defaultReleaseRoots(root);
	const manifests = options.manifests ?? ["package.json", "package-lock.json", "apps/cli/package.json"];
	const violations = [];
	for (const directory of releaseRoots) {
		const absolute = join(root, directory);
		if (!existsSync(absolute)) {
			violations.push(`${directory} (missing)`);
			continue;
		}
		visit(absolute);
	}
	for (const manifest of manifests) {
		const absolute = join(root, manifest);
		if (!existsSync(absolute)) violations.push(`${manifest} (missing)`);
		else if (FORBIDDEN_EXTERNAL_AGENT_PATTERN.test(readFileSync(absolute, "utf8"))) violations.push(manifest);
	}
	return violations;

	function visit(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else {
				const releasePath = relative(root, absolute);
				if (FORBIDDEN_EXTERNAL_AGENT_PATTERN.test(releasePath) || FORBIDDEN_EXTERNAL_AGENT_PATTERN.test(readFileSync(absolute, "utf8"))) violations.push(releasePath);
			}
		}
	}
}

function defaultReleaseRoots(root) {
	return [
		"apps/cli/dist",
		"config",
		"skills/builtin",
		...readdirSync(join(root, "packages"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
			.map((entry) => `packages/${entry.name}/dist`),
		"pi/packages/ai/dist",
		"pi/packages/agent/dist",
		"pi/packages/coding-agent/dist",
		"pi/packages/tui/dist",
	];
}

function run() {
	const requestedRoot = process.argv[2]?.trim();
	const root = resolve(requestedRoot || fileURLToPath(new URL("..", import.meta.url)));
	const wholeTree = process.argv.slice(3).includes("--whole-tree");
	const violations = wholeTree
		? verifyReleaseAgentBoundary(root, { releaseRoots: ["."], manifests: [] })
		: verifyReleaseAgentBoundary(root);
	if (violations.length) {
		process.stderr.write(`Release contains prohibited external Agent artifacts:\n${violations.map((path) => `- ${path}`).join("\n")}\n`);
		process.exitCode = 1;
	} else {
		process.stdout.write("Release external-Agent boundary verified.\n");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();

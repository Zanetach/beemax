import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const DEPENDENCY_GROUPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

export function verifyBeeMaxReleaseVersion(root, releaseTag) {
	const sourceRoot = resolve(root);
	const manifestPaths = discoverManifestPaths(sourceRoot);
	const manifests = manifestPaths.map((path) => ({ path, value: JSON.parse(readFileSync(path, "utf8")) }));
	const rootManifest = manifests.find(({ path }) => path === join(sourceRoot, "package.json"))?.value;
	const version = requiredVersion(rootManifest?.version, "package.json");
	if (releaseTag !== `v${version}`) throw new Error(`Release tag ${releaseTag} does not match package version v${version}`);
	for (const { path, value } of manifests) {
		const manifestName = portableRelative(sourceRoot, path);
		if (requiredVersion(value.version, manifestName) !== version) throw new Error(`BeeMax workspace version does not match ${version}: ${manifestName}`);
		for (const group of DEPENDENCY_GROUPS) {
			for (const [dependency, dependencyVersion] of Object.entries(value[group] ?? {})) {
				if (dependency.startsWith("@beemax/") && dependencyVersion !== version) {
					throw new Error(`${value.name ?? manifestName} dependency ${dependency} must be exactly ${version}; found ${dependencyVersion}`);
				}
			}
		}
	}
	const changelogPath = join(sourceRoot, "CHANGELOG.md");
	const releaseHeading = `## ${version}`;
	const changelog = readFileSync(changelogPath, "utf8");
	if (!changelog.split(/\r?\n/u).some((line) => line.trim() === releaseHeading)) {
		throw new Error(`CHANGELOG.md has no ${version} release section`);
	}
	return { version, manifests: manifests.map(({ path }) => portableRelative(sourceRoot, path)) };
}

function discoverManifestPaths(root) {
	const paths = [join(root, "package.json"), join(root, "apps", "cli", "package.json")];
	const packagesRoot = join(root, "packages");
	if (existsSync(packagesRoot)) {
		for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json"))) paths.push(join(packagesRoot, entry.name, "package.json"));
		}
	}
	return [...new Set(paths)].sort();
}

function requiredVersion(value, manifest) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`BeeMax manifest has no version: ${manifest}`);
	return value;
}

function portableRelative(root, path) {
	return relative(root, path).split(sep).join("/") || "package.json";
}

function run() {
	const root = process.argv[2];
	const tag = process.argv[3];
	if (!root || !tag) throw new Error("Usage: node scripts/verify-release-version.mjs <source-root> <release-tag>");
	const result = verifyBeeMaxReleaseVersion(root, tag);
	process.stdout.write(`Verified BeeMax ${result.version} across ${result.manifests.length} manifests.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();

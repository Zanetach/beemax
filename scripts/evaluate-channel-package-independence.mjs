#!/usr/bin/env node
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const scenarios = [
	{ id: "without-feishu", packages: ["channel-runtime", "gateway", "channel-telegram"], absent: "channel-feishu" },
	{ id: "without-telegram", packages: ["channel-runtime", "gateway", "channel-feishu"], absent: "channel-telegram" },
];
const evidence = [];

for (const scenario of scenarios) {
	const sandbox = await mkdtemp(join(tmpdir(), `beemax-${scenario.id}-`));
	try {
		await mkdir(join(sandbox, "pi"), { recursive: true });
		await cp(join(root, "pi", "tsconfig.base.json"), join(sandbox, "pi", "tsconfig.base.json"));
		await mkdir(join(sandbox, "packages"), { recursive: true });
		for (const name of scenario.packages) await copyPackage(name, sandbox);
		await installIsolatedNodeModules(sandbox, scenario.packages, scenario.absent);
		for (const name of scenario.packages) {
			await execFileAsync(join(root, "node_modules", ".bin", "tsgo"), ["-p", join(sandbox, "packages", name, "tsconfig.build.json")], { cwd: sandbox, maxBuffer: 8 * 1024 * 1024 });
		}
		evidence.push({ id: scenario.id, absent: `@beemax/${scenario.absent}`, built: scenario.packages.map((name) => `@beemax/${name}`), passed: true });
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
}

console.log(JSON.stringify({ schemaVersion: 1, scenarios: evidence, gate: { passed: true, failures: [] } }, null, 2));

async function copyPackage(name, sandbox) {
	const source = join(root, "packages", name);
	const target = join(sandbox, "packages", name);
	await mkdir(target, { recursive: true });
	for (const file of ["package.json", "tsconfig.build.json"]) await cp(join(source, file), join(target, file));
	await cp(join(source, "src"), join(target, "src"), { recursive: true });
}

async function installIsolatedNodeModules(sandbox, selected, absent) {
	const modules = join(sandbox, "node_modules");
	await mkdir(modules, { recursive: true });
	for (const entry of await readdir(join(root, "node_modules"), { withFileTypes: true })) {
		if (entry.name === "@beemax") continue;
		await symlink(join(root, "node_modules", entry.name), join(modules, entry.name), entry.isDirectory() ? "dir" : "file");
	}
	const scope = join(modules, "@beemax");
	await mkdir(scope, { recursive: true });
	await symlink(join(root, "packages", "core"), join(scope, "core"), "dir");
	for (const name of selected) await symlink(join(sandbox, "packages", name), join(scope, name), "dir");
	if ((await readdir(scope)).includes(absent)) throw new Error(`Isolation sandbox unexpectedly contains ${basename(absent)}`);
}

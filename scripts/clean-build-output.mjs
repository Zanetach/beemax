import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function workspaceDirectories(root, patterns) {
	const directories = [];
	for (const pattern of patterns) {
		if (pattern.endsWith("/*")) {
			const parent = resolve(root, pattern.slice(0, -2));
			if (!existsSync(parent)) continue;
			for (const entry of readdirSync(parent, { withFileTypes: true })) {
				if (entry.isDirectory()) directories.push(join(parent, entry.name));
			}
			continue;
		}
		directories.push(resolve(root, pattern));
	}
	return [...new Set(directories)].sort();
}

export function cleanWorkspaceBuildOutputs(root, workspacePatterns) {
	const repositoryRoot = resolve(root);
	const cleanedWorkspaces = [];
	for (const workspace of workspaceDirectories(repositoryRoot, workspacePatterns)) {
		const workspaceRelative = relative(repositoryRoot, workspace);
		if (!workspaceRelative || workspaceRelative === ".." || workspaceRelative.startsWith(`..${sep}`)) {
			throw new Error(`Workspace resolves outside repository: ${workspace}`);
		}
		if (!existsSync(join(workspace, "package.json"))) continue;
		rmSync(join(workspace, "dist"), { recursive: true, force: true });
		for (const entry of readdirSync(workspace, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) rmSync(join(workspace, entry.name), { force: true });
		}
		cleanedWorkspaces.push(workspaceRelative.split(sep).join("/"));
	}
	return { cleanedWorkspaces };
}

function run() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (!Array.isArray(manifest.workspaces)) throw new Error("package.json workspaces must be an array");
	const result = cleanWorkspaceBuildOutputs(root, manifest.workspaces);
	process.stdout.write(`Cleaned build output for ${result.cleanedWorkspaces.length} workspaces.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();

import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;

export interface ArtifactSnapshotRootOptions {
	agentDir: string;
	workspace: string;
	snapshotRoot: string;
}

/** Create and prove a Profile-private host snapshot root outside the Agent workspace. */
export async function prepareArtifactSnapshotRoot(options: ArtifactSnapshotRootOptions): Promise<string> {
	if (![options.agentDir, options.workspace, options.snapshotRoot].every(isAbsolute)) {
		throw new Error("Artifact snapshot paths must be absolute");
	}
	const agentDir = resolve(options.agentDir);
	const workspace = resolve(options.workspace);
	const snapshotRoot = resolve(options.snapshotRoot);
	assertStrictDescendant(agentDir, snapshotRoot, "Artifact snapshot root");
	if (pathsOverlap(workspace, snapshotRoot)) throw new Error("Artifact snapshot root must not overlap the Agent workspace");

	const agent = await inspectDirectory(agentDir, "Profile Agent directory", false);
	const workspaceDirectory = await inspectDirectory(workspace, "Artifact workspace", false);
	const relativeTarget = relative(agentDir, snapshotRoot);
	let current = agentDir;
	for (const segment of relativeTarget.split(sep).filter(Boolean)) {
		current = join(current, segment);
		try {
			await mkdir(current, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const directory = await inspectDirectory(current, "Artifact snapshot root", true);
		if (!isStrictDescendant(agent.realPath, directory.realPath)) throw new Error("Artifact snapshot root escapes the Profile Agent directory");
	}

	const root = await inspectDirectory(snapshotRoot, "Artifact snapshot root", true);
	if (pathsOverlap(workspaceDirectory.realPath, root.realPath)) throw new Error("Artifact snapshot root must not physically overlap the Agent workspace");
	await assertDirectoryUnchanged(agentDir, agent, "Profile Agent directory");
	await assertDirectoryUnchanged(workspace, workspaceDirectory, "Artifact workspace");
	return root.realPath;
}

/** Allocate one private per-snapshot directory below the already prepared Profile-owned root. */
export async function createPrivateArtifactSnapshotDirectory(workspace: string, snapshotRoot: string): Promise<string> {
	if (!isAbsolute(workspace) || !isAbsolute(snapshotRoot)) throw new Error("Artifact snapshot paths must be absolute");
	const workspaceDirectory = await inspectDirectory(resolve(workspace), "Artifact workspace", false);
	const rootPath = resolve(snapshotRoot);
	const root = await inspectDirectory(rootPath, "Artifact snapshot root", true);
	if (pathsOverlap(workspaceDirectory.realPath, root.realPath)) throw new Error("Artifact snapshot root must not overlap the Agent workspace");
	const directory = await mkdtemp(join(root.realPath, "delivery-"));
	try {
		const snapshot = await inspectDirectory(directory, "Artifact snapshot directory", true);
		if (!isStrictDescendant(root.realPath, snapshot.realPath)) throw new Error("Artifact snapshot directory escapes its trusted root");
		await assertDirectoryUnchanged(rootPath, root, "Artifact snapshot root");
		await assertDirectoryUnchanged(resolve(workspace), workspaceDirectory, "Artifact workspace");
		return snapshot.realPath;
	} catch (error) {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

interface DirectoryIdentity { dev: number; ino: number; realPath: string }

async function inspectDirectory(path: string, label: string, makePrivate: boolean): Promise<DirectoryIdentity> {
	const initial = await lstat(path);
	if (initial.isSymbolicLink() || !initial.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
	const handle = await open(path, constants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG);
	try {
		const opened = await handle.stat();
		if (!opened.isDirectory() || !sameFile(initial, opened)) throw new Error(`${label} changed while opening: ${path}`);
		if (makePrivate) await handle.chmod(0o700);
		const secured = await handle.stat();
		if (!secured.isDirectory() || !sameFile(opened, secured) || (makePrivate && (secured.mode & 0o077) !== 0)) {
			throw new Error(`${label} does not have private directory permissions: ${path}`);
		}
		const realPath = await realpath(path);
		const final = await lstat(path);
		if (final.isSymbolicLink() || !final.isDirectory() || !sameFile(secured, final) || await realpath(path) !== realPath) {
			throw new Error(`${label} changed during validation: ${path}`);
		}
		return { dev: secured.dev, ino: secured.ino, realPath };
	} finally {
		await handle.close();
	}
}

async function assertDirectoryUnchanged(path: string, expected: DirectoryIdentity, label: string): Promise<void> {
	const current = await lstat(path);
	if (current.isSymbolicLink() || !current.isDirectory() || !sameFile(current, expected) || await realpath(path) !== expected.realPath) {
		throw new Error(`${label} changed during Artifact snapshot setup`);
	}
}

function assertStrictDescendant(root: string, target: string, label: string): void {
	if (!isStrictDescendant(root, target)) throw new Error(`${label} must stay inside the Profile Agent directory`);
}

function isStrictDescendant(root: string, target: string): boolean {
	const child = relative(root, target);
	return Boolean(child) && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function pathsOverlap(first: string, second: string): boolean {
	return first === second || isStrictDescendant(first, second) || isStrictDescendant(second, first);
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

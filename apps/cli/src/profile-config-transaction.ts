import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { acquireProcessLock } from "./process-lock.ts";

const MAX_PROFILE_CONFIG_BYTES = 1024 * 1024;

interface FileState {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

interface DirectoryIdentity {
	dev: number;
	ino: number;
	realPath: string;
}

export async function mutateProfileConfig(
	configPath: string,
	mutate: (config: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
	const target = resolve(configPath);
	const parent = dirname(target);
	const parentIdentity = await stableDirectoryIdentity(parent, "Profile configuration parent");
	await assertOptionalRealDirectory(join(parent, "run"), "Profile configuration lock directory");
	const release = await acquireProcessLock(parent, `profile-config:${target}`, "Profile configuration");
	let temporary: string | undefined;
	try {
		await assertSameDirectory(parent, parentIdentity, "Profile configuration parent changed while acquiring its lock");
		const snapshot = await readStableConfiguration(target, parentIdentity);
		const config = (parseYaml(snapshot.content) ?? {}) as Record<string, unknown>;
		await mutate(config);
		const output = stringifyYaml(config);
		if (Buffer.byteLength(output, "utf8") > MAX_PROFILE_CONFIG_BYTES) {
			throw new Error(`Profile configuration exceeds the ${MAX_PROFILE_CONFIG_BYTES}-byte size limit`);
		}
		temporary = `${target}.update-${crypto.randomUUID()}`;
		const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			await file.writeFile(output, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await assertSameDirectory(parent, parentIdentity, "Profile configuration parent changed before publish");
		await assertSameConfiguration(target, snapshot.state, snapshot.realPath);
		// rename replaces a final symlink rather than following it. The identity
		// check immediately above additionally rejects all ordinary inode swaps.
		await rename(temporary, target);
		temporary = undefined;
		await assertSameDirectory(parent, parentIdentity, "Profile configuration parent changed during publish");
		await syncDirectory(parent, parentIdentity);
	} finally {
		if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
		await release();
	}
}

async function readStableConfiguration(
	path: string,
	parent: DirectoryIdentity,
): Promise<{ content: string; state: FileState; realPath: string }> {
	await assertSameDirectory(dirname(path), parent, "Profile configuration parent changed before read");
	const initial = await lstat(path);
	if (initial.isSymbolicLink() || !initial.isFile()) {
		throw new Error(`Profile configuration must be a regular file, not a symbolic link: ${path}`);
	}
	if (initial.size > MAX_PROFILE_CONFIG_BYTES) {
		throw new Error(`Profile configuration exceeds the ${MAX_PROFILE_CONFIG_BYTES}-byte size limit: ${path}`);
	}
	const initialState = fileState(initial);
	const realPath = await realpath(path);
	if (dirname(realPath) !== parent.realPath) throw new Error(`Profile configuration escapes its parent directory: ${path}`);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || !sameFilesystemObject(opened, initial)) {
			throw new Error(`Profile configuration changed while opening: ${path}`);
		}
		if (opened.size > MAX_PROFILE_CONFIG_BYTES) {
			throw new Error(`Profile configuration exceeds the ${MAX_PROFILE_CONFIG_BYTES}-byte size limit: ${path}`);
		}
		const bytes = await readBounded(handle, MAX_PROFILE_CONFIG_BYTES);
		const finalOpened = await handle.stat();
		const finalPath = await lstat(path);
		if (finalPath.isSymbolicLink()
			|| !finalPath.isFile()
			|| !sameFileState(initialState, fileState(finalPath))
			|| !sameFileState(fileState(opened), fileState(finalOpened))
			|| await realpath(path) !== realPath) {
			throw new Error(`Profile configuration changed while reading: ${path}`);
		}
		await assertSameDirectory(dirname(path), parent, "Profile configuration parent changed while reading");
		try {
			return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), state: initialState, realPath };
		} catch {
			throw new Error(`Profile configuration is not valid UTF-8: ${path}`);
		}
	} finally {
		await handle.close();
	}
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<Buffer> {
	const buffer = Buffer.alloc(maxBytes + 1);
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	if (offset > maxBytes) throw new Error(`Profile configuration exceeds the ${maxBytes}-byte size limit`);
	return buffer.subarray(0, offset);
}

async function assertSameConfiguration(path: string, expected: FileState, expectedRealPath: string): Promise<void> {
	const current = await lstat(path);
	if (current.isSymbolicLink()
		|| !current.isFile()
		|| !sameFileState(expected, fileState(current))
		|| await realpath(path) !== expectedRealPath) {
		throw new Error(`Profile configuration changed before publish: ${path}`);
	}
}

async function stableDirectoryIdentity(path: string, label: string): Promise<DirectoryIdentity> {
	const initial = await lstat(path);
	if (initial.isSymbolicLink() || !initial.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
	const realPath = await realpath(path);
	const final = await lstat(path);
	if (final.isSymbolicLink() || !final.isDirectory() || !sameFilesystemObject(initial, final) || await realpath(path) !== realPath) {
		throw new Error(`${label} changed while resolving: ${path}`);
	}
	return { dev: initial.dev, ino: initial.ino, realPath };
}

async function assertSameDirectory(path: string, expected: DirectoryIdentity, message: string): Promise<void> {
	const current = await lstat(path);
	if (current.isSymbolicLink()
		|| !current.isDirectory()
		|| current.dev !== expected.dev
		|| current.ino !== expected.ino
		|| await realpath(path) !== expected.realPath) {
		throw new Error(`${message}: ${path}`);
	}
}

async function assertOptionalRealDirectory(path: string, label: string): Promise<void> {
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`${label} must be a real directory: ${path}`);
}

async function syncDirectory(path: string, expected: DirectoryIdentity): Promise<void> {
	const directory = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
	try {
		const current = await directory.stat();
		if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
			throw new Error(`Profile configuration parent changed while syncing: ${path}`);
		}
		await directory.sync();
	} finally {
		await directory.close();
	}
}

function fileState(value: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): FileState {
	return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

function sameFilesystemObject(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left: FileState, right: FileState): boolean {
	return sameFilesystemObject(left, right)
		&& left.size === right.size
		&& left.mtimeMs === right.mtimeMs
		&& left.ctimeMs === right.ctimeMs;
}

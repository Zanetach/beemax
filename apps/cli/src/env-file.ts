import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_ENV_FILE_BYTES = 256 * 1024;

export function readEnvFileSync(path: string): Record<string, string> {
	let descriptor: number | undefined;
	try {
		const initial = lstatSync(path);
		if (initial.isSymbolicLink() || !initial.isFile() || initial.size > MAX_ENV_FILE_BYTES) throw new Error(`Profile environment file is invalid: ${path}`);
		const initialPath = realpathSync(path);
		descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const opened = fstatSync(descriptor);
		if (!sameFileState(initial, opened) || !opened.isFile() || opened.size > MAX_ENV_FILE_BYTES) throw new Error(`Profile environment file changed while opening: ${path}`);
		const content = readBoundedSync(descriptor, MAX_ENV_FILE_BYTES, path);
		const finalOpened = fstatSync(descriptor);
		const finalPath = lstatSync(path);
		if (finalPath.isSymbolicLink()
			|| !finalPath.isFile()
			|| !sameFileState(opened, finalOpened)
			|| !sameFileState(initial, finalPath)
			|| realpathSync(path) !== initialPath) throw new Error(`Profile environment file changed while reading: ${path}`);
		return parseEnv(decodeUtf8(content, path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	} finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export async function readEnvFile(path: string): Promise<Record<string, string>> {
	const initial = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!initial) return {};
	if (initial.isSymbolicLink() || !initial.isFile() || initial.size > MAX_ENV_FILE_BYTES) throw new Error(`Profile environment file is invalid: ${path}`);
	const initialPath = await realpath(path);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		if (!sameFileState(initial, opened) || !opened.isFile() || opened.size > MAX_ENV_FILE_BYTES) throw new Error(`Profile environment file changed while opening: ${path}`);
		const content = await readBounded(handle, MAX_ENV_FILE_BYTES, path);
		const [finalOpened, finalPath, finalRealPath] = await Promise.all([handle.stat(), lstat(path), realpath(path)]);
		if (finalPath.isSymbolicLink()
			|| !finalPath.isFile()
			|| !sameFileState(opened, finalOpened)
			|| !sameFileState(initial, finalPath)
			|| finalRealPath !== initialPath) throw new Error(`Profile environment file changed while reading: ${path}`);
		return parseEnv(decodeUtf8(content, path));
	} finally { await handle.close(); }
}

export async function writeEnvFile(path: string, values: Record<string, string>): Promise<void> {
	const content = Buffer.from(renderEnv(values), "utf8");
	if (content.byteLength > MAX_ENV_FILE_BYTES) throw new Error(`Profile environment file exceeds the ${MAX_ENV_FILE_BYTES}-byte size limit: ${path}`);
	const parent = dirname(path);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const parentInfo = await lstat(parent);
	if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error(`Profile environment parent must be a real directory: ${parent}`);
	const parentPath = await realpath(parent);
	const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`Profile environment file must be a regular file: ${path}`);
	const temporary = join(parent, `.env-${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally { await handle.close(); }
		const [currentParent, currentParentPath, current] = await Promise.all([
			lstat(parent),
			realpath(parent),
			lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }),
		]);
		if (currentParent.isSymbolicLink() || !currentParent.isDirectory() || !sameFilesystemObject(parentInfo, currentParent) || currentParentPath !== parentPath) {
			throw new Error(`Profile environment parent changed before publish: ${parent}`);
		}
		if (!sameOptionalFile(existing, current)) throw new Error(`Profile environment file changed before publish: ${path}`);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

function readBoundedSync(descriptor: number, maxBytes: number, path: string): Buffer {
	const content = Buffer.allocUnsafe(maxBytes + 1);
	let offset = 0;
	while (offset < content.byteLength) {
		const bytesRead = readSync(descriptor, content, offset, content.byteLength - offset, null);
		if (!bytesRead) break;
		offset += bytesRead;
	}
	if (offset > maxBytes) throw new Error(`Profile environment file exceeds the ${maxBytes}-byte size limit: ${path}`);
	return content.subarray(0, offset);
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number, path: string): Promise<Buffer> {
	const content = Buffer.allocUnsafe(maxBytes + 1);
	let offset = 0;
	while (offset < content.byteLength) {
		const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, null);
		if (!bytesRead) break;
		offset += bytesRead;
	}
	if (offset > maxBytes) throw new Error(`Profile environment file exceeds the ${maxBytes}-byte size limit: ${path}`);
	return content.subarray(0, offset);
}

function decodeUtf8(content: Buffer, path: string): string {
	try { return new TextDecoder("utf-8", { fatal: true }).decode(content); }
	catch { throw new Error(`Profile environment file is not valid UTF-8: ${path}`); }
}

function sameFilesystemObject(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">, right: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">): boolean {
	return sameFilesystemObject(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameOptionalFile(left: Stats | undefined, right: Stats | undefined): boolean {
	return left === undefined ? right === undefined : right !== undefined && !right.isSymbolicLink() && right.isFile() && sameFileState(left, right);
}

export function parseEnv(raw: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf("=");
		if (separator < 1) continue;
		const key = trimmed.slice(0, separator).trim();
		if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
		const encoded = trimmed.slice(separator + 1).trim();
		if (encoded.startsWith('"')) {
			try {
				const value = JSON.parse(encoded);
				if (typeof value === "string") values[key] = value;
				continue;
			} catch { /* fall back to the literal value */ }
		}
		values[key] = encoded.startsWith("'") && encoded.endsWith("'")
			? encoded.slice(1, -1)
			: encoded;
	}
	return values;
}

export function renderEnv(values: Record<string, string>): string {
	return `${Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
}

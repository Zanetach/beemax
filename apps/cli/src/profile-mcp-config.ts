import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadMcpConfig, validateMcpConfig, type McpConfig, type McpServerConfig } from "@thruvera/mcp-capability";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;

export async function inspectLocalMcpDescriptor(path: string): Promise<McpServerConfig> {
	if (!isAbsolute(path)) throw new Error("MCP descriptor source must be an absolute local file path");
	const content = await readStableLocalFile(resolve(path), MAX_DESCRIPTOR_BYTES);
	let value: unknown;
	try { value = JSON.parse(content); }
	catch { throw new Error(`MCP descriptor is not valid JSON: ${path}`); }
	return validateMcpConfig({ servers: { candidate: value } }).servers.candidate!;
}

export async function addProfileMcpServer(input: {
	profileHome: string;
	configPath: string;
	name: string;
	descriptorPath: string;
}): Promise<{ configPath: string; server: McpServerConfig }> {
	const name = serverName(input.name);
	const server = await inspectLocalMcpDescriptor(input.descriptorPath);
	if (server.type !== "http") throw new Error("Customer self-service MCP installation accepts HTTP descriptors only; a trusted host operator must provision a fixed absolute stdio command outside self-service");
	await mutateProfileMcpConfig(input.profileHome, input.configPath, (current) => {
		if (current.servers[name]) throw new Error(`MCP server '${name}' already exists in this Profile`);
		return { servers: { ...current.servers, [name]: server } };
	});
	return { configPath: resolve(input.configPath), server };
}

export async function removeProfileMcpServer(input: { profileHome: string; configPath: string; name: string }): Promise<{ configPath: string }> {
	const name = serverName(input.name);
	await mutateProfileMcpConfig(input.profileHome, input.configPath, (current) => {
		if (!current.servers[name]) throw new Error(`MCP server '${name}' is not configured in this Profile`);
		const servers = { ...current.servers };
		delete servers[name];
		return { servers };
	});
	return { configPath: resolve(input.configPath) };
}

async function mutateProfileMcpConfig(profileHome: string, configPath: string, operation: (current: McpConfig) => McpConfig): Promise<void> {
	const boundary = resolve(profileHome);
	const target = resolve(configPath);
	assertInside(boundary, target, "MCP config path");
	const [boundaryInfo, parentInfo] = await Promise.all([lstat(boundary), lstat(dirname(target))]);
	if (boundaryInfo.isSymbolicLink() || !boundaryInfo.isDirectory()) throw new Error(`Profile Home must be a real directory: ${boundary}`);
	if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error(`MCP config parent must be a real directory: ${dirname(target)}`);
	const [realBoundary, realParent] = await Promise.all([realpath(boundary), realpath(dirname(target))]);
	assertInside(realBoundary, realParent, "MCP config parent", true);

	const lockPath = join(dirname(target), `.${basename(target)}.lock`);
	const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "EEXIST") throw new Error(`MCP config is already being changed: ${target}`);
		throw error;
	});
	const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
	try {
		await lock.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
		await lock.sync();
		const before = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
		if (before && (before.isSymbolicLink() || !before.isFile())) throw new Error(`MCP config must be a regular Profile-local file: ${target}`);
		const current = before ? loadMcpConfig(target, { profileHome: boundary }) : { servers: {} };
		const next = validateMcpConfig(operation(current));
		const handle = await open(temporary, "wx", 0o600);
		try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); }
		finally { await handle.close(); }
		const observed = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
		if (!sameOptionalFile(before, observed)) throw new Error("MCP config changed during update");
		await rename(temporary, target);
		loadMcpConfig(target, { profileHome: boundary });
	} finally {
		await rm(temporary, { force: true });
		await lock.close();
		await unlink(lockPath).catch(() => undefined);
	}
}

async function readStableLocalFile(path: string, maxBytes: number): Promise<string> {
	const initial = await lstat(path);
	if (initial.isSymbolicLink() || !initial.isFile() || initial.size > maxBytes) throw new Error(`MCP descriptor must be a regular file no larger than ${maxBytes} bytes: ${path}`);
	const initialPath = await realpath(path);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || !sameFile(initial, opened) || opened.size > maxBytes) throw new Error(`MCP descriptor changed while opening: ${path}`);
		const content = await readFile(handle, "utf8");
		const [final, finalPath, finalOpened] = await Promise.all([lstat(path), realpath(path), handle.stat()]);
		if (final.isSymbolicLink() || !final.isFile() || !sameFile(initial, final) || !sameFile(opened, finalOpened) || finalPath !== initialPath) throw new Error(`MCP descriptor changed while reading: ${path}`);
		return content;
	} finally { await handle.close(); }
}

function serverName(value: string): string {
	const name = value.trim();
	if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) throw new Error(`Invalid MCP server name: ${value}`);
	return name;
}

function assertInside(boundary: string, candidate: string, label: string, allowBoundary = false): void {
	const path = relative(boundary, candidate);
	if ((!path && !allowBoundary) || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) throw new Error(`${label} must stay inside the selected Profile: ${candidate}`);
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean { return left.dev === right.dev && left.ino === right.ino; }
function sameOptionalFile(left: { dev: number; ino: number } | undefined, right: { dev: number; ino: number } | undefined): boolean {
	return left === undefined ? right === undefined : right !== undefined && sameFile(left, right);
}

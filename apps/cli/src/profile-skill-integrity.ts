import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

export const PROFILE_SKILL_TREE_LIMITS = Object.freeze({
	maxFiles: 128,
	maxDirectories: 64,
	maxDepth: 10,
	maxFileBytes: 256 * 1024,
	maxTotalBytes: 2 * 1024 * 1024,
});

export type ProfileSkillTreeIntegrity =
	| { state: "present"; sha256: string; fileCount: number; totalBytes: number }
	| { state: "missing" | "invalid"; reason: string };

interface TreeRecord { type: "directory" | "file"; path: string; content?: Buffer }
interface DirectorySnapshot { path: string; realPath: string; dev: number; ino: number; names: string[] }
interface FileSnapshot { path: string; realPath: string; content: Buffer }

/** Hash a complete Skill tree while rejecting links, special files, path escapes, and unbounded input. */
export async function inspectProfileSkillTree(boundary: string, skillName: string): Promise<ProfileSkillTreeIntegrity> {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) return invalid("Skill name is invalid");
	const boundaryPath = resolve(boundary);
	const skillRoot = resolve(boundaryPath, skillName);
	if (!inside(boundaryPath, skillRoot) || skillRoot === boundaryPath) return invalid("Skill path escaped its boundary");

	let boundaryInfo;
	try { boundaryInfo = await lstat(boundaryPath); }
	catch (error) { return missingOrInvalid(error, "Skill boundary is unavailable"); }
	if (boundaryInfo.isSymbolicLink() || !boundaryInfo.isDirectory()) return invalid("Skill boundary is not a real directory");

	let rootInfo;
	try { rootInfo = await lstat(skillRoot); }
	catch (error) { return missingOrInvalid(error, "Skill directory is unavailable"); }
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return invalid("Skill root is not a real directory");

	let realBoundary: string;
	let realRoot: string;
	try { [realBoundary, realRoot] = await Promise.all([realpath(boundaryPath), realpath(skillRoot)]); }
	catch (error) { return invalid(`Skill path could not be resolved: ${errorCode(error)}`); }
	if (!inside(realBoundary, realRoot)) return invalid("Skill root escaped its boundary");

	const records: TreeRecord[] = [{ type: "directory", path: "" }];
	const files = new Map<string, Buffer>();
	const directories: DirectorySnapshot[] = [];
	const fileSnapshots: FileSnapshot[] = [];
	const pending = [{ path: skillRoot, relativePath: "", depth: 0 }];
	let directoryCount = 1;
	let fileCount = 0;
	let totalBytes = 0;
	try {
		for (let cursor = 0; cursor < pending.length; cursor++) {
			const directory = pending[cursor]!;
			const [directoryInfo, realDirectory, entries] = await Promise.all([
				lstat(directory.path),
				realpath(directory.path),
				boundedDirectoryEntries(directory.path),
			]);
			if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !inside(realRoot, realDirectory)) throw new Error(`Skill directory changed or escaped: ${directory.relativePath || "."}`);
			directories.push({ path: directory.path, realPath: realDirectory, dev: directoryInfo.dev, ino: directoryInfo.ino, names: entries.map((entry) => entry.name) });
			for (const entry of entries) {
				const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
				const candidate = join(directory.path, entry.name);
				const info = await lstat(candidate);
				if (entry.isSymbolicLink() || info.isSymbolicLink()) throw new Error(`Skill tree contains a symbolic link: ${relativePath}`);
				const realCandidate = await realpath(candidate);
				if (!inside(realRoot, realCandidate)) throw new Error(`Skill tree path escaped its root: ${relativePath}`);
				if (info.isDirectory()) {
					if (!entry.isDirectory()) throw new Error(`Skill tree entry type changed: ${relativePath}`);
					if (directory.depth + 1 > PROFILE_SKILL_TREE_LIMITS.maxDepth) throw new Error("Skill tree depth limit exceeded");
					if (++directoryCount > PROFILE_SKILL_TREE_LIMITS.maxDirectories) throw new Error("Skill tree directory count limit exceeded");
					records.push({ type: "directory", path: relativePath });
					pending.push({ path: candidate, relativePath, depth: directory.depth + 1 });
					continue;
				}
				if (!info.isFile() || !entry.isFile()) throw new Error(`Skill tree contains a non-regular file: ${relativePath}`);
				if (++fileCount > PROFILE_SKILL_TREE_LIMITS.maxFiles) throw new Error("Skill tree file count limit exceeded");
				const maxBytes = fileByteLimit(relativePath);
				if (info.size > maxBytes) throw new Error(`Skill file byte limit exceeded: ${relativePath}`);
				const content = await readStableRegularFile(candidate, realCandidate, info, maxBytes);
				totalBytes += content.byteLength;
				if (totalBytes > PROFILE_SKILL_TREE_LIMITS.maxTotalBytes) throw new Error("Skill tree total byte limit exceeded");
				files.set(relativePath, content);
				records.push({ type: "file", path: relativePath, content });
				fileSnapshots.push({ path: candidate, realPath: realCandidate, content });
			}
		}
		validateSkillEntry(files.get("SKILL.md"), skillName);
		validateManifest(files.get("manifest.json"), files, skillRoot);
		for (const directory of directories) {
			const [current, currentPath, entries] = await Promise.all([lstat(directory.path), realpath(directory.path), boundedDirectoryEntries(directory.path)]);
			if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, directory) || currentPath !== directory.realPath || !sameNames(entries.map((entry) => entry.name), directory.names)) throw new Error("Skill directory changed while hashing");
		}
		for (const file of fileSnapshots) {
			const current = await lstat(file.path);
			if (!current.isFile() || current.isSymbolicLink() || (await realpath(file.path)) !== file.realPath) throw new Error("Skill file changed while hashing");
			const content = await readStableRegularFile(file.path, file.realPath, current, fileByteLimit(relative(skillRoot, file.path).split(sep).join("/")));
			if (!content.equals(file.content)) throw new Error("Skill file changed while hashing");
		}
		const [finalBoundary, finalRoot] = await Promise.all([lstat(boundaryPath), lstat(skillRoot)]);
		if (!finalBoundary.isDirectory() || finalBoundary.isSymbolicLink() || !sameFile(finalBoundary, boundaryInfo) || !finalRoot.isDirectory() || finalRoot.isSymbolicLink() || !sameFile(finalRoot, rootInfo)) throw new Error("Skill tree boundary changed while hashing");
	} catch (error) {
		return invalid(error instanceof Error ? error.message : "Skill tree integrity validation failed");
	}

	const hash = createHash("sha256");
	for (const record of records.sort((left, right) => compareText(left.path, right.path) || compareText(left.type, right.type))) {
		updateHashField(hash, Buffer.from(record.type === "directory" ? "D" : "F"));
		updateHashField(hash, Buffer.from(record.path, "utf8"));
		if (record.content) updateHashField(hash, record.content);
	}
	return { state: "present", sha256: hash.digest("hex"), fileCount, totalBytes };
}

async function readStableRegularFile(path: string, expectedPath: string, expected: { dev: number; ino: number; size: number }, maxBytes: number): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || !sameFile(opened, expected) || opened.size !== expected.size) throw new Error("Skill file changed while opening");
		const buffer = Buffer.alloc(maxBytes + 1);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset > maxBytes || offset !== opened.size) throw new Error("Skill file changed or exceeded its byte limit while reading");
		const [current, currentPath] = await Promise.all([lstat(path), realpath(path)]);
		if (!current.isFile() || current.isSymbolicLink() || !sameFile(opened, current) || current.size !== opened.size || currentPath !== expectedPath) throw new Error("Skill file changed while reading");
		return buffer.subarray(0, offset);
	} finally {
		await handle.close();
	}
}

async function boundedDirectoryEntries(path: string) {
	const directory = await opendir(path);
	const entries = [];
	try {
		for await (const entry of directory) {
			entries.push(entry);
			if (entries.length > PROFILE_SKILL_TREE_LIMITS.maxFiles + PROFILE_SKILL_TREE_LIMITS.maxDirectories) throw new Error("Skill directory entry limit exceeded");
		}
	} finally {
		await directory.close().catch(() => undefined);
	}
	return entries.sort((left, right) => compareText(left.name, right.name));
}

function validateSkillEntry(content: Buffer | undefined, expectedName: string): void {
	if (!content) throw new Error("Skill tree is missing SKILL.md");
	const text = utf8(content, "SKILL.md");
	const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
	if (frontmatter === undefined) throw new Error("SKILL.md frontmatter is invalid");
	const metadata = asRecord(parseYaml(frontmatter));
	if (metadata.name !== expectedName || typeof metadata.description !== "string" || !metadata.description.trim()) throw new Error("SKILL.md metadata is invalid");
}

function validateManifest(content: Buffer | undefined, files: ReadonlyMap<string, Buffer>, skillRoot: string): void {
	if (!content) return;
	const manifest = asRecord(JSON.parse(utf8(content, "manifest.json")));
	const routes = asRecord(manifest.routes);
	if (manifest.version !== 1 || !Object.keys(routes).length || Object.keys(routes).length > 50) throw new Error("Skill manifest is invalid");
	for (const [name, value] of Object.entries(routes)) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Skill manifest route name is invalid");
		const route = asRecord(value);
		const module = resourcePath(route.module, skillRoot);
		if (!module || !files.has(module)) throw new Error(`Skill manifest module is unavailable: ${String(route.module)}`);
		const references = route.references === undefined ? [] : route.references;
		const tools = route.tools === undefined ? [] : route.tools;
		if (!Array.isArray(references) || references.length > 100 || !Array.isArray(tools) || tools.length > 100) throw new Error("Skill manifest route dependencies are invalid");
		for (const reference of references) {
			const path = resourcePath(reference, skillRoot);
			if (!path || !files.has(path)) throw new Error(`Skill manifest reference is unavailable: ${String(reference)}`);
		}
		if (tools.some((tool) => typeof tool !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool) || tool === "bash")) throw new Error("Skill manifest Tool dependency is invalid");
	}
}

function resourcePath(value: unknown, root: string): string | undefined {
	if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || isAbsolute(value)) return undefined;
	const candidate = resolve(root, value);
	if (!inside(root, candidate) || candidate === root) return undefined;
	return relative(root, candidate).split(sep).join("/");
}

function updateHashField(hash: ReturnType<typeof createHash>, value: Buffer): void {
	const length = Buffer.allocUnsafe(8);
	length.writeBigUInt64BE(BigInt(value.byteLength));
	hash.update(length);
	hash.update(value);
}

function fileByteLimit(path: string): number {
	if (path === "SKILL.md") return 64_000;
	if (path === "manifest.json") return 100_000;
	return PROFILE_SKILL_TREE_LIMITS.maxFileBytes;
}

function utf8(content: Buffer, label: string): string {
	try { return new TextDecoder("utf-8", { fatal: true }).decode(content); }
	catch { throw new Error(`${label} is not valid UTF-8`); }
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean { return left.dev === right.dev && left.ino === right.ino; }
function inside(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sameNames(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function invalid(reason: string): ProfileSkillTreeIntegrity { return { state: "invalid", reason }; }
function missingOrInvalid(error: unknown, reason: string): ProfileSkillTreeIntegrity { return errorCode(error) === "ENOENT" ? { state: "missing", reason } : invalid(`${reason}: ${errorCode(error)}`); }
function errorCode(error: unknown): string { return typeof (error as NodeJS.ErrnoException)?.code === "string" ? (error as NodeJS.ErrnoException).code! : "unknown"; }

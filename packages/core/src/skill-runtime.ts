import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { rankCapabilityIndex } from "./capability-ranking.ts";

export interface SkillDescriptor {
	name: string; description: string; location: string; root: string; sha256: string;
	triggers: string[]; exclude: string[]; sourcePriority: number;
}
export interface SkillMatch extends SkillDescriptor { score: number; confidence: number; reason: string; }
export interface SkillRouteManifest { description?: string; module: string; references?: string[]; tools?: string[]; }
export interface SkillManifest { version: 1; routes: Record<string, SkillRouteManifest>; }
export type SkillRuntimeState = "idle" | "discovered" | "activated" | "routed" | "module_loaded" | "executing" | "completed";
export interface SkillExecutionSnapshot {
	state: SkillRuntimeState; skill?: string; sha256?: string; manifestSha256?: string; route?: string;
	loadedResources: Array<{ path: string; sha256: string; bytes: number; kind: "module" | "reference" }>;
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHARED_SKILL_CATALOGS = new Map<string, { loadedAt: number; value: Promise<SkillDescriptor[]> }>();

/** Profile/project/global Skill index. Discovery retains metadata, never Skill bodies. */
export class SkillRegistry {
	private readonly roots: readonly string[];
	private readonly catalogKey: string;
	constructor(roots: readonly string[]) { this.roots = roots; this.catalogKey = roots.map((root) => resolve(root)).join("\u0000"); }

	list(): Promise<SkillDescriptor[]> {
		const key = this.key();
		const cached = SHARED_SKILL_CATALOGS.get(key);
		if (cached && Date.now() - cached.loadedAt <= 5_000) return cached.value;
		const value = this.load().catch((error) => { if (SHARED_SKILL_CATALOGS.get(key)?.value === value) SHARED_SKILL_CATALOGS.delete(key); throw error; });
		SHARED_SKILL_CATALOGS.set(key, { loadedAt: Date.now(), value });
		return value;
	}
	invalidate(): void { SHARED_SKILL_CATALOGS.delete(this.key()); }
	private key(): string { return this.catalogKey; }
	private async load(): Promise<SkillDescriptor[]> {
		const found: SkillDescriptor[] = [];
		for (const [sourcePriority, root] of this.roots.entries()) {
			for (const location of await skillFiles(resolve(root))) {
				const name = dirname(location).split(sep).at(-1) ?? "";
				if (!NAME.test(name)) continue;
				try {
					const content = await boundedRead(location, 64_000, "Skill entry"); const metadata = parseFrontmatter<Record<string, unknown>>(content).frontmatter;
					const skillName = typeof metadata.name === "string" && NAME.test(metadata.name) ? metadata.name : name;
					const description = typeof metadata.description === "string" ? metadata.description : "";
					if (!description.trim()) continue;
					found.push({ name: skillName, description: description.trim(), location, root: dirname(location), sha256: digest(content), triggers: strings(metadata.triggers), exclude: strings(metadata.exclude), sourcePriority });
				} catch { /* Ignore incomplete Skill directories. */ }
			}
		}
		const byName = new Map<string, SkillDescriptor>();
		for (const skill of found.sort((a, b) => a.sourcePriority - b.sourcePriority)) if (!byName.has(skill.name)) byName.set(skill.name, skill);
		return Object.freeze([...byName.values()].map((skill) => Object.freeze(skill))) as unknown as SkillDescriptor[];
	}

	async search(query: string, limit = 5): Promise<SkillMatch[]> {
		return rankCapabilityIndex(query, (await this.list()).map((skill) => ({ ...skill, priority: skill.sourcePriority })), Math.max(1, Math.min(limit, 10)))
			.map(({ item, score, confidence, reason }) => ({ ...item, score, confidence, reason }));
	}
}

async function skillFiles(root: string, limit = 5_000): Promise<string[]> {
	const files: string[] = []; const pending = [{ path: root, depth: 0 }]; let cursor = 0; let visited = 0;
	while (cursor < pending.length && files.length < limit && visited++ < 10_000) {
		const directory = pending[cursor++]!; let entries; try { entries = (await readdir(directory.path, { withFileTypes: true })).slice(0, 1_000); } catch { continue; }
		if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) { files.push(resolve(directory.path, "SKILL.md")); continue; }
		if (directory.depth >= 10) continue;
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".git" && entry.name !== "node_modules" && pending.length < 10_000) pending.push({ path: resolve(directory.path, entry.name), depth: directory.depth + 1 });
	}
	return files;
}

/** Turn-scoped, version-fenced Skill activation and resource routing. */
export class SkillRuntime {
	private readonly registry: SkillRegistry;
	private readonly maxBytes: number;
	private readonly maxResources: number;
	private readonly legacyTools: readonly string[];
	private state: SkillRuntimeState = "idle";
	private discovered = new Map<string, SkillMatch>();
	private active?: SkillDescriptor;
	private manifest?: SkillManifest;
	private manifestSha256?: string;
	private manifestLocation?: string;
	private route?: { name: string; value: SkillRouteManifest };
	private loaded: SkillExecutionSnapshot["loadedResources"] = [];
	private resourceCache = new Map<string, { path: string; content: string; sha256: string; bytes: number; kind: "module" | "reference" }>();
	private resourceHashes = new Map<string, string>();
	private loadedBytes = 0;

	constructor(registry: SkillRegistry, maxBytes = 200_000, maxResources = 20, legacyTools: readonly string[] = []) { this.registry = registry; this.maxBytes = maxBytes; this.maxResources = maxResources; this.legacyTools = legacyTools; }

	async discover(query: string, limit = 5): Promise<SkillMatch[]> {
		this.reset(); const matches = await this.registry.search(query, limit);
		this.discovered = new Map(matches.map((item) => [item.name, item])); this.state = "discovered"; return matches;
	}
	async admitDiscovered(names: readonly string[]): Promise<SkillMatch[]> {
		const selected = new Set(names); const descriptors = (await this.registry.list()).filter((item) => selected.has(item.name));
		const admitted = descriptors.map((item): SkillMatch => ({ ...item, score: 0, confidence: 0, reason: "selected by Capability Runtime" }));
		// Tool discovery is allowed while one Skill is executing. It may add future
		// Skill candidates, but must not erase the active route/version fence.
		if (["activated", "routed", "module_loaded", "executing"].includes(this.state)) {
			for (const descriptor of admitted) this.discovered.set(descriptor.name, descriptor);
			return admitted;
		}
		this.reset(); this.discovered = new Map(admitted.map((item) => [item.name, item])); this.state = "discovered"; return admitted;
	}
	isDiscovered(name: string): boolean { return this.state === "discovered" && this.discovered.has(name); }
	retainDiscovered(names: readonly string[]): void {
		if (this.state !== "discovered") throw new Error("Skills can only be narrowed immediately after discovery");
		const selected = new Set(names); this.discovered = new Map([...this.discovered].filter(([name]) => selected.has(name)));
	}

	async activate(name: string): Promise<{ descriptor: SkillDescriptor; instructions: string; routes: Array<{ name: string; description?: string }> }> {
		if (this.active?.name === name && (this.state === "module_loaded" || this.state === "executing") && this.manifest) {
			const content = await this.readLocked(this.active.location, this.active.sha256);
			return { descriptor: this.active, instructions: stripFrontmatter(content), routes: Object.entries(this.manifest.routes).map(([routeName, route]) => ({ name: routeName, description: route.description })) };
		}
		const descriptor = this.discovered.get(name);
		if (!descriptor) throw new Error(`Skill ${name} must be discovered before activation`);
		const content = await this.readLocked(descriptor.location, descriptor.sha256);
		if (this.state !== "discovered") throw new Error("A Skill can only be activated immediately after discovery");
		this.active = descriptor; const loadedManifest = await loadManifest(descriptor.root, this.legacyTools); this.manifest = loadedManifest.manifest; this.manifestSha256 = loadedManifest.sha256; this.manifestLocation = loadedManifest.location; if (this.manifest.routes.legacy?.module === "SKILL.md") this.resourceHashes.set("SKILL.md", descriptor.sha256); this.state = "activated";
		return { descriptor, instructions: stripFrontmatter(content), routes: Object.entries(this.manifest.routes).map(([routeName, route]) => ({ name: routeName, description: route.description })) };
	}

	async routeTo(name: string): Promise<{ route: string; module: string; references: string[]; tools: string[] }> {
		if (this.state !== "activated" || !this.active || !this.manifest) throw new Error("A Skill must be activated before routing");
		const route = this.manifest.routes[name]; if (!route) throw new Error(`Unknown Skill route: ${name}`);
		const dependencies = [route.module, ...(route.references ?? [])]; if (dependencies.length > this.maxResources) throw new Error("Skill route resource count budget exceeded");
		let totalBytes = 0; const hashes = new Map<string, string>();
		for (const path of dependencies) { const locked = await hashResource(this.active.root, path, this.maxBytes - totalBytes); totalBytes += locked.bytes; hashes.set(path, locked.sha256); }
		this.resourceHashes = hashes; this.route = { name, value: route }; this.state = "routed";
		return { route: name, module: route.module, references: route.references ?? [], tools: route.tools ?? [] };
	}
	useActivatedInstructionsAsModule(): void {
		if (this.state !== "routed" || !this.active || this.route?.value.module !== "SKILL.md") throw new Error("The active route is not a legacy self-contained Skill");
		this.loaded.push({ path: "SKILL.md", sha256: this.active.sha256, bytes: 0, kind: "module" }); this.state = "module_loaded";
	}

	async readResource(path: string): Promise<{ path: string; content: string; sha256: string; bytes: number; kind: "module" | "reference" }> {
		if (!["routed", "module_loaded", "executing"].includes(this.state) || !this.active || !this.route) throw new Error("A Skill route must be selected before reading resources");
		const allowed = new Map<string, "module" | "reference">([[this.route.value.module, "module"], ...(this.route.value.references ?? []).map((item) => [item, "reference"] as const)]);
		const kind = allowed.get(path); if (!kind) throw new Error(`Skill resource is not declared by the active route: ${path}`);
		if (kind === "reference" && this.state === "routed") throw new Error("The Skill route module must be loaded before references");
		const cached = this.resourceCache.get(path); if (cached) return cached;
		if (this.loaded.length >= this.maxResources) throw new Error("Skill resource count budget exceeded");
		await this.assertActiveVersion();
		const handle = await openConfinedResource(this.active.root, path); const content = await boundedReadHandle(handle, this.maxBytes - this.loadedBytes, "Skill resource"); const bytes = Buffer.byteLength(content);
		if (this.loadedBytes + bytes > this.maxBytes) throw new Error("Skill resource byte budget exceeded");
		const sha256 = digest(content); if (this.resourceHashes.get(path) !== sha256) throw new Error(`Skill resource changed after activation: ${path}`); const resource = { path, content, sha256, bytes, kind };
		this.loadedBytes += bytes; this.loaded.push({ path, sha256, bytes, kind }); this.resourceCache.set(path, resource); this.state = kind === "module" ? "module_loaded" : "executing";
		return resource;
	}

	complete(): SkillExecutionSnapshot {
		if (!this.active || (this.state !== "module_loaded" && this.state !== "executing")) throw new Error("Skill execution cannot complete before its route module is loaded");
		const missingReferences = (this.route?.value.references ?? []).filter((path) => !this.resourceCache.has(path));
		if (missingReferences.length) throw new Error(`Skill execution cannot complete before every declared reference is loaded: ${missingReferences.join(", ")}`);
		const remaining = [...this.discovered].filter(([name]) => name !== this.active?.name);
		this.state = "completed"; const snapshot = this.snapshot(); this.reset();
		if (remaining.length) { this.discovered = new Map(remaining); this.state = "discovered"; }
		return snapshot;
	}
	snapshot(): SkillExecutionSnapshot { return { state: this.state, skill: this.active?.name, sha256: this.active?.sha256, manifestSha256: this.manifestSha256, route: this.route?.name, loadedResources: [...this.loaded] }; }
	reset(): void { this.state = "idle"; this.discovered.clear(); this.active = undefined; this.manifest = undefined; this.manifestSha256 = undefined; this.manifestLocation = undefined; this.route = undefined; this.loaded = []; this.resourceCache.clear(); this.resourceHashes.clear(); this.loadedBytes = 0; }
	private async assertActiveVersion(): Promise<void> { if (!this.active) return; await this.readLocked(this.active.location, this.active.sha256); if (this.manifestLocation && this.manifestSha256) await this.readLocked(this.manifestLocation, this.manifestSha256); }
	private async readLocked(path: string, sha256: string): Promise<string> { const content = await boundedRead(path, basename(path) === "manifest.json" ? 100_000 : 64_000, "Skill metadata"); if (digest(content) !== sha256) throw new Error("Skill changed after discovery; discover and activate it again"); return content; }
}

async function loadManifest(root: string, legacyTools: readonly string[]): Promise<{ manifest: SkillManifest; sha256: string; location?: string }> {
	try {
		const location = resolve(root, "manifest.json"); const content = await boundedRead(location, 100_000, "Skill manifest"); const value = JSON.parse(content) as SkillManifest;
		if (value.version !== 1 || !value.routes || typeof value.routes !== "object") throw new Error("Invalid Skill manifest");
		if (Object.keys(value.routes).length > 50) throw new Error("Skill manifest route limit exceeded");
		for (const [name, route] of Object.entries(value.routes)) {
			if (!NAME.test(name) || !route || typeof route.module !== "string" || (route.references !== undefined && !Array.isArray(route.references)) || (route.tools !== undefined && !Array.isArray(route.tools))) throw new Error("Invalid Skill route");
			if ((route.references?.length ?? 0) > 100 || (route.tools?.length ?? 0) > 100) throw new Error("Skill route dependency limit exceeded");
			safeResource(root, route.module);
			for (const path of route.references ?? []) { if (typeof path !== "string" || path.length > 500) throw new Error("Invalid Skill reference"); safeResource(root, path); }
			for (const tool of [...new Set(route.tools ?? [])]) if (typeof tool !== "string" || tool === "bash" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool) || (legacyTools.length && !legacyTools.includes(tool))) throw new Error(`Skill route requests unavailable tool: ${String(tool)}`);
		}
		return { manifest: value, sha256: digest(content), location };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			const references = await discoverLegacyReferences(root);
			const manifest: SkillManifest = { version: 1, routes: { legacy: { description: "Compatibility route for a self-contained SKILL.md", module: "SKILL.md", ...(references.length ? { references } : {}), tools: [] } } };
			return { manifest, sha256: digest(JSON.stringify(manifest)) };
		}
		throw error;
	}
}

async function discoverLegacyReferences(root: string): Promise<string[]> {
	const entry = await boundedRead(resolve(root, "SKILL.md"), 64_000, "Skill entry");
	const pattern = /(?:^|[\s"'`(\[])((?:\.\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:md|mdx|txt|json|ya?ml|toml|csv|tsv|js|mjs|cjs|ts|mts|cts|py|sh|bash|zsh|sql|html|css|svg))(?=$|[\s"'`)\],:;])/gmu;
	const referenced = [...new Set([...entry.matchAll(pattern)]
		.map((match) => match[1]!.replace(/^\.\//, ""))
		.filter((path) => path !== "SKILL.md" && path !== "manifest.json"))];
	if (referenced.length > 19) throw new Error("Legacy Skill references exceed the compatibility route resource limit; add manifest.json with explicit routes");
	for (const path of referenced) {
		let handle;
		try { handle = await openConfinedResource(root, path); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Skill referenced resource is unavailable: ${path}`);
			throw error;
		}
		try { if (!(await handle.stat()).isFile()) throw new Error(`Skill referenced resource is unavailable: ${path}`); }
		finally { await handle.close(); }
	}
	return referenced;
}
function safeResource(root: string, path: string): string { const absolute = resolve(root, path); if (!path || path.startsWith("/") || !absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error("Skill resource path escaped its directory"); return absolute; }
async function openConfinedResource(root: string, path: string) {
	const candidate = safeResource(root, path); const [realRoot, expectedPath] = await Promise.all([realpath(root), realpath(candidate)]);
	if (!expectedPath.startsWith(`${realRoot}${sep}`)) throw new Error("Skill resource symlink escaped its directory");
	let handle; try { handle = await open(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Skill resource symlink escaped its directory"); throw error; }
	try {
		const [opened, currentPath] = await Promise.all([handle.stat(), realpath(candidate)]); const current = await open(currentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try { const currentInfo = await current.stat(); if (currentPath !== expectedPath || opened.dev !== currentInfo.dev || opened.ino !== currentInfo.ino) throw new Error("Skill resource path changed while opening"); } finally { await current.close(); }
		return handle;
	} catch (error) { await handle.close(); throw error; }
}
async function boundedReadHandle(handle: Awaited<ReturnType<typeof open>>, maxBytes: number, label: string): Promise<string> {
	try { if (maxBytes <= 0) throw new Error(`${label} byte budget exceeded`); const info = await handle.stat(); if (!info.isFile() || info.size > maxBytes) throw new Error(`${label} byte budget exceeded`); const buffer = Buffer.alloc(Math.min(maxBytes + 1, info.size + 1)); let offset = 0; while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; } if (offset > maxBytes) throw new Error(`${label} byte budget exceeded`); return buffer.subarray(0, offset).toString("utf8"); } finally { await handle.close(); }
}
async function boundedRead(path: string, maxBytes: number, label: string): Promise<string> {
	if (maxBytes <= 0) throw new Error(`${label} byte budget exceeded`); const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat(); if (!info.isFile()) throw new Error(`${label} is not a regular file`); if (info.size > maxBytes) throw new Error(`${label} byte budget exceeded`);
		const buffer = Buffer.alloc(Math.min(maxBytes + 1, info.size + 1)); let offset = 0;
		while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
		if (offset > maxBytes) throw new Error(`${label} byte budget exceeded`); return buffer.subarray(0, offset).toString("utf8");
	} finally { await handle.close(); }
}
async function hashResource(root: string, path: string, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
	const handle = await openConfinedResource(root, path);
	try {
		const info = await handle.stat(); if (!info.isFile() || info.size > maxBytes) throw new Error(`Skill route byte budget exceeded: ${path}`);
		const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024); let position = 0;
		while (position < info.size) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; }
		return { sha256: hash.digest("hex"), bytes: position };
	} finally { await handle.close(); }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 50) : typeof value === "string" ? value.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).slice(0, 50) : []; }

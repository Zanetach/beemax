import { createHash, randomUUID } from "node:crypto";
import { spawn as spawnChild, type SpawnOptions } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync, statSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import type { MediaArtifact, TaskArtifact } from "@beemax/core";

export interface CaddyArtifactSiteOptions {
	agentDir: string;
	workspace: string;
	/** Host-owned Profile-private snapshots proven from workspace Artifacts by Dispatcher. */
	snapshotRoot?: string;
	storageRoot: string;
	runtimeRoot: string;
	publicBaseUrl: string;
	command: string;
	listen: string;
	/** A host-owned, prefiltered snapshot. Profile configuration and Profile .env never belong here. */
	hostEnvironment: Readonly<Record<string, string | undefined>>;
}

export type CaddyArtifactSiteResolvedOptions = Omit<CaddyArtifactSiteOptions, "hostEnvironment">;

export interface PublishedDocument {
	url: string;
	name: string;
	mediaType: string;
	disposition: "inline" | "attachment";
}

interface DocumentTypePolicy {
	mediaType: string;
	disposition: PublishedDocument["disposition"];
	contentSecurityPolicy?: string;
}

interface CaddyProcess {
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	stderr: NodeJS.ReadableStream | null;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: string, listener: (...args: never[]) => void): this;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	kill(signal?: NodeJS.Signals): boolean;
}

interface CaddyArtifactSiteDependencies {
	spawn: (command: string, args: string[], options: SpawnOptions) => CaddyProcess;
	fetch: (url: string) => Promise<{ ok: boolean; status: number }>;
	delay: (milliseconds: number) => Promise<void>;
	/** Test boundary after the source descriptor and inode are pinned, before any copy starts. */
	afterSourcePinned: (source: string) => void | Promise<void>;
}

const HTML_CONTENT_SECURITY_POLICY = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts";
const CADDY_HOST_ENVIRONMENT_KEYS = Object.freeze([
	"PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "DISPLAY",
	"LANG", "LANGUAGE", "TZ",
	"LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_COLLATE", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
	"LC_PAPER", "LC_NAME", "LC_ADDRESS", "LC_TELEPHONE", "LC_MEASUREMENT", "LC_IDENTIFICATION",
] as const);
const FIXED_CADDY_COMMAND_CANDIDATES = Object.freeze([
	"/opt/homebrew/bin/caddy",
	"/home/linuxbrew/.linuxbrew/bin/caddy",
]);
const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = fsConstants.O_DIRECTORY ?? 0;
const DOCUMENT_TYPES = new Map<string, DocumentTypePolicy>([
	[".html", { mediaType: "text/html", disposition: "inline", contentSecurityPolicy: HTML_CONTENT_SECURITY_POLICY }],
	[".htm", { mediaType: "text/html", disposition: "inline", contentSecurityPolicy: HTML_CONTENT_SECURITY_POLICY }],
	[".pdf", { mediaType: "application/pdf", disposition: "inline" }],
	[".doc", { mediaType: "application/msword", disposition: "attachment" }],
	[".docx", { mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", disposition: "attachment" }],
	[".docm", { mediaType: "application/vnd.ms-word.document.macroEnabled.12", disposition: "attachment" }],
	[".dot", { mediaType: "application/msword", disposition: "attachment" }],
	[".dotx", { mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.template", disposition: "attachment" }],
	[".odt", { mediaType: "application/vnd.oasis.opendocument.text", disposition: "attachment" }],
	[".rtf", { mediaType: "application/rtf", disposition: "attachment" }],
]);

export class CaddyArtifactSite {
	readonly options: CaddyArtifactSiteResolvedOptions;
	private readonly publicBaseUrl: string;
	private readonly routePrefix: string;
	private readonly healthUrl: string;
	private readonly hostEnvironment: NodeJS.ProcessEnv;
	private readonly dependencies: CaddyArtifactSiteDependencies;
	private child?: CaddyProcess;
	private ready = false;
	private lifecycleManaged = false;

	constructor(options: CaddyArtifactSiteOptions, dependencies: Partial<CaddyArtifactSiteDependencies> = {}) {
		this.options = {
			agentDir: options.agentDir,
			workspace: options.workspace,
			snapshotRoot: options.snapshotRoot,
			storageRoot: options.storageRoot,
			runtimeRoot: options.runtimeRoot,
			publicBaseUrl: options.publicBaseUrl,
			command: options.command,
			listen: options.listen,
		};
		const publicBaseUrl = validateArtifactSitePublicBaseUrl(options.publicBaseUrl);
		const url = new URL(publicBaseUrl);
		const routePrefix = url.pathname.replace(/\/+$/u, "");
		if (![options.agentDir, options.workspace, options.storageRoot, options.runtimeRoot, ...(options.snapshotRoot ? [options.snapshotRoot] : [])].every(isAbsolute)) {
			throw new Error("Caddy Artifact Site paths must be absolute");
		}
		assertStrictLexicalDescendant(options.agentDir, options.storageRoot, "publication root");
		assertStrictLexicalDescendant(options.agentDir, options.runtimeRoot, "runtime root");
		if (options.snapshotRoot) {
			assertStrictLexicalDescendant(options.agentDir, options.snapshotRoot, "artifact snapshot root");
			if (pathsOverlap(options.workspace, options.snapshotRoot)) {
				throw new Error("Caddy Artifact Site artifact snapshot root must not overlap the Agent workspace");
			}
			if (pathsOverlap(options.snapshotRoot, options.storageRoot) || pathsOverlap(options.snapshotRoot, options.runtimeRoot)) {
				throw new Error("Caddy Artifact Site artifact snapshot root must not overlap publication or runtime state");
			}
		}
		if (pathsOverlap(options.storageRoot, options.runtimeRoot)) {
			throw new Error("Caddy Artifact Site publication and runtime roots must not overlap");
		}
		if (!options.command.trim() || options.command !== options.command.trim() || /[\u0000-\u001f\u007f]/u.test(options.command)) {
			throw new Error("Caddy Artifact Site command is invalid");
		}
		const listen = parseArtifactSiteListen(options.listen);
		this.publicBaseUrl = publicBaseUrl;
		this.routePrefix = routePrefix;
		this.healthUrl = `http://${healthAuthority(listen.host, listen.port)}/healthz`;
		this.hostEnvironment = caddyHostEnvironment(options.hostEnvironment);
		this.dependencies = {
			spawn: dependencies.spawn ?? ((command, args, spawnOptions) => spawnChild(command, args, spawnOptions) as CaddyProcess),
			fetch: dependencies.fetch ?? (async (healthUrl) => fetch(healthUrl, { redirect: "error", signal: AbortSignal.timeout(500) })),
			delay: dependencies.delay ?? (async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
			afterSourcePinned: dependencies.afterSourcePinned ?? (() => undefined),
		};
	}

	get isRunning(): boolean {
		return this.ready && this.child !== undefined && processIsLive(this.child);
	}

	async start(): Promise<void> {
		this.lifecycleManaged = true;
		if (this.isRunning) return;
		if (this.child && processIsLive(this.child)) throw new Error("Caddy Artifact Site is already starting");
		const storageRoot = await ensurePrivateDirectoryWithin(this.options.agentDir, this.options.storageRoot, "publication root");
		const runtimeRoot = await prepareCaddyRuntimeDirectories(this.options.agentDir, this.options.runtimeRoot);
		const configPath = join(runtimeRoot, "Caddyfile");
		const pidPath = join(runtimeRoot, "caddy.pid");
		await removeStalePidFile(pidPath);
		await writePrivateAtomicFile(configPath, renderCaddyfile(this.options.listen, this.routePrefix, storageRoot), "Caddyfile");

		let stderr = "";
		let spawnError: Error | undefined;
		const child = this.dependencies.spawn(this.options.command, [
			"run",
			"--config", configPath,
			"--adapter", "caddyfile",
			"--pidfile", pidPath,
		], {
			cwd: runtimeRoot,
			detached: false,
			env: caddyRuntimeEnvironment(this.hostEnvironment, runtimeRoot),
			shell: false,
			stdio: ["ignore", "ignore", "pipe"],
		});
		this.child = child;
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = `${stderr}${String(chunk)}`.slice(-4_000);
		});
		child.on("error", (error) => {
			spawnError = error;
			stderr = `${stderr}\n${error.message}`.trim().slice(-4_000);
		});
		child.on("exit", () => {
			this.ready = false;
		});

		try {
			let consecutiveHealthyProbes = 0;
			for (let attempt = 0; attempt < 50; attempt += 1) {
				if (spawnError) throw new Error(`Caddy Artifact Site could not start: ${spawnError.message}`);
				if (!processIsLive(child)) throw new Error(caddyStartFailure(stderr, child));
				try {
					const response = await this.dependencies.fetch(this.healthUrl);
					if (response.ok) {
						consecutiveHealthyProbes += 1;
						if (consecutiveHealthyProbes >= 2) {
							this.ready = true;
							return;
						}
					} else {
						consecutiveHealthyProbes = 0;
					}
				} catch {
					consecutiveHealthyProbes = 0;
					// The listener may not be bound yet; retry within the bounded startup window.
				}
				await this.dependencies.delay(100);
			}
			throw new Error(`Caddy Artifact Site did not become ready at ${this.healthUrl}${stderr ? `: ${stderr}` : ""}`);
		} catch (error) {
			if (spawnError) {
				this.child = undefined;
				this.ready = false;
				await rm(pidPath, { force: true });
			} else {
				await this.stop();
			}
			throw error;
		}
	}

	async stop(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.ready = false;
		if (child && processIsLive(child)) {
			const gracefulExit = waitForExit(child, 3_000);
			child.kill("SIGTERM");
			if (!await gracefulExit && processIsLive(child)) {
				const forcedExit = waitForExit(child, 1_000);
				child.kill("SIGKILL");
				await forcedExit;
			}
		}
		await rm(join(this.options.runtimeRoot, "caddy.pid"), { force: true });
	}

	async publish(artifact: TaskArtifact, media: MediaArtifact): Promise<PublishedDocument> {
		if (this.lifecycleManaged && !this.isRunning) throw new Error("Caddy Artifact Site is not running; refusing to publish an online link");
		const manifest = artifact.manifest;
		if (artifact.type !== "file" || !manifest || manifest.locator.kind !== "workspace") {
			throw new Error("Caddy Artifact Site requires a file Artifact with a workspace Manifest");
		}
		if (!/^[a-f0-9]{64}$/u.test(manifest.sha256)) throw new Error("Caddy Artifact Site requires a valid Artifact SHA-256");
		if (!Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 0) throw new Error("Caddy Artifact Site requires a valid Artifact byte length");
		const name = media.name ?? basename(media.path);
		if (!name || name !== basename(name) || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("Caddy Artifact Site received an invalid document name");
		if (name !== basename(media.path)) throw new Error("Caddy Artifact Site document name must match the integrity-checked source name");
		const documentType = DOCUMENT_TYPES.get(extname(name).toLowerCase());
		if (!documentType) throw new Error(`Caddy Artifact Site unsupported document type: ${name}`);
		if (manifest.mediaType !== documentType.mediaType || media.mimeType !== documentType.mediaType) {
			throw new Error(`Caddy Artifact Site media type does not match ${name}`);
		}

		const sourcePathInfo = await lstat(media.path);
		if (sourcePathInfo.isSymbolicLink() || !sourcePathInfo.isFile()) {
			throw new Error("Caddy Artifact Site source must be a regular file, not a symbolic link");
		}
		const source = await realpath(media.path);
		await assertTrustedArtifactSource(this.options, source, sourcePathInfo);

		let sourceHandle: FileHandle | undefined;
		let staged: { path: string; info: Stats } | undefined;
		let published = false;
		try {
			sourceHandle = await open(source, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
			const sourceInfo = await sourceHandle.stat();
			const pinnedPathInfo = await lstat(source);
			if (!sourceInfo.isFile() || !sameInode(sourceInfo, pinnedPathInfo) || sourceInfo.size !== manifest.byteLength) {
				throw new Error("Caddy Artifact Site source failed Artifact integrity checks");
			}
			await this.dependencies.afterSourcePinned(source);

			const storageRoot = await ensurePrivateDirectoryWithin(this.options.agentDir, this.options.storageRoot, "publication root");
			const runtimeRoot = await prepareCaddyRuntimeDirectories(this.options.agentDir, this.options.runtimeRoot);
			const directory = await ensurePrivateDirectoryWithin(this.options.agentDir, join(storageRoot, manifest.sha256), "publication directory");
			const destination = join(directory, name);
			staged = await createVerifiedStagedCopy(sourceHandle, directory, manifest.byteLength, manifest.sha256);

			const existing = await inspectPublishedDestination(destination, manifest.byteLength, manifest.sha256);
			if (existing === "valid") {
				return publishedDocument(this.publicBaseUrl, manifest.sha256, name, documentType);
			}
			if (existing === "invalid") {
				await quarantineInvalidDestination(destination, join(runtimeRoot, "quarantine"), manifest.sha256);
				throw new Error("Caddy Artifact Site existing published copy was invalid and has been quarantined");
			}

			// Recheck immediately before the atomic replacement boundary. Private 0700 parents prevent Profile content from racing this path.
			if (await lstatIfExists(destination)) {
				await quarantineInvalidDestination(destination, join(runtimeRoot, "quarantine"), manifest.sha256);
				throw new Error("Caddy Artifact Site publication destination changed and has been quarantined");
			}
			await rename(staged.path, destination);
			published = true;
			await syncDirectory(directory);
			const finalInfo = await lstat(destination);
			if (!finalInfo.isFile() || !sameInode(finalInfo, staged.info) || finalInfo.size !== manifest.byteLength || (finalInfo.mode & 0o222) !== 0) {
				await quarantineInvalidDestination(destination, join(runtimeRoot, "quarantine"), manifest.sha256);
				published = false;
				throw new Error("Caddy Artifact Site published copy failed Artifact integrity checks and has been quarantined");
			}
			const finalInspection = await inspectPublishedDestination(destination, manifest.byteLength, manifest.sha256);
			if (finalInspection !== "valid") {
				await quarantineInvalidDestination(destination, join(runtimeRoot, "quarantine"), manifest.sha256);
				published = false;
				throw new Error("Caddy Artifact Site published copy failed Artifact integrity checks and has been quarantined");
			}

			return publishedDocument(this.publicBaseUrl, manifest.sha256, name, documentType);
		} finally {
			await sourceHandle?.close().catch(() => undefined);
			if (staged && !published) await rm(staged.path, { force: true }).catch(() => undefined);
		}
	}
}

export function validateArtifactSitePublicBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Caddy Artifact Site publicBaseUrl must be a valid HTTP(S) URL");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
		throw new Error("Caddy Artifact Site publicBaseUrl must be an HTTP(S) URL without credentials, query, or fragment");
	}
	const routePrefix = url.pathname.replace(/\/+$/u, "");
	if (!routePrefix || routePrefix === "/" || !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u.test(routePrefix)) {
		throw new Error("Caddy Artifact Site publicBaseUrl must contain a safe non-root path");
	}
	return `${url.origin}${routePrefix}`;
}

export function validateArtifactSiteListen(value: string): string {
	parseArtifactSiteListen(value);
	return value;
}

export function artifactSiteLocalBaseUrl(listen: string): string {
	const parsed = parseArtifactSiteListen(listen);
	return `http://${healthAuthority(parsed.host, parsed.port)}/artifacts`;
}

/** Resolve only from the trusted Gateway host process and fixed installation candidates. */
export function resolveCaddyHostCommand(environment: Readonly<Record<string, string | undefined>> = process.env): string {
	const configured = environment.BEEMAX_ARTIFACT_SITE_COMMAND;
	if (configured !== undefined) {
		if (!configured || configured !== configured.trim() || /[\u0000-\u001f\u007f]/u.test(configured)) {
			throw new Error("Invalid trusted host BEEMAX_ARTIFACT_SITE_COMMAND");
		}
		return canonicalHostExecutable(configured, environment) ?? configured;
	}
	for (const candidate of FIXED_CADDY_COMMAND_CANDIDATES) {
		const executable = canonicalHostExecutable(candidate, environment);
		if (executable) return executable;
	}
	return canonicalHostExecutable("caddy", environment) ?? "caddy";
}

function canonicalHostExecutable(command: string, environment: Readonly<Record<string, string | undefined>>): string | undefined {
	const candidates = isAbsolute(command)
		? [command]
		: basename(command) === command
			? (environment.PATH ?? "").split(delimiter).filter((entry) => isAbsolute(entry)).flatMap((directory) => {
				if (process.platform !== "win32") return [join(directory, command)];
				const extensions = (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
				return extname(command) ? [join(directory, command)] : extensions.map((extension) => join(directory, `${command}${extension.toLowerCase()}`));
			})
			: [];
	for (const candidate of candidates) {
		try {
			const canonical = realpathSync(candidate);
			if (!statSync(canonical).isFile()) continue;
			accessSync(canonical, fsConstants.X_OK);
			return canonical;
		} catch {
			// Doctor reports a missing or non-executable explicit command as FAIL.
		}
	}
	return undefined;
}

/** Capture the exact non-secret host variables that Caddy is allowed to receive. */
export function caddyHostEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): NodeJS.ProcessEnv {
	const selected: NodeJS.ProcessEnv = {};
	for (const key of CADDY_HOST_ENVIRONMENT_KEYS) {
		const value = environment[key];
		if (typeof value === "string") selected[key] = value;
	}
	return Object.freeze(selected);
}

/** Build the credential-free child environment shared by Caddy startup and Doctor. */
export function caddyRuntimeEnvironment(
	hostEnvironment: Readonly<Record<string, string | undefined>>,
	runtimeRoot: string,
): NodeJS.ProcessEnv {
	if (!isAbsolute(runtimeRoot)) throw new Error("Caddy Artifact Site runtime root must be absolute");
	const selected = caddyHostEnvironment(hostEnvironment);
	const temporaryRoot = join(runtimeRoot, "tmp");
	return Object.freeze({
		...selected,
		HOME: runtimeRoot,
		USERPROFILE: runtimeRoot,
		XDG_CONFIG_HOME: join(runtimeRoot, "config"),
		XDG_DATA_HOME: join(runtimeRoot, "data"),
		XDG_CACHE_HOME: join(runtimeRoot, "cache"),
		TMPDIR: temporaryRoot,
		TMP: temporaryRoot,
		TEMP: temporaryRoot,
	});
}

/** Create the Caddy state tree without ever following a Profile-controlled path segment. */
export async function prepareCaddyRuntimeDirectories(agentDir: string, runtimeRoot: string): Promise<string> {
	const resolvedRuntimeRoot = await ensurePrivateDirectoryWithin(agentDir, runtimeRoot, "runtime root");
	for (const name of ["data", "config", "cache", "tmp", "quarantine"] as const) {
		await ensurePrivateDirectoryWithin(agentDir, join(resolvedRuntimeRoot, name), `${name} directory`);
	}
	return resolvedRuntimeRoot;
}

function publishedDocument(publicBaseUrl: string, digest: string, name: string, policy: DocumentTypePolicy): PublishedDocument {
	return {
		url: `${publicBaseUrl}/${digest}/${encodeURIComponent(name)}`,
		name,
		mediaType: policy.mediaType,
		disposition: policy.disposition,
	};
}

async function createVerifiedStagedCopy(
	source: FileHandle,
	directory: string,
	expectedSize: number,
	expectedDigest: string,
): Promise<{ path: string; info: Stats }> {
	const path = join(directory, `.publish-${randomUUID()}.tmp`);
	let destination: FileHandle | undefined;
	try {
		destination = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW_FLAG, 0o600);
		const openedInfo = await destination.stat();
		if (!openedInfo.isFile() || openedInfo.nlink !== 1) throw new Error("Caddy Artifact Site staging path is not a private regular file");
		const digest = await copyAndHashPinnedSource(source, destination);
		if (digest.byteLength !== expectedSize || digest.sha256 !== expectedDigest) {
			throw new Error("Caddy Artifact Site source failed Artifact integrity checks");
		}
		await destination.sync();
		await destination.chmod(0o444);
		const info = await destination.stat();
		if (!info.isFile() || info.nlink !== 1 || info.size !== expectedSize || (info.mode & 0o222) !== 0) {
			throw new Error("Caddy Artifact Site staged copy failed Artifact integrity checks");
		}
		await destination.close();
		destination = undefined;
		return { path, info };
	} catch (error) {
		await destination?.close().catch(() => undefined);
		await rm(path, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function copyAndHashPinnedSource(source: FileHandle, destination: FileHandle): Promise<{ sha256: string; byteLength: number }> {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let readOffset = 0;
	let writeOffset = 0;
	while (true) {
		const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, readOffset);
		if (bytesRead === 0) break;
		hash.update(buffer.subarray(0, bytesRead));
		let chunkOffset = 0;
		while (chunkOffset < bytesRead) {
			const { bytesWritten } = await destination.write(buffer, chunkOffset, bytesRead - chunkOffset, writeOffset + chunkOffset);
			if (bytesWritten <= 0) throw new Error("Caddy Artifact Site could not complete the staged copy");
			chunkOffset += bytesWritten;
		}
		readOffset += bytesRead;
		writeOffset += bytesRead;
	}
	return { sha256: hash.digest("hex"), byteLength: readOffset };
}

async function inspectPublishedDestination(path: string, expectedSize: number, expectedDigest: string): Promise<"absent" | "valid" | "invalid"> {
	const pathInfo = await lstatIfExists(path);
	if (!pathInfo) return "absent";
	if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1 || pathInfo.size !== expectedSize || (pathInfo.mode & 0o222) !== 0) {
		return "invalid";
	}
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
		const openedInfo = await handle.stat();
		if (!openedInfo.isFile() || !sameInode(openedInfo, pathInfo) || openedInfo.nlink !== 1 || openedInfo.size !== expectedSize) return "invalid";
		return await sha256FileHandle(handle) === expectedDigest ? "valid" : "invalid";
	} catch {
		return "invalid";
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function sha256FileHandle(handle: FileHandle): Promise<string> {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let offset = 0;
	while (true) {
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
		if (bytesRead === 0) break;
		hash.update(buffer.subarray(0, bytesRead));
		offset += bytesRead;
	}
	return hash.digest("hex");
}

async function quarantineInvalidDestination(path: string, quarantineRoot: string, digest: string): Promise<void> {
	await chmod(quarantineRoot, 0o700);
	const quarantined = join(quarantineRoot, `${digest}-${Date.now()}-${randomUUID()}.quarantine`);
	try {
		await rename(path, quarantined);
		await Promise.all([syncDirectory(dirname(path)), syncDirectory(quarantineRoot)]);
	} catch (error) {
		if (isMissing(error)) return;
		// Fail closed: if quarantine cannot be completed, remove the public entry rather than leave it serviceable.
		await rm(path, { recursive: true, force: true });
		await syncDirectory(dirname(path));
	}
}

async function writePrivateAtomicFile(path: string, contents: string, label: string): Promise<void> {
	const existing = await lstatIfExists(path);
	if (existing?.isSymbolicLink()) throw new Error(`Caddy Artifact Site ${label} must not be a symbolic link`);
	if (existing && !existing.isFile()) throw new Error(`Caddy Artifact Site ${label} must be a regular file`);
	const directory = dirname(path);
	const temporaryPath = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	let temporaryInfo: Stats | undefined;
	let renamed = false;
	try {
		handle = await open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW_FLAG, 0o600);
		const openedInfo = await handle.stat();
		if (!openedInfo.isFile() || openedInfo.nlink !== 1) throw new Error(`Caddy Artifact Site ${label} staging file is unsafe`);
		await handle.writeFile(contents, { encoding: "utf8" });
		await handle.sync();
		await handle.chmod(0o600);
		temporaryInfo = await handle.stat();
		await handle.close();
		handle = undefined;

		const current = await lstatIfExists(path);
		if (current?.isSymbolicLink()) throw new Error(`Caddy Artifact Site ${label} must not be a symbolic link`);
		if (current && !current.isFile()) throw new Error(`Caddy Artifact Site ${label} must be a regular file`);
		await rename(temporaryPath, path);
		renamed = true;
		await syncDirectory(directory);
		const finalInfo = await lstat(path);
		if (!temporaryInfo || !finalInfo.isFile() || !sameInode(finalInfo, temporaryInfo) || (finalInfo.mode & 0o777) !== 0o600) {
			throw new Error(`Caddy Artifact Site ${label} failed atomic integrity verification`);
		}
	} catch (error) {
		if (renamed) await rm(path, { force: true }).catch(() => undefined);
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
		if (!renamed) await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

async function removeStalePidFile(path: string): Promise<void> {
	const info = await lstatIfExists(path);
	if (!info) return;
	if (info.isSymbolicLink() || !info.isFile()) throw new Error("Caddy Artifact Site caddy.pid must be a regular file, not a symbolic link");
	await rm(path, { force: true });
	await syncDirectory(dirname(path));
}

async function assertTrustedArtifactSource(
	options: CaddyArtifactSiteResolvedOptions,
	source: string,
	sourcePathInfo: Stats,
): Promise<void> {
	const workspaceInfo = await lstat(options.workspace);
	if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) {
		throw new Error("Caddy Artifact Site workspace must be a real directory, not a symbolic link");
	}
	const workspace = await realpath(options.workspace);
	if (!options.snapshotRoot) {
		if (!isStrictPathWithin(workspace, source)) throw new Error("Caddy Artifact Site source is outside the trusted workspace");
		return;
	}
	const snapshotRoot = await realpath(await ensurePrivateDirectoryWithin(options.agentDir, options.snapshotRoot, "artifact snapshot root"));
	if (pathsOverlap(workspace, snapshotRoot)) {
		throw new Error("Caddy Artifact Site artifact snapshot root physically overlaps the Agent workspace");
	}
	if (!isStrictPathWithin(snapshotRoot, source)) {
		throw new Error("Caddy Artifact Site source is outside the trusted Profile artifact snapshot root");
	}
	const sourceRelative = relative(snapshotRoot, source);
	const segments = sourceRelative.split(sep).filter(Boolean);
	if (segments.length !== 2 || !/^delivery-[^/\\]+$/u.test(segments[0]!)) {
		throw new Error("Caddy Artifact Site source is not a Dispatcher-owned delivery snapshot");
	}
	const deliveryDirectory = dirname(source);
	const deliveryInfo = await lstat(deliveryDirectory);
	if (deliveryInfo.isSymbolicLink() || !deliveryInfo.isDirectory() || (deliveryInfo.mode & 0o077) !== 0) {
		throw new Error("Caddy Artifact Site delivery snapshot directory is not private");
	}
	if (await realpath(deliveryDirectory) !== join(snapshotRoot, segments[0]!)) {
		throw new Error("Caddy Artifact Site delivery snapshot directory changed during validation");
	}
	if (sourcePathInfo.nlink !== 1 || (sourcePathInfo.mode & 0o222) !== 0) {
		throw new Error("Caddy Artifact Site delivery snapshot source must be immutable and singly linked");
	}
}

async function ensurePrivateDirectoryWithin(agentDir: string, target: string, label: string): Promise<string> {
	if (!isAbsolute(agentDir) || !isAbsolute(target)) throw new Error("Caddy Artifact Site paths must be absolute");
	assertStrictLexicalDescendant(agentDir, target, label);
	const agentInfo = await lstat(agentDir);
	if (agentInfo.isSymbolicLink() || !agentInfo.isDirectory()) throw new Error("Caddy Artifact Site agent directory must be a real directory, not a symbolic link");
	const agentReal = await realpath(agentDir);
	const relativeTarget = relative(agentDir, target);
	let current = agentDir;
	for (const segment of relativeTarget.split(sep).filter(Boolean)) {
		current = join(current, segment);
		let info = await lstatIfExists(current);
		if (!info) {
			try {
				await mkdir(current, { mode: 0o700 });
			} catch (error) {
				if (!isAlreadyExists(error)) throw error;
			}
			info = await lstat(current);
		}
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error(`Caddy Artifact Site ${label} contains a non-directory or symbolic link segment: ${current}`);
		}
		const currentReal = await realpath(current);
		if (!isStrictPathWithin(agentReal, currentReal)) throw new Error(`Caddy Artifact Site ${label} resolves outside the agent directory`);
		await chmod(current, 0o700);
	}
	const targetReal = await realpath(target);
	if (!isStrictPathWithin(agentReal, targetReal)) throw new Error(`Caddy Artifact Site ${label} resolves outside the agent directory`);
	// Keep the caller's stable absolute spelling (for example macOS /var versus /private/var)
	// after proving that its physical target remains under the agent authority root.
	return target;
}

function assertStrictLexicalDescendant(root: string, target: string, label: string): void {
	if (!isStrictPathWithin(root, target)) throw new Error(`Caddy Artifact Site ${label} must stay inside the agent directory`);
}

function isStrictPathWithin(root: string, target: string): boolean {
	const child = relative(root, target);
	return Boolean(child) && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function pathsOverlap(first: string, second: string): boolean {
	return first === second || isStrictPathWithin(first, second) || isStrictPathWithin(second, first);
}

function sameInode(first: { dev: number | bigint; ino: number | bigint }, second: { dev: number | bigint; ino: number | bigint }): boolean {
	return first.dev === second.dev && first.ino === second.ino;
}

async function lstatIfExists(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

async function syncDirectory(path: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, fsConstants.O_RDONLY | DIRECTORY_FLAG);
		await handle.sync();
	} catch (error) {
		if (process.platform !== "win32") throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function renderCaddyfile(listen: string, routePrefix: string, storageRoot: string): string {
	return `{
	admin off
	auto_https off
	persist_config off
}

http://${listen} {
	respond /healthz "ok" 200

	handle_path ${routePrefix}/* {
		root * ${JSON.stringify(storageRoot)}
		header {
			X-Content-Type-Options nosniff
			Referrer-Policy no-referrer
			Cross-Origin-Resource-Policy same-origin
			Cache-Control "public, max-age=31536000, immutable"
		}

		${renderDocumentHeaderRules()}

		file_server
	}

	respond "Not found" 404
}
`;
}

function renderDocumentHeaderRules(): string {
	const groups = new Map<string, { extensions: string[]; policy: DocumentTypePolicy }>();
	for (const [extension, policy] of DOCUMENT_TYPES) {
		const key = `${policy.mediaType}\u0000${policy.disposition}\u0000${policy.contentSecurityPolicy ?? ""}`;
		const group = groups.get(key) ?? { extensions: [], policy };
		group.extensions.push(extension);
		groups.set(key, group);
	}
	return [...groups.values()].map(({ extensions, policy }, index) => [
		`@document_${index} path ${extensions.map((extension) => `*${extension}`).join(" ")}`,
		`header @document_${index} {`,
		`\tContent-Type ${policy.mediaType}`,
		`\tContent-Disposition ${policy.disposition}`,
		...(policy.contentSecurityPolicy ? [`\tContent-Security-Policy ${JSON.stringify(policy.contentSecurityPolicy)}`] : []),
		"}",
	].join("\n\t\t")).join("\n\t\t");
}

export function parseArtifactSiteListen(value: string): { host: string; port: number } {
	const match = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/u.exec(value);
	const port = Number(match?.[2]);
	if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("Caddy Artifact Site listen must be a host:port address with a valid port");
	}
	return { host: match[1]!, port };
}

function healthAuthority(host: string, port: number): string {
	if (host === "0.0.0.0") return `127.0.0.1:${port}`;
	if (host === "[::]") return `[::1]:${port}`;
	return `${host}:${port}`;
}

function processIsLive(child: CaddyProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

function caddyStartFailure(stderr: string, child: CaddyProcess): string {
	const status = child.exitCode !== null ? `exit ${child.exitCode}` : `signal ${child.signalCode ?? "unknown"}`;
	return `Caddy Artifact Site exited before readiness (${status})${stderr ? `: ${stderr}` : ""}`;
}

async function waitForExit(child: CaddyProcess, timeoutMs: number): Promise<boolean> {
	if (!processIsLive(child)) return true;
	return new Promise((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		const onExit = () => {
			if (timer) clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
		timer = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
	});
}

function isAlreadyExists(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST");
}

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

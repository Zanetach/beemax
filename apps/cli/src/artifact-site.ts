import { createHash } from "node:crypto";
import { spawn as spawnChild, type SpawnOptions } from "node:child_process";
import { createReadStream, constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { MediaArtifact, TaskArtifact } from "@beemax/core";

export interface CaddyArtifactSiteOptions {
	workspace: string;
	storageRoot: string;
	runtimeRoot: string;
	publicBaseUrl: string;
	command: string;
	listen: string;
}

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
}

const HTML_CONTENT_SECURITY_POLICY = "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
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
	readonly options: CaddyArtifactSiteOptions;
	private readonly publicBaseUrl: string;
	private readonly routePrefix: string;
	private readonly healthUrl: string;
	private readonly dependencies: CaddyArtifactSiteDependencies;
	private child?: CaddyProcess;
	private ready = false;
	private lifecycleManaged = false;

	constructor(options: CaddyArtifactSiteOptions, dependencies: Partial<CaddyArtifactSiteDependencies> = {}) {
		this.options = options;
		const publicBaseUrl = validateArtifactSitePublicBaseUrl(options.publicBaseUrl);
		const url = new URL(publicBaseUrl);
		const routePrefix = url.pathname.replace(/\/+$/u, "");
		if (![options.workspace, options.storageRoot, options.runtimeRoot].every(isAbsolute)) {
			throw new Error("Caddy Artifact Site paths must be absolute");
		}
		if (!options.command.trim() || /[\u0000-\u001f\u007f]/u.test(options.command)) throw new Error("Caddy Artifact Site command is invalid");
		const listen = parseArtifactSiteListen(options.listen);
		this.publicBaseUrl = publicBaseUrl;
		this.routePrefix = routePrefix;
		this.healthUrl = `http://${healthAuthority(listen.host, listen.port)}/healthz`;
		this.dependencies = {
			spawn: dependencies.spawn ?? ((command, args, spawnOptions) => spawnChild(command, args, spawnOptions) as CaddyProcess),
			fetch: dependencies.fetch ?? (async (healthUrl) => fetch(healthUrl, { redirect: "error", signal: AbortSignal.timeout(500) })),
			delay: dependencies.delay ?? (async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
		};
	}

	get isRunning(): boolean {
		return this.ready && this.child !== undefined && processIsLive(this.child);
	}

	async start(): Promise<void> {
		this.lifecycleManaged = true;
		if (this.isRunning) return;
		if (this.child && processIsLive(this.child)) throw new Error("Caddy Artifact Site is already starting");
		await mkdir(this.options.storageRoot, { recursive: true, mode: 0o700 });
		await mkdir(this.options.runtimeRoot, { recursive: true, mode: 0o700 });
		await Promise.all([
			assertPrivateDirectory(this.options.storageRoot, "publication root"),
			assertPrivateDirectory(this.options.runtimeRoot, "runtime root"),
		]);
		const dataRoot = join(this.options.runtimeRoot, "data");
		const configRoot = join(this.options.runtimeRoot, "config");
		await Promise.all([
			mkdir(dataRoot, { recursive: true, mode: 0o700 }),
			mkdir(configRoot, { recursive: true, mode: 0o700 }),
		]);
		const configPath = join(this.options.runtimeRoot, "Caddyfile");
		const pidPath = join(this.options.runtimeRoot, "caddy.pid");
		await writeFile(configPath, renderCaddyfile(this.options.listen, this.routePrefix, this.options.storageRoot), { mode: 0o600 });
		await chmod(configPath, 0o600);

		let stderr = "";
		let spawnError: Error | undefined;
		const child = this.dependencies.spawn(this.options.command, [
			"run",
			"--config", configPath,
			"--adapter", "caddyfile",
			"--pidfile", pidPath,
		], {
			cwd: this.options.runtimeRoot,
			detached: false,
			env: { ...process.env, XDG_DATA_HOME: dataRoot, XDG_CONFIG_HOME: configRoot },
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
		const name = media.name ?? basename(media.path);
		if (!name || name !== basename(name) || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("Caddy Artifact Site received an invalid document name");
		if (name !== basename(media.path)) throw new Error("Caddy Artifact Site document name must match the integrity-checked source name");
		const documentType = DOCUMENT_TYPES.get(extname(name).toLowerCase());
		if (!documentType) throw new Error(`Caddy Artifact Site unsupported document type: ${name}`);
		if (manifest.mediaType !== documentType.mediaType || media.mimeType !== documentType.mediaType) {
			throw new Error(`Caddy Artifact Site media type does not match ${name}`);
		}

		const workspace = await realpath(this.options.workspace);
		const source = await realpath(media.path);
		const sourceRelative = relative(workspace, source);
		if (!sourceRelative || sourceRelative.startsWith(`..${sep}`) || sourceRelative === ".." || isAbsolute(sourceRelative)) {
			throw new Error("Caddy Artifact Site source is outside the trusted workspace");
		}
		const sourceInfo = await stat(source);
		if (!sourceInfo.isFile() || sourceInfo.size !== manifest.byteLength) throw new Error("Caddy Artifact Site source failed Artifact integrity checks");
		if (await sha256File(source) !== manifest.sha256) throw new Error("Caddy Artifact Site source failed Artifact integrity checks");

		await mkdir(this.options.storageRoot, { recursive: true, mode: 0o700 });
		await assertPrivateDirectory(this.options.storageRoot, "publication root");
		const directory = join(this.options.storageRoot, manifest.sha256);
		const destination = join(directory, name);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await assertPrivateDirectory(directory, "publication directory");
		try {
			await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
			await chmod(destination, 0o444);
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
		}
		const publishedInfo = await lstat(destination);
		if (!publishedInfo.isFile()) throw new Error("Caddy Artifact Site published copy is not a regular file");
		if (publishedInfo.size !== manifest.byteLength || await sha256File(destination) !== manifest.sha256) {
			throw new Error("Caddy Artifact Site published copy failed Artifact integrity checks");
		}

		return {
			url: `${this.publicBaseUrl}/${manifest.sha256}/${encodeURIComponent(name)}`,
			name,
			mediaType: documentType.mediaType,
			disposition: documentType.disposition,
		};
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

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isDirectory()) throw new Error(`Caddy Artifact Site ${label} must be a real directory, not a symbolic link`);
	await chmod(path, 0o700);
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

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

function isAlreadyExists(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST");
}

/** MCP capability bridge: configured external tools become native Pi tools. */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, defineTool, isGloballyReachableIp, redactCredentialMaterial, withToolPolicy, type GovernedToolDefinition, type PublicHttpDependencies, type ToolPolicy } from "@beemax/core";
import { Type, type TSchema } from "typebox";
import { createMcpHttpFetch } from "./http-fetch.ts";

export type McpServerConfig = {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	required?: boolean;
	/** Operator attestation that this exact server's read annotations and read APIs are trustworthy. */
	trustReadOnlyOperations?: boolean;
} | {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	required?: boolean;
	/** Operator attestation that this exact server's read annotations and read APIs are trustworthy. */
	trustReadOnlyOperations?: boolean;
};

export interface McpConfig {
	servers: Record<string, McpServerConfig>;
}

export interface McpConfigLoadOptions {
	/** When set, the manifest must remain lexically and physically inside this Profile Home. */
	profileHome?: string;
}

const MCP_CONFIG_KEYS = new Set(["servers"]);
const MCP_STDIO_SERVER_KEYS = new Set(["type", "command", "args", "env", "cwd", "required", "trustReadOnlyOperations"]);
const MCP_HTTP_SERVER_KEYS = new Set(["type", "url", "headers", "required", "trustReadOnlyOperations"]);
const MAX_MCP_SERVERS = 32;
const MAX_MCP_DESCRIPTOR_ENTRIES = 64;
const MAX_MCP_STRING_BYTES = 4_096;
const MAX_MCP_KEY_BYTES = 128;
const MAX_MCP_CONFIG_BYTES = 256 * 1_024;

/** Strictly validate an untrusted MCP manifest without expanding Profile environment references. */
export function validateMcpConfig(value: unknown): McpConfig {
	const config = requirePlainRecord(value, "MCP config");
	assertOnlyKeys(config, MCP_CONFIG_KEYS, "MCP config");
	const servers = requirePlainRecord(config.servers, "MCP config servers");
	assertEntryCount(servers, MAX_MCP_SERVERS, "MCP config servers");
	const validatedServers: Record<string, McpServerConfig> = {};
	for (const [name, candidate] of Object.entries(servers)) {
		validateServerName(name);
		const server = requirePlainRecord(candidate, `MCP config servers.${name}`);
		if (server.type !== "stdio" && server.type !== "http") {
			throw new Error(`MCP config servers.${name}.type must be stdio or http`);
		}
		assertOnlyKeys(server, server.type === "stdio" ? MCP_STDIO_SERVER_KEYS : MCP_HTTP_SERVER_KEYS, `MCP config servers.${name}`);
		const path = `MCP config servers.${name}`;
		const required = optionalBoolean(server, "required", path);
		const trustReadOnlyOperations = optionalBoolean(server, "trustReadOnlyOperations", path);
		if (server.type === "stdio") {
			const command = requireString(server.command, `${path}.command`, false);
			assertFixedAbsolutePath(command, `${path}.command`);
			const cwd = Object.hasOwn(server, "cwd") ? requireString(server.cwd, `${path}.cwd`, false) : undefined;
			if (cwd !== undefined) assertFixedAbsolutePath(cwd, `${path}.cwd`);
			validatedServers[name] = {
				type: "stdio",
				command,
				...(Object.hasOwn(server, "args") ? { args: requireStringArray(server.args, `${path}.args`) } : {}),
				...(Object.hasOwn(server, "env") ? { env: requireStringRecord(server.env, `${path}.env`, "environment") } : {}),
				...(cwd === undefined ? {} : { cwd }),
				...(required === undefined ? {} : { required }),
				...(trustReadOnlyOperations === undefined ? {} : { trustReadOnlyOperations }),
			};
		} else {
			const url = requireString(server.url, `${path}.url`, false);
			validateUnexpandedHttpUrl(url, `${path}.url`);
			validatedServers[name] = {
				type: "http",
				url,
				...(Object.hasOwn(server, "headers") ? { headers: requireStringRecord(server.headers, `${path}.headers`, "headers") } : {}),
				...(required === undefined ? {} : { required }),
				...(trustReadOnlyOperations === undefined ? {} : { trustReadOnlyOperations }),
			};
		}
	}
	return { servers: validatedServers };
}

export interface McpServerStatus {
	name: string;
	connected: boolean;
	tools: string[];
	resources: number;
	prompts: number;
	error?: string;
}

interface Connection {
	client: Client;
	tools: GovernedToolDefinition[];
	resources: number;
	prompts: number;
}

const STDIO_SAFE_ENVIRONMENT_KEYS = Object.freeze([...new Set([
	...DEFAULT_INHERITED_ENV_VARS,
	"PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TMP", "TEMP",
	"USERPROFILE", "APPDATA", "LOCALAPPDATA",
	"LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
	"XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
])]);

export class McpManager {
	private readonly connections = new Map<string, Connection>();
	private statuses: McpServerStatus[] = [];
	private readonly initializationTimeoutMs: number;
	private readonly closeTimeoutMs: number;
	private readonly environment: Readonly<Record<string, string>>;
	private readonly sensitiveEnvironmentValues: readonly string[];
	private readonly publicHttp: PublicHttpDependencies | undefined;

	constructor(options: { environment: Readonly<Record<string, string | undefined>>; initializationTimeoutMs?: number; closeTimeoutMs?: number; publicHttp?: PublicHttpDependencies }) {
		if (!options?.environment || typeof options.environment !== "object" || Array.isArray(options.environment)) {
			throw new Error("McpManager requires an explicit Profile environment snapshot");
		}
		this.environment = Object.freeze(Object.fromEntries(
			Object.entries(options.environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		));
		this.sensitiveEnvironmentValues = Object.freeze(Object.entries(this.environment)
			.filter(([key, value]) => /(?:PASSWORD|PASSCODE|SECRET|API_?KEY|ACCESS_?TOKEN|REFRESH_?TOKEN|SESSION_?TOKEN|COOKIE)/iu.test(key) && value.length >= 4)
			.map(([, value]) => value)
			.sort((left, right) => right.length - left.length));
		this.initializationTimeoutMs = Math.max(100, options.initializationTimeoutMs ?? 15_000);
		this.closeTimeoutMs = Math.max(100, options.closeTimeoutMs ?? 5_000);
		this.publicHttp = options.publicHttp;
	}

	async connectAll(config: McpConfig): Promise<McpServerStatus[]> {
		const validatedConfig = validateMcpConfig(config);
		await this.close();
		const attempts = await Promise.all(Object.entries(validatedConfig.servers).map(async ([name, server]) => {
			validateServerName(name);
			try {
				const connection = await this.connectOne(name, server);
				return { server, connection, status: { name, connected: true, tools: connection.tools.map((tool) => tool.name), resources: connection.resources, prompts: connection.prompts } satisfies McpServerStatus };
			} catch (error) {
				const message = sanitizeExternalText(error instanceof Error ? error.message : String(error), this.sensitiveEnvironmentValues);
				return { server, status: { name, connected: false, tools: [], resources: 0, prompts: 0, error: message } satisfies McpServerStatus };
			}
		}));
		const requiredFailure = attempts.find((attempt) => attempt.server.required && !attempt.status.connected);
		if (requiredFailure) {
			await Promise.all(attempts.map(async (attempt) => {
				if ("connection" in attempt && attempt.connection) await attempt.connection.client.close().catch(() => undefined);
			}));
			throw new Error(`Required MCP server ${requiredFailure.status.name} failed: ${requiredFailure.status.error}`);
		}
		const ownerByTool = new Map<string, string>();
		for (const attempt of attempts) {
			if (!("connection" in attempt) || !attempt.connection) continue;
			for (const tool of attempt.connection.tools) {
				const owner = ownerByTool.get(tool.name);
				if (owner) {
					await Promise.all(attempts.map((item) => "connection" in item && item.connection ? boundedClose(item.connection.client, this.closeTimeoutMs) : undefined));
					throw new Error(`MCP tool name collision across servers ${owner} and ${attempt.status.name}: ${tool.name}`);
				}
				ownerByTool.set(tool.name, attempt.status.name);
			}
		}
		for (const attempt of attempts) if ("connection" in attempt && attempt.connection) this.connections.set(attempt.status.name, attempt.connection);
		this.statuses = attempts.map((attempt) => attempt.status);
		return this.getStatus();
	}

	getTools(): GovernedToolDefinition[] {
		return [...this.connections.values()].flatMap((connection) => connection.tools);
	}

	getStatus(): McpServerStatus[] {
		return this.statuses.map((status) => ({ ...status, tools: [...status.tools] }));
	}

	async close(): Promise<void> {
		for (const connection of this.connections.values()) {
			await boundedClose(connection.client, this.closeTimeoutMs);
		}
		this.connections.clear();
		this.statuses = [];
	}

	private async connectOne(name: string, server: McpServerConfig): Promise<Connection> {
		const client = new Client({ name: `beemax-${name}`, version: "0.1.0" }, { capabilities: {} });
		const expand = (value: string, path = `MCP config servers.${name}`) => expandedMcpString(expandEnv(value, this.environment), path);
		const command = server.type === "stdio" ? server.command : undefined;
		if (command !== undefined) assertStableHostExecutable(command);
		const cwd = server.type === "stdio" ? server.cwd : undefined;
		if (cwd !== undefined) assertStableHostDirectory(cwd);
		const url = server.type === "http" ? expand(server.url, `MCP config servers.${name}.url`) : undefined;
		if (url !== undefined) validateExpandedHttpUrl(url, `MCP config servers.${name}.url`);
		const endpoint = url === undefined ? undefined : new URL(url);
		const transport = server.type === "stdio"
			? new StdioClientTransport({
				command: command!,
				args: server.args?.map((value, index) => expand(value, `MCP config servers.${name}.args[${index}]`)),
				env: isolatedStdioEnvironment(this.environment, mapValues(server.env ?? {}, (value, key) => expand(value, `MCP config servers.${name}.env.${key}`))),
				cwd,
				stderr: "pipe",
			})
			: new StreamableHTTPClientTransport(endpoint!, {
				requestInit: { headers: mapValues(server.headers ?? {}, (value, key) => expand(value, `MCP config servers.${name}.headers.${key}`)) },
				fetch: createMcpHttpFetch({ mode: endpoint!.protocol === "https:" ? "public-https" : "loopback-http", publicHttp: this.publicHttp }),
			});
		if (transport instanceof StdioClientTransport) (transport.stderr as { resume?: () => unknown } | null)?.resume?.();
		try {
			await withTimeout(client.connect(transport), this.initializationTimeoutMs, `${name} connection`);
			const listed = await withTimeout(client.listTools(), this.initializationTimeoutMs, `${name} tool discovery`);
			const capabilities = client.getServerCapabilities();
			const resources = capabilities?.resources
				? await withTimeout(client.listResources(), this.initializationTimeoutMs, `${name} resource discovery`).then((result) => result.resources.length).catch(() => 0)
				: 0;
			const prompts = capabilities?.prompts
				? await withTimeout(client.listPrompts(), this.initializationTimeoutMs, `${name} prompt discovery`).then((result) => result.prompts.length).catch(() => 0)
				: 0;
			const names = new Set<string>();
			const tools: GovernedToolDefinition[] = listed.tools.map((tool) => {
				const toolName = mcpToolName(name, tool.name);
				if (names.has(toolName)) throw new Error(`MCP tool name collision after normalization: ${tool.name}`);
				names.add(toolName);
				const policy: ToolPolicy = server.trustReadOnlyOperations === true && tool.annotations?.readOnlyHint === true
					? { ...READ_ONLY_TOOL_POLICY, timeoutMs: 130_000, impact: `Reads data through MCP server ${name}` }
					: {
						...MUTATING_TOOL_POLICY,
						risk: tool.annotations?.destructiveHint === true ? "high" : "medium",
						reversible: tool.annotations?.destructiveHint === true ? false : "unknown",
						timeoutMs: 130_000,
						impact: `May change state through external MCP server ${name}`,
					};
				return readyMcpTool(withToolPolicy(defineTool({
					name: toolName,
					label: tool.title ?? `${name}: ${tool.name}`,
					description: `[MCP ${name}/${tool.name}] ${tool.description ?? "External MCP tool"}`,
					aliases: [tool.name, `${name} ${tool.name}`, `${name}/${tool.name}`],
					parameters: tool.inputSchema as TSchema,
					execute: async (_id, params, signal) => {
						const result = await this.externalCall(`${name}/${tool.name}`, () => client.callTool(
							{ name: tool.name, arguments: params as Record<string, unknown> }, undefined, { signal, timeout: 120_000 },
						));
						const content = Array.isArray(result.content) ? result.content : [];
						const text = content.map((item: unknown) => {
							if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
								return this.sanitizeExternalText(String((item as { text?: unknown }).text ?? ""));
							}
							return this.sanitizeExternalText(JSON.stringify(item));
						}).join("\n");
						return {
							content: [{ type: "text" as const, text: truncate(text, 50_000) }],
							details: { server: name, tool: tool.name, structuredContent: boundedDetails(result.structuredContent, 50_000, (value) => this.sanitizeExternalText(value)) },
							isError: result.isError === true,
						};
					},
				}), policy));
			});
			const addUtility = (tool: GovernedToolDefinition) => {
				if (names.has(tool.name)) throw new Error(`MCP utility tool name collision: ${tool.name}`);
				names.add(tool.name);
				tools.push(readyMcpTool(tool));
			};
			if (capabilities?.resources) {
				addUtility(withToolPolicy(defineTool({
					name: mcpToolName(name, "resources"), label: `${name}: resources`, description: `[MCP ${name}] List available resources.`,
					parameters: Type.Object({}),
					execute: async (_id, _params, signal) => {
						const result = await this.externalCall(`${name}/resources`, () => client.listResources(undefined, { signal, timeout: 120_000 }));
						return { content: [{ type: "text" as const, text: truncate(this.sanitizeExternalText(JSON.stringify(result.resources)), 50_000) }], details: { server: name, resources: boundedDetails(result.resources, 50_000, (value) => this.sanitizeExternalText(value)) } };
					},
				}), mcpReadPolicy(name, server.trustReadOnlyOperations, `Lists resources exposed by MCP server ${name}`)));
				addUtility(withToolPolicy(defineTool({
					name: mcpToolName(name, "resource_read"), label: `${name}: read resource`, description: `[MCP ${name}] Read one resource by URI.`,
					parameters: Type.Object({ uri: Type.String({ minLength: 1, maxLength: 4096 }) }),
					execute: async (_id, params, signal) => {
						const result = await this.externalCall(`${name}/resource_read`, () => client.readResource({ uri: params.uri }, { signal, timeout: 120_000 }));
						return { content: [{ type: "text" as const, text: truncate(this.sanitizeExternalText(JSON.stringify(result.contents)), 50_000) }], details: { server: name, uri: params.uri, contents: boundedDetails(result.contents, 50_000, (value) => this.sanitizeExternalText(value)) } };
					},
				}), mcpReadPolicy(name, server.trustReadOnlyOperations, `Reads one resource exposed by MCP server ${name}`)));
			}
			if (capabilities?.prompts) {
				addUtility(withToolPolicy(defineTool({
					name: mcpToolName(name, "prompts"), label: `${name}: prompts`, description: `[MCP ${name}] List available prompt templates.`,
					parameters: Type.Object({}),
					execute: async (_id, _params, signal) => {
						const result = await this.externalCall(`${name}/prompts`, () => client.listPrompts(undefined, { signal, timeout: 120_000 }));
						return { content: [{ type: "text" as const, text: truncate(this.sanitizeExternalText(JSON.stringify(result.prompts)), 50_000) }], details: { server: name, prompts: boundedDetails(result.prompts, 50_000, (value) => this.sanitizeExternalText(value)) } };
					},
				}), mcpReadPolicy(name, server.trustReadOnlyOperations, `Lists prompt templates exposed by MCP server ${name}`)));
				addUtility(withToolPolicy(defineTool({
					name: mcpToolName(name, "prompt_get"), label: `${name}: get prompt`, description: `[MCP ${name}] Get one prompt template with optional string arguments.`,
					parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 256 }), arguments: Type.Optional(Type.Record(Type.String(), Type.String())) }),
					execute: async (_id, params, signal) => {
						const result = await this.externalCall(`${name}/prompt_get`, () => client.getPrompt({ name: params.name, arguments: params.arguments }, { signal, timeout: 120_000 }));
						return { content: [{ type: "text" as const, text: truncate(this.sanitizeExternalText(JSON.stringify(result.messages)), 50_000) }], details: { server: name, prompt: params.name, messages: boundedDetails(result.messages, 50_000, (value) => this.sanitizeExternalText(value)) } };
					},
				}), mcpReadPolicy(name, server.trustReadOnlyOperations, `Reads one prompt template exposed by MCP server ${name}`)));
			}
			return { client, tools, resources, prompts };
		} catch (error) {
			terminateTransport(transport);
			await boundedClose(client, this.closeTimeoutMs);
			throw new Error(this.sanitizeExternalText(error instanceof Error ? error.message : String(error)));
		}
	}

	private sanitizeExternalText(value: string): string {
		return sanitizeExternalText(value, this.sensitiveEnvironmentValues);
	}

	private async externalCall<T>(label: string, operation: () => Promise<T>): Promise<T> {
		try { return await operation(); }
		catch (error) { throw new Error(`MCP ${label} failed: ${this.sanitizeExternalText(error instanceof Error ? error.message : String(error))}`); }
	}
}

export function loadMcpConfig(path: string, options: McpConfigLoadOptions = {}): McpConfig {
	if (!path) return { servers: {} };
	try {
		const text = options.profileHome ? readProfileMcpConfig(path, options.profileHome) : readBoundedMcpConfig(path);
		return validateMcpConfig(JSON.parse(text));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
		throw new Error(`Could not load MCP config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function readProfileMcpConfig(path: string, profileHome: string): string {
	const boundary = resolve(profileHome);
	const candidate = resolve(path);
	assertProfilePathInside(boundary, candidate, "lexically");
	const initialBoundary = lstatSync(boundary);
	if (initialBoundary.isSymbolicLink() || !initialBoundary.isDirectory()) throw new Error(`Profile Home must be a real directory: ${profileHome}`);
	const realBoundary = realpathSync(boundary);
	const realCandidate = realpathSync(candidate);
	assertProfilePathInside(realBoundary, realCandidate, "physically");
	const initialCandidate = lstatSync(candidate);
	if (initialCandidate.isSymbolicLink() || !initialCandidate.isFile()) throw new Error(`MCP config path must be a regular Profile-local file: ${path}`);
	const descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || !sameFile(opened, initialCandidate)) throw new Error(`MCP config changed while opening: ${path}`);
		const text = readBoundedDescriptor(descriptor, path);
		const finalBoundary = lstatSync(boundary);
		const finalCandidate = lstatSync(candidate);
		const finalBoundaryPath = realpathSync(boundary);
		const finalCandidatePath = realpathSync(candidate);
		const finalOpened = fstatSync(descriptor);
		if (finalBoundary.isSymbolicLink() || !finalBoundary.isDirectory() || !sameFile(finalBoundary, initialBoundary) || finalBoundaryPath !== realBoundary) {
			throw new Error(`Profile Home changed while reading MCP config: ${profileHome}`);
		}
		if (finalCandidate.isSymbolicLink() || !finalCandidate.isFile() || !sameFile(finalCandidate, initialCandidate) || !sameFile(finalOpened, opened) || finalCandidatePath !== realCandidate) {
			throw new Error(`MCP config changed while reading: ${path}`);
		}
		return text;
	} finally {
		closeSync(descriptor);
	}
}

function readBoundedMcpConfig(path: string): string {
	const descriptor = openSync(path, constants.O_RDONLY);
	try { return readBoundedDescriptor(descriptor, path); }
	finally { closeSync(descriptor); }
}

function readBoundedDescriptor(descriptor: number, path: string): string {
	const opened = fstatSync(descriptor);
	if (!opened.isFile()) throw new Error(`MCP config path must be a regular file: ${path}`);
	if (opened.size > MAX_MCP_CONFIG_BYTES) throw new Error(`MCP config must be at most ${MAX_MCP_CONFIG_BYTES} bytes`);
	const buffer = Buffer.allocUnsafe(MAX_MCP_CONFIG_BYTES + 1);
	let offset = 0;
	while (offset < buffer.length) {
		const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
		if (count === 0) break;
		offset += count;
	}
	if (offset > MAX_MCP_CONFIG_BYTES) throw new Error(`MCP config must be at most ${MAX_MCP_CONFIG_BYTES} bytes`);
	return buffer.subarray(0, offset).toString("utf8");
}

function assertProfilePathInside(boundary: string, candidate: string, relation: "lexically" | "physically"): void {
	const relationPath = relative(boundary, candidate);
	if (!relationPath || isAbsolute(relationPath) || relationPath === ".." || relationPath.startsWith(`..${sep}`)) {
		throw new Error(`MCP config path must stay ${relation} inside its Profile Home: ${candidate}`);
	}
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function mcpToolName(server: string, tool: string): string {
	return `mcp_${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

function mcpReadPolicy(server: string, trusted: boolean | undefined, impact: string): ToolPolicy {
	return trusted === true
		? { ...READ_ONLY_TOOL_POLICY, timeoutMs: 130_000, impact }
		: { ...MUTATING_TOOL_POLICY, risk: "medium", reversible: "unknown", timeoutMs: 130_000, impact: `Calls an external MCP server without a local read-only attestation (${server})` };
}

function readyMcpTool<T extends GovernedToolDefinition>(tool: T): T {
	return Object.assign(tool, { beemaxToolSpec: { kind: "mcp" as const, configured: true, health: "ready" as const } });
}

function validateServerName(name: string): void {
	if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
	if (/^(?:__proto__|prototype|constructor)$/iu.test(name)) throw new Error(`Invalid reserved MCP server name: ${name}`);
}

function requirePlainRecord(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain object`);
	return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${path} contains unknown key ${key}`);
	}
}

function requireString(value: unknown, path: string, allowEmpty: boolean): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new Error(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
	}
	if (/\u0000/u.test(value)) throw new Error(`${path} must not contain control characters`);
	if (Buffer.byteLength(value, "utf8") > MAX_MCP_STRING_BYTES) throw new Error(`${path} must be at most ${MAX_MCP_STRING_BYTES} bytes`);
	return value;
}

function requireStringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	if (value.length > MAX_MCP_DESCRIPTOR_ENTRIES) throw new Error(`${path} must contain at most ${MAX_MCP_DESCRIPTOR_ENTRIES} entries`);
	return value.map((entry, index) => requireString(entry, `${path}[${index}]`, true));
}

function requireStringRecord(value: unknown, path: string, kind: "environment" | "headers"): Record<string, string> {
	const record = requirePlainRecord(value, path);
	assertEntryCount(record, MAX_MCP_DESCRIPTOR_ENTRIES, path);
	return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
		if (Buffer.byteLength(key, "utf8") > MAX_MCP_KEY_BYTES) throw new Error(`${path} keys must be at most ${MAX_MCP_KEY_BYTES} bytes`);
		if (kind === "environment" && !/^[A-Z_][A-Z0-9_]*$/iu.test(key)) throw new Error(`${path} contains invalid environment key ${key}`);
		if (kind === "headers" && !/^[!#$%&'*+\-.^_`|~0-9A-Z]+$/iu.test(key)) throw new Error(`${path} contains invalid HTTP header name ${key}`);
		const entryPath = `${path}.${key}`;
		const text = requireString(entry, entryPath, true);
		if (kind === "headers" && /[\u0000-\u001f\u007f]/u.test(text)) throw new Error(`${entryPath} must not contain control characters`);
		if (credentialLikeKey(key, kind) || credentialLikeLiteral(text)) assertCredentialReference(text, entryPath, kind, key);
		return [key, text];
	}));
}

function optionalBoolean(record: Record<string, unknown>, key: string, path: string): boolean | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	if (typeof record[key] !== "boolean") throw new Error(`${path}.${key} must be a boolean`);
	return record[key];
}

function assertEntryCount(record: Record<string, unknown>, max: number, path: string): void {
	if (Object.keys(record).length > max) throw new Error(`${path} must contain at most ${max} entries`);
}

function credentialLikeKey(key: string, kind: "environment" | "headers"): boolean {
	const normalized = key.replace(/-/g, "_");
	if (/^(?:AUTHORIZATION|PROXY_AUTHORIZATION|COOKIE|SET_COOKIE|X_API_KEY|API_KEY)$/iu.test(normalized)) return true;
	return /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|REFRESH_?TOKEN|SESSION_?TOKEN|TOKEN|SECRET|PASSWORD|PASSCODE|COOKIE|CREDENTIAL|PRIVATE_?KEY)(?:$|_)/iu.test(normalized);
}

function credentialLikeLiteral(value: string): boolean {
	return /^(?:Bearer\s+\S+|Basic\s+\S+|sk-[A-Z0-9_-]{8,}|gh[pousr]_[A-Z0-9_-]{8,}|xox[baprs]-[A-Z0-9-]{8,}|AKIA[A-Z0-9]{12,}|eyJ[A-Z0-9_-]{8,}\.)/iu.test(value.trim());
}

function assertCredentialReference(value: string, path: string, kind: "environment" | "headers", key: string): void {
	const referencePattern = /\$\{[A-Z_][A-Z0-9_]*\}/giu;
	const references = value.match(referencePattern);
	if (!references?.length) throw new Error(`${path} must use a \${ENV_REF} Profile environment reference`);
	const remainder = value.replace(referencePattern, "");
	const normalizedKey = key.replace(/-/g, "_");
	const allowedRemainder = kind === "headers" && /^(?:AUTHORIZATION|PROXY_AUTHORIZATION)$/iu.test(normalizedKey)
		? /^(?:(?:Bearer|Basic|Token|ApiKey)\s+)?[\s:]*$/iu
		: /^\s*$/u;
	if (!allowedRemainder.test(remainder)) throw new Error(`${path} must use a \${ENV_REF} Profile environment reference without literal credential material`);
}

function hasEnvironmentReference(value: string): boolean {
	return /\$\{[A-Z_][A-Z0-9_]*\}/iu.test(value);
}

function assertFixedAbsolutePath(value: string, path: string): void {
	assertNoPathControlCharacters(value, path);
	if (/\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*/iu.test(value)) {
		throw new Error(`${path} must be a fixed absolute path and must not contain Profile environment references`);
	}
	if (!isAbsolute(value)) throw new Error(`${path} must be a fixed absolute path`);
}

function assertNoPathControlCharacters(value: string, path: string): void {
	if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${path} must not contain control characters`);
}

function assertStableHostExecutable(command: string): void {
	try {
		const normalized = resolve(command);
		const initial = lstatSync(normalized);
		if (initial.isSymbolicLink() || !initial.isFile() || (process.platform !== "win32" && (initial.mode & 0o111) === 0)) throw new Error("invalid executable");
		if (realpathSync(normalized) !== normalized) throw new Error("indirect executable path");
		const descriptor = openSync(normalized, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const opened = fstatSync(descriptor);
			const final = lstatSync(normalized);
			if (!opened.isFile() || !sameFile(initial, opened) || !sameFile(opened, final) || final.isSymbolicLink() || realpathSync(normalized) !== normalized) {
				throw new Error("executable changed during validation");
			}
		} finally {
			closeSync(descriptor);
		}
	} catch {
		throw new Error("MCP stdio command must remain a real non-symlink executable at its fixed host path");
	}
}

function assertStableHostDirectory(cwd: string): void {
	try {
		const normalized = resolve(cwd);
		const initial = lstatSync(normalized);
		if (initial.isSymbolicLink() || !initial.isDirectory()) throw new Error("invalid cwd");
		const final = lstatSync(normalized);
		if (!sameFile(initial, final) || final.isSymbolicLink() || !final.isDirectory()) throw new Error("cwd changed during validation");
	} catch {
		throw new Error("MCP stdio cwd must remain a real non-symlink directory at its fixed host path");
	}
}

function validateUnexpandedHttpUrl(value: string, path: string): void {
	if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${path} must not contain control characters`);
	if (!/^https?:\/\//iu.test(value)) throw new Error(`${path} must use HTTPS or loopback HTTP`);
	const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/u, 1)[0] ?? "";
	if (authority.includes("@")) throw new Error(`${path} must not embed credentials`);
	if (!hasEnvironmentReference(value)) validateExpandedHttpUrl(value, path);
}

function validateExpandedHttpUrl(value: string, path: string): void {
	let parsed: URL;
	try { parsed = new URL(value); }
	catch { throw new Error(`${path} must be a valid absolute HTTP URL`); }
	if (parsed.username || parsed.password) throw new Error(`${path} must not embed credentials`);
	if (parsed.protocol === "https:") {
		const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
		if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal") {
			throw new Error(`${path} must not target a local or metadata host over public HTTPS`);
		}
		if (isIP(hostname) && !isGloballyReachableIp(hostname)) throw new Error(`${path} must not target a non-public HTTPS address`);
		return;
	}
	if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) throw new Error(`${path} must use HTTPS or loopback HTTP`);
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
	if (normalized === "localhost" || normalized === "::1") return true;
	const octets = normalized.split(".");
	return octets.length === 4
		&& octets[0] === "127"
		&& octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) >= 0 && Number(octet) <= 255);
}

function expandedMcpString(value: string, path: string): string {
	if (Buffer.byteLength(value, "utf8") > MAX_MCP_STRING_BYTES) throw new Error(`${path} must be at most ${MAX_MCP_STRING_BYTES} bytes after Profile environment expansion`);
	return value;
}

function expandEnv(value: string, environment: Readonly<Record<string, string>>): string {
	return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/gi, (_match, braced, plain) => {
		const key = braced ?? plain;
		const resolved = environment[key];
		if (resolved === undefined) throw new Error(`Missing environment variable ${key} used by MCP config`);
		return resolved;
	});
}

function isolatedStdioEnvironment(environment: Readonly<Record<string, string>>, overrides: Readonly<Record<string, string>>): Record<string, string> {
	// The upstream SDK always merges its ambient default environment. Explicitly
	// shadow every inherited key so an omitted Profile value cannot fall through
	// to the BeeMax host process.
	const inheritedShields = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((key) => [key, environment[key] ?? ""]));
	const safeCore = Object.fromEntries(STDIO_SAFE_ENVIRONMENT_KEYS.flatMap((key) => {
		const value = environment[key];
		return value === undefined ? [] : [[key, value]];
	}));
	return { ...inheritedShields, ...safeCore, ...overrides };
}

function mapValues(input: Record<string, string>, fn: (value: string, key: string) => string): Record<string, string> {
	return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, fn(value, key)]));
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function boundedDetails(value: unknown, maxBytes = 50_000, sanitize: (value: string) => string = (value) => value): unknown {
	let remaining = maxBytes;
	const seen = new WeakSet<object>();
	const visit = (candidate: unknown, depth: number): unknown => {
		if (remaining <= 0) return "[truncated]";
		if (typeof candidate === "string") { const safe = sanitize(candidate); const text = safe.slice(0, Math.max(0, Math.floor(remaining / 4))); remaining -= Buffer.byteLength(text); return text.length < safe.length ? `${text}[truncated]` : text; }
		if (candidate === null || typeof candidate === "number" || typeof candidate === "boolean") { remaining -= 16; return candidate; }
		if (candidate === undefined) return undefined;
		if (typeof candidate !== "object" || depth >= 6) { remaining -= 16; return `[${depth >= 6 ? "max depth" : typeof candidate}]`; }
		if (seen.has(candidate)) return "[circular]"; seen.add(candidate);
		if (Array.isArray(candidate)) return candidate.slice(0, 100).map((item) => visit(item, depth + 1)).concat(candidate.length > 100 ? ["[truncated items]"] : []);
		const result: Record<string, unknown> = {};
		const entries = Object.entries(candidate as Record<string, unknown>);
		for (const [key, item] of entries.slice(0, 100)) {
			const boundedKey = key.slice(0, Math.max(0, Math.min(1_024, Math.floor(remaining / 4))));
			remaining -= Buffer.byteLength(boundedKey); if (!boundedKey || remaining <= 0) break;
			result[boundedKey] = visit(item, depth + 1); if (remaining <= 0) break;
		}
		if (entries.length > 100 || remaining <= 0) result.__truncated = true;
		return result;
	};
	return visit(value, 0);
}

function sanitizeExternalText(value: string, sensitiveValues: readonly string[]): string {
	let result = value;
	for (const sensitive of sensitiveValues) result = result.split(sensitive).join("[credential details redacted]");
	return redactCredentialMaterial(result).slice(0, 2_000);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, description: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(`MCP ${description} timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function boundedClose(client: Pick<Client, "close">, timeoutMs: number): Promise<void> {
	await withTimeout(Promise.resolve(client.close()), timeoutMs, "client close").catch(() => undefined);
}

function terminateTransport(transport: StdioClientTransport | StreamableHTTPClientTransport): void {
	if (!(transport instanceof StdioClientTransport)) return;
	const pid = transport.pid;
	if (pid === null) return;
	try { process.kill(pid, "SIGTERM"); } catch { /* The process may already have exited. */ }
}

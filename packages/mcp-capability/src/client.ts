/** MCP capability bridge: configured external tools become native Pi tools. */

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type ToolDefinition } from "@beemax/core";
import { Type, type TSchema } from "typebox";

export type McpServerConfig = {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	required?: boolean;
} | {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	required?: boolean;
};

export interface McpConfig {
	servers: Record<string, McpServerConfig>;
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
	tools: ToolDefinition[];
	approvalTools: string[];
	resources: number;
	prompts: number;
}

export class McpManager {
	private readonly connections = new Map<string, Connection>();
	private statuses: McpServerStatus[] = [];
	private readonly initializationTimeoutMs: number;

	constructor(options: { initializationTimeoutMs?: number } = {}) {
		this.initializationTimeoutMs = Math.max(100, options.initializationTimeoutMs ?? 15_000);
	}

	async connectAll(config: McpConfig): Promise<McpServerStatus[]> {
		await this.close();
		const attempts = await Promise.all(Object.entries(config.servers).map(async ([name, server]) => {
			validateServerName(name);
			try {
				const connection = await this.connectOne(name, server);
				return { server, connection, status: { name, connected: true, tools: connection.tools.map((tool) => tool.name), resources: connection.resources, prompts: connection.prompts } satisfies McpServerStatus };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
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
		for (const attempt of attempts) if ("connection" in attempt && attempt.connection) this.connections.set(attempt.status.name, attempt.connection);
		this.statuses = attempts.map((attempt) => attempt.status);
		return this.getStatus();
	}

	getTools(): ToolDefinition[] {
		return [...this.connections.values()].flatMap((connection) => connection.tools);
	}

	getApprovalTools(): string[] {
		return [...this.connections.values()].flatMap((connection) => connection.approvalTools);
	}

	getStatus(): McpServerStatus[] {
		return this.statuses.map((status) => ({ ...status, tools: [...status.tools] }));
	}

	async close(): Promise<void> {
		for (const connection of this.connections.values()) {
			await connection.client.close().catch(() => undefined);
		}
		this.connections.clear();
		this.statuses = [];
	}

	private async connectOne(name: string, server: McpServerConfig): Promise<Connection> {
		const client = new Client({ name: `beemax-${name}`, version: "0.1.0" }, { capabilities: {} });
		const transport = server.type === "stdio"
			? new StdioClientTransport({
				command: expandEnv(server.command),
				args: server.args?.map(expandEnv),
				env: server.env
					? { ...getDefaultEnvironment(), ...mapValues(server.env, expandEnv) }
					: undefined,
				cwd: server.cwd ? expandEnv(server.cwd) : undefined,
				stderr: "inherit",
			})
			: new StreamableHTTPClientTransport(new URL(expandEnv(server.url)), {
				requestInit: { headers: mapValues(server.headers ?? {}, expandEnv) },
			});
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
			const approvalTools: string[] = [];
			const tools: ToolDefinition[] = listed.tools.map((tool) => {
				const toolName = mcpToolName(name, tool.name);
				if (names.has(toolName)) throw new Error(`MCP tool name collision after normalization: ${tool.name}`);
				names.add(toolName);
				if (tool.annotations?.readOnlyHint !== true) approvalTools.push(toolName);
				return defineTool({
					name: toolName,
					label: tool.title ?? `${name}: ${tool.name}`,
					description: `[MCP ${name}/${tool.name}] ${tool.description ?? "External MCP tool"}`,
					parameters: tool.inputSchema as TSchema,
					execute: async (_id, params, signal) => {
						const result = await client.callTool(
							{ name: tool.name, arguments: params as Record<string, unknown> },
							undefined,
							{ signal, timeout: 120_000 },
						);
						const content = Array.isArray(result.content) ? result.content : [];
						const text = content.map((item: unknown) => {
							if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
								return String((item as { text?: unknown }).text ?? "");
							}
							return JSON.stringify(item);
						}).join("\n");
						return {
							content: [{ type: "text" as const, text: truncate(text, 50_000) }],
							details: { server: name, tool: tool.name, structuredContent: result.structuredContent },
							isError: result.isError === true,
						};
					},
				});
			});
			const addUtility = (tool: ToolDefinition) => {
				if (names.has(tool.name)) throw new Error(`MCP utility tool name collision: ${tool.name}`);
				names.add(tool.name);
				tools.push(tool);
			};
			if (capabilities?.resources) {
				addUtility(defineTool({
					name: mcpToolName(name, "resources"), label: `${name}: resources`, description: `[MCP ${name}] List available resources.`,
					parameters: Type.Object({}),
					execute: async () => {
						const result = await client.listResources();
						return { content: [{ type: "text" as const, text: truncate(JSON.stringify(result.resources), 50_000) }], details: { server: name, resources: result.resources } };
					},
				}));
				addUtility(defineTool({
					name: mcpToolName(name, "resource_read"), label: `${name}: read resource`, description: `[MCP ${name}] Read one resource by URI.`,
					parameters: Type.Object({ uri: Type.String({ minLength: 1, maxLength: 4096 }) }),
					execute: async (_id, params) => {
						const result = await client.readResource({ uri: params.uri });
						return { content: [{ type: "text" as const, text: truncate(JSON.stringify(result.contents), 50_000) }], details: { server: name, uri: params.uri, contents: result.contents } };
					},
				}));
			}
			if (capabilities?.prompts) {
				addUtility(defineTool({
					name: mcpToolName(name, "prompts"), label: `${name}: prompts`, description: `[MCP ${name}] List available prompt templates.`,
					parameters: Type.Object({}),
					execute: async () => {
						const result = await client.listPrompts();
						return { content: [{ type: "text" as const, text: truncate(JSON.stringify(result.prompts), 50_000) }], details: { server: name, prompts: result.prompts } };
					},
				}));
				addUtility(defineTool({
					name: mcpToolName(name, "prompt_get"), label: `${name}: get prompt`, description: `[MCP ${name}] Get one prompt template with optional string arguments.`,
					parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 256 }), arguments: Type.Optional(Type.Record(Type.String(), Type.String())) }),
					execute: async (_id, params) => {
						const result = await client.getPrompt({ name: params.name, arguments: params.arguments });
						return { content: [{ type: "text" as const, text: truncate(JSON.stringify(result.messages), 50_000) }], details: { server: name, prompt: params.name, messages: result.messages } };
					},
				}));
			}
			return { client, tools, approvalTools, resources, prompts };
		} catch (error) {
			await client.close().catch(() => undefined);
			throw error;
		}
	}
}

export function loadMcpConfig(path: string): McpConfig {
	if (!path) return { servers: {} };
	try {
		const text = readFileSync(path, "utf8");
		const parsed = JSON.parse(text) as Partial<McpConfig>;
		if (!parsed.servers || typeof parsed.servers !== "object" || Array.isArray(parsed.servers)) {
			throw new Error("MCP config must contain a servers object");
		}
		return { servers: parsed.servers as Record<string, McpServerConfig> };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
		throw new Error(`Could not load MCP config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function mcpToolName(server: string, tool: string): string {
	return `mcp_${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

function validateServerName(name: string): void {
	if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
}

function expandEnv(value: string): string {
	return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/gi, (_match, braced, plain) => {
		const key = braced ?? plain;
		const resolved = process.env[key];
		if (resolved === undefined) throw new Error(`Missing environment variable ${key} used by MCP config`);
		return resolved;
	});
}

function mapValues(input: Record<string, string>, fn: (value: string) => string): Record<string, string> {
	return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, fn(value)]));
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
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

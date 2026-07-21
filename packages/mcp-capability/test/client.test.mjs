import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMcpConfig, McpManager, validateMcpConfig } from "../dist/index.js";

test("MCP configuration rejects unknown top-level and server descriptor keys", () => {
	assert.throws(
		() => validateMcpConfig({ servers: {}, extra: true }),
		/unknown key extra/u,
	);
	assert.throws(
		() => validateMcpConfig({
			servers: {
				safe: { type: "stdio", command: process.execPath, shell: true },
			},
		}),
		/servers\.safe.*unknown key shell/u,
	);
});

test("MCP configuration rejects invalid descriptor field types", () => {
	const invalid = [
		null,
		{ servers: [] },
		{ servers: { server: { type: "stdio", command: 7 } } },
		{ servers: { server: { type: "stdio", command: process.execPath, args: "--version" } } },
		{ servers: { server: { type: "stdio", command: process.execPath, args: [7] } } },
		{ servers: { server: { type: "stdio", command: process.execPath, env: { TOKEN: 7 } } } },
		{ servers: { server: { type: "stdio", command: process.execPath, cwd: false } } },
		{ servers: { server: { type: "http", url: 7 } } },
		{ servers: { server: { type: "http", url: "https://example.invalid/mcp", headers: [] } } },
		{ servers: { server: { type: "http", url: "https://example.invalid/mcp", headers: { Accept: 7 } } } },
		{ servers: { server: { type: "http", url: "https://example.invalid/mcp", required: "yes" } } },
		{ servers: { server: { type: "http", url: "https://example.invalid/mcp", trustReadOnlyOperations: 1 } } },
	];
	for (const candidate of invalid) {
		assert.throws(() => validateMcpConfig(candidate), /MCP config/u);
	}
});

test("MCP configuration rejects reserved names and control characters", () => {
	assert.throws(() => validateMcpConfig({
		...JSON.parse(`{"servers":{"__proto__":{"type":"stdio","command":${JSON.stringify(process.execPath)}}}}`),
	}), /reserved/u);
	assert.throws(() => validateMcpConfig({
		servers: { server: { type: "stdio", command: process.execPath, args: ["unsafe\0argument"] } },
	}), /control characters/u);
	assert.throws(() => validateMcpConfig({
		servers: { server: { type: "http", url: "https://example.invalid/mcp", headers: { "X-Tenant": "safe\r\nInjected: true" } } },
	}), /control characters/u);
});

test("MCP stdio command and cwd are fixed host paths, never Profile environment templates", () => {
	assert.throws(() => validateMcpConfig({
		servers: { server: { type: "stdio", command: "${PROFILE_COMMAND}" } },
	}), /command.*fixed absolute path.*environment references/u);
	assert.throws(() => validateMcpConfig({
		servers: { server: { type: "stdio", command: process.execPath, cwd: "${PROFILE_CWD}" } },
	}), /cwd.*fixed absolute path.*environment references/u);
	assert.equal(validateMcpConfig({
		servers: { server: { type: "stdio", command: process.execPath } },
	}).servers.server.command, process.execPath);
});

test("MCP stdio runtime rejects a symlinked executable before spawning it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "beemax-mcp-command-symlink-"));
	const command = join(directory, "node-link");
	await symlink(process.execPath, command);
	const manager = new McpManager({ environment: {}, initializationTimeoutMs: 100 });
	try {
		await assert.rejects(manager.connectAll({
			servers: { server: { type: "stdio", command, required: true } },
		}), /real non-symlink executable/u);
	} finally {
		await manager.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("MCP configuration bounds server maps, descriptor maps, arrays, and UTF-8 strings", () => {
	const manyServers = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [
		`server-${index}`,
		{ type: "stdio", command: process.execPath },
	]));
	assert.throws(() => validateMcpConfig({ servers: manyServers }), /servers.*at most 32/u);

	assert.throws(() => validateMcpConfig({
		servers: { server: { type: "stdio", command: process.execPath, args: Array(65).fill("arg") } },
	}), /args.*at most 64/u);

	const manyEnvironmentValues = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`VALUE_${index}`, "safe"]));
	assert.throws(() => validateMcpConfig({
		servers: { server: { type: "stdio", command: process.execPath, env: manyEnvironmentValues } },
	}), /env.*at most 64/u);

	assert.throws(() => validateMcpConfig({
		servers: { server: { type: "stdio", command: `/${"😀".repeat(1_025)}` } },
	}), /command.*4096 bytes/u);
});

test("MCP configuration requires Profile environment references for credential-like values", () => {
	assert.throws(() => validateMcpConfig({
		servers: { server: { type: "stdio", command: process.execPath, env: { MCP_API_KEY: "literal-secret" } } },
	}), /env\.MCP_API_KEY.*\$\{ENV_REF\}/u);
	assert.throws(() => validateMcpConfig({
		servers: { server: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer literal-secret" } } },
	}), /headers\.Authorization.*\$\{ENV_REF\}/u);
	assert.throws(() => validateMcpConfig({
		servers: { server: { type: "http", url: "https://example.invalid/mcp", headers: { "X-API-Key": "$MCP_API_KEY" } } },
	}), /headers\.X-API-Key.*\$\{ENV_REF\}/u);

	assert.deepEqual(validateMcpConfig({
		servers: {
			stdio: {
				type: "stdio",
				command: process.execPath,
				env: { MCP_API_KEY: "${PROFILE_API_KEY}", SERVER_MODE: "read-only" },
			},
			http: {
				type: "http",
				url: "https://example.invalid/mcp",
				headers: { Authorization: "Bearer ${MCP_HTTP_TOKEN}", "X-Tenant": "customer-a" },
			},
		},
	}), {
		servers: {
			stdio: {
				type: "stdio",
				command: process.execPath,
				env: { MCP_API_KEY: "${PROFILE_API_KEY}", SERVER_MODE: "read-only" },
			},
			http: {
				type: "http",
				url: "https://example.invalid/mcp",
				headers: { Authorization: "Bearer ${MCP_HTTP_TOKEN}", "X-Tenant": "customer-a" },
			},
		},
	});
});

test("MCP HTTP descriptors allow HTTPS and literal loopback HTTP only", () => {
	for (const url of [
		"https://mcp.example.invalid/service",
		"http://localhost:3000/mcp",
		"http://127.42.0.9:3000/mcp",
		"http://[::1]:3000/mcp",
	]) {
		assert.equal(validateMcpConfig({ servers: { server: { type: "http", url } } }).servers.server.url, url);
	}
	for (const url of [
		"http://example.invalid/mcp",
		"http://0.0.0.0:3000/mcp",
		"file:///tmp/mcp.sock",
		"ftp://localhost/mcp",
		"https://localhost/mcp",
		"https://127.0.0.1/mcp",
		"https://10.0.0.1/mcp",
		"https://[::1]/mcp",
		"https://169.254.169.254/latest/meta-data",
		"https://user:password@example.invalid/mcp",
		"https://user:password@example.invalid/${MCP_PATH}",
	]) {
		assert.throws(() => validateMcpConfig({ servers: { server: { type: "http", url } } }), /MCP config servers\.server\.url/u);
	}
});

test("MCP connection rejects unsafe HTTP hosts and oversized values after Profile expansion", async () => {
	const cases = [
		{
			environment: { MCP_HOST: "example.invalid" },
			server: { type: "http", url: "http://${MCP_HOST}/mcp", required: true },
			error: /HTTPS or loopback HTTP/u,
		},
		{
			environment: { MCP_ARGUMENT: "x".repeat(4_097) },
			server: { type: "stdio", command: process.execPath, args: ["${MCP_ARGUMENT}"], required: true },
			error: /4096 bytes after Profile environment expansion/u,
		},
	];
	for (const { environment, server, error } of cases) {
		const manager = new McpManager({ environment, initializationTimeoutMs: 100 });
		try {
			await assert.rejects(manager.connectAll({ servers: { server } }), error);
		} finally {
			await manager.close();
		}
	}
});

test("MCP file loading applies strict validation and a bounded manifest size", async () => {
	const directory = await mkdtemp(join(tmpdir(), "beemax-mcp-config-validation-"));
	const path = join(directory, "mcp.json");
	try {
		await writeFile(path, JSON.stringify({ servers: {}, unknown: true }));
		assert.throws(() => loadMcpConfig(path), /unknown key unknown/u);

		await writeFile(path, `${" ".repeat(256 * 1_024)}\n`);
		assert.throws(() => loadMcpConfig(path), /at most 262144 bytes/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("McpManager routes Streamable HTTP SDK traffic through the pinned fetch", async () => {
	const requests = [];
	const manager = new McpManager({
		environment: {},
		initializationTimeoutMs: 1_000,
		publicHttp: {
			lookup: async (hostname) => {
				assert.equal(hostname, "mcp.example.test");
				return [{ address: "93.184.216.34", family: 4 }];
			},
			request: async (url, options) => {
				const payload = options.body ? JSON.parse(new TextDecoder().decode(options.body)) : undefined;
				requests.push({ url: url.toString(), method: options.method, address: options.destination.address, payload });
				if (options.method === "GET") return new Response(null, { status: 405 });
				if (payload?.method === "initialize") {
					return new Response(JSON.stringify({
						jsonrpc: "2.0",
						id: payload.id,
						result: { protocolVersion: payload.params.protocolVersion, capabilities: {}, serverInfo: { name: "pinned-test", version: "1.0.0" } },
					}), { status: 200, headers: { "content-type": "application/json" } });
				}
				if (payload?.method === "tools/list") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools: [] } }), { status: 200, headers: { "content-type": "application/json" } });
				}
				return new Response(null, { status: 202 });
			},
		},
	});
	try {
		const status = await manager.connectAll({
			servers: { remote: { type: "http", url: "https://mcp.example.test/service", required: true } },
		});
		assert.equal(status[0].connected, true);
		assert.ok(requests.some((request) => request.payload?.method === "initialize"));
		assert.ok(requests.some((request) => request.payload?.method === "tools/list"));
		assert.ok(requests.every((request) => request.address === "93.184.216.34"));
	} finally {
		await manager.close();
	}
});

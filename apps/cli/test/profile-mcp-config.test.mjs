import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProfile } from "../dist/profile-config.js";
import { loadConfig } from "../dist/config.js";
import { addProfileMcpServer, inspectLocalMcpDescriptor, removeProfileMcpServer } from "../dist/profile-mcp-config.js";

test("a customer can add and remove a strict MCP descriptor in one Profile", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-mcp-add-"));
	try {
		const paths = await createProfile("mcp-customer", { home: join(root, "home") });
		const config = loadConfig(paths.configPath, "mcp-customer", { home: join(root, "home") });
		const descriptor = join(root, "server.json");
		await writeFile(descriptor, JSON.stringify({ type: "http", url: "https://mcp.example.test/service", headers: { Authorization: "Bearer ${MCP_SERVICE_TOKEN}" }, required: false }));
		const inspected = await inspectLocalMcpDescriptor(descriptor);
		assert.equal(inspected.type, "http");

		await addProfileMcpServer({ profileHome: paths.homePath, configPath: config.mcp.configPath, name: "customer", descriptorPath: descriptor });
		const installed = JSON.parse(await readFile(config.mcp.configPath, "utf8"));
		assert.deepEqual(Object.keys(installed.servers), ["customer"]);
		assert.equal(installed.servers.customer.headers.Authorization, "Bearer ${MCP_SERVICE_TOKEN}");
		await assert.rejects(
			() => addProfileMcpServer({ profileHome: paths.homePath, configPath: config.mcp.configPath, name: "customer", descriptorPath: descriptor }),
			/already exists/,
		);

		await removeProfileMcpServer({ profileHome: paths.homePath, configPath: config.mcp.configPath, name: "customer" });
		assert.deepEqual(JSON.parse(await readFile(config.mcp.configPath, "utf8")), { servers: {} });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP self-service rejects literal credentials, unknown fields, and linked descriptors", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-mcp-reject-"));
	try {
		const literal = join(root, "literal.json");
		await writeFile(literal, JSON.stringify({ type: "http", url: "https://mcp.example.test", headers: { Authorization: "Bearer secret-value" } }));
		await assert.rejects(() => inspectLocalMcpDescriptor(literal), /environment reference|literal|secret|credential/i);
		const unknown = join(root, "unknown.json");
		await writeFile(unknown, JSON.stringify({ type: "stdio", command: "/usr/bin/env", installer: "npm" }));
		await assert.rejects(() => inspectLocalMcpDescriptor(unknown), /unknown|unsupported|key/i);
		const stdio = join(root, "stdio.json");
		await writeFile(stdio, JSON.stringify({ type: "stdio", command: "/usr/bin/env" }));
		const paths = await createProfile("stdio-target", { home: join(root, "home") });
		const config = loadConfig(paths.configPath, "stdio-target", { home: join(root, "home") });
		await assert.rejects(
			() => addProfileMcpServer({ profileHome: paths.homePath, configPath: config.mcp.configPath, name: "stdio", descriptorPath: stdio }),
			/trusted host operator.*stdio/i,
		);
		const linked = join(root, "linked.json");
		await symlink(unknown, linked);
		await assert.rejects(() => inspectLocalMcpDescriptor(linked), /regular file/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

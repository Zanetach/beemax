import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityProviderRuntime } from "../dist/index.js";

test("Provider resolution prefers one healthy installed Tool or MCP without requesting installation", async () => {
	let installs = 0;
	const runtime = new CapabilityProviderRuntime({
		installer: { install: async () => { installs++; return { receiptId: "unexpected", installedAt: 1 }; } },
	});
	const result = await runtime.resolve({
		capability: "public web research",
		providers: [
			{ id: "mcp-offline", kind: "mcp", capabilities: ["public web research"], installed: true, health: async () => ({ status: "unhealthy", reason: "connection refused" }) },
			{ id: "tool-ready", kind: "tool", capabilities: ["public web research"], installed: true, health: async () => ({ status: "ready", evidenceRef: "probe:tool-ready" }) },
		],
	});
	assert.equal(result.status, "ready");
	assert.equal(result.selected?.id, "tool-ready");
	assert.equal(result.candidates[0].id, "tool-ready");
	assert.equal(result.candidates[0].health.status, "ready");
	assert.equal(installs, 0);
});

test("Provider resolution reports exact configuration requirements without exposing values or weakening the capability", async () => {
	const runtime = new CapabilityProviderRuntime();
	const result = await runtime.resolve({
		capability: "public web research",
		providers: [{
			id: "tavily", kind: "tool", capabilities: ["public web research"], installed: true,
			configuration: { required: ["TAVILY_API_KEY"], instructions: "Configure the Profile credential reference for Tavily." },
			health: async () => ({ status: "configuration_required", reason: "TAVILY_API_KEY is not configured", missingConfiguration: ["TAVILY_API_KEY"] }),
		}],
	});
	assert.equal(result.status, "blocked");
	assert.equal(result.blocker?.code, "configuration_required");
	assert.deepEqual(result.blocker?.requiredConfiguration, ["TAVILY_API_KEY"]);
	assert.match(result.blocker?.reason ?? "", /not configured/);
	assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test("Provider acquisition installs an external candidate only after explicit authority and returns a health-checked receipt", async () => {
	let installed = false;
	const provider = {
		id: "research-mcp", kind: "mcp", capabilities: ["public web research"], installed: false,
		install: { source: "approved-catalog", package: "research-mcp", version: "1.0.0" },
		health: async () => installed ? { status: "ready", evidenceRef: "probe:research-mcp" } : { status: "unavailable", reason: "not installed" },
	};
	const authorizations = [];
	const runtime = new CapabilityProviderRuntime({
		installAuthority: { authorize: async (input) => { authorizations.push(input.provider.id); return { allowed: true, evidenceRef: "approval:42" }; } },
		installer: { install: async () => { installed = true; return { receiptId: "install:42", installedAt: 42, evidenceRef: "catalog:receipt:42" }; } },
	});
	const result = await runtime.acquire({ capability: "public web research", providers: [provider] });
	assert.equal(result.status, "ready");
	assert.equal(result.selected?.id, "research-mcp");
	assert.equal(result.selected?.health.status, "ready");
	assert.equal(result.installationReceipt?.receiptId, "install:42");
	assert.deepEqual(authorizations, ["research-mcp"]);
});

test("Provider acquisition never silently installs executable capability without authority", async () => {
	let installs = 0;
	const runtime = new CapabilityProviderRuntime({ installer: { install: async () => { installs++; return { receiptId: "bad", installedAt: 1 }; } } });
	const result = await runtime.acquire({ capability: "analysis", providers: [{ id: "external-tool", kind: "tool", capabilities: ["analysis"], installed: false, install: { source: "catalog", package: "external-tool" } }] });
	assert.equal(result.status, "blocked");
	assert.equal(result.blocker?.code, "installation_authorization_required");
	assert.equal(installs, 0);
});

test("Provider health timeout is bounded even when a broken Provider ignores AbortSignal", async () => {
	const runtime = new CapabilityProviderRuntime({ healthTimeoutMs: 100 });
	const startedAt = Date.now();
	const result = await runtime.resolve({ capability: "research", providers: [{ id: "hung-mcp", kind: "mcp", capabilities: ["research"], installed: true, health: async () => new Promise(() => undefined) }] });
	assert.ok(Date.now() - startedAt < 500);
	assert.equal(result.status, "blocked");
	assert.equal(result.candidates[0].health.status, "unavailable");
	assert.match(result.candidates[0].health.reason ?? "", /timed out/i);
});

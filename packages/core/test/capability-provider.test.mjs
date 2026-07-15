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

test("Provider resolution admits configured-but-unverified execution without claiming observed health", async () => {
	const runtime = new CapabilityProviderRuntime();
	const result = await runtime.resolve({
		capability: "public web research",
		providers: [{ id: "brave", kind: "tool", capabilities: ["public web research"], installed: true, health: async () => ({ status: "unverified", reason: "health is established by execution" }) }],
	});
	assert.equal(result.status, "ready");
	assert.equal(result.selected?.id, "brave");
	assert.equal(result.selected?.health.status, "unverified");
	assert.equal(result.blocker, undefined);
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
	assert.equal(result.authorityEvidenceRef, "approval:42");
	assert.deepEqual(authorizations, ["research-mcp"]);
});

test("Provider installation state is re-evaluated on later Turns instead of reinstalling", async () => {
	let installed = false;
	let installs = 0;
	const provider = { id: "dynamic-provider", kind: "mcp", capabilities: ["research"], installed: () => installed, install: { source: "approved-catalog", package: "dynamic-provider", version: "1.0.0" }, health: async () => installed ? { status: "ready", evidenceRef: "health:dynamic-provider" } : { status: "unavailable", reason: "not installed" } };
	const runtime = new CapabilityProviderRuntime({
		installAuthority: { authorize: async () => ({ allowed: true, evidenceRef: "approval:dynamic-provider" }) },
		installer: { install: async () => { installs++; installed = true; return { receiptId: "install:dynamic-provider", installedAt: 42, evidenceRef: "catalog:dynamic-provider" }; } },
	});
	assert.equal((await runtime.acquire({ capability: "research", providers: [provider] })).status, "ready");
	assert.equal((await runtime.acquire({ capability: "research", providers: [provider] })).status, "ready");
	assert.equal(installs, 1);
});

test("Provider acquisition cannot claim verified installation without an observed health probe", async () => {
	const runtime = new CapabilityProviderRuntime({
		installAuthority: { authorize: async () => ({ allowed: true, evidenceRef: "approval:no-probe" }) },
		installer: { install: async () => ({ receiptId: "install:no-probe", installedAt: 42, evidenceRef: "catalog:no-probe" }) },
	});
	const result = await runtime.acquire({ capability: "analysis", providers: [{ id: "no-probe", kind: "tool", capabilities: ["analysis"], installed: false, install: { source: "approved-catalog", package: "no-probe", version: "1.0.0" } }] });
	assert.equal(result.status, "blocked");
	assert.equal(result.blocker?.code, "installation_failed");
	assert.match(result.blocker?.reason ?? "", /health probe/i);
});

test("Provider acquisition rejects an installation receipt without evidence", async () => {
	let installed = false;
	const runtime = new CapabilityProviderRuntime({
		installAuthority: { authorize: async () => ({ allowed: true, evidenceRef: "approval:missing-install-evidence" }) },
		installer: { install: async () => { installed = true; return { receiptId: "install:no-evidence", installedAt: 42 }; } },
	});
	const result = await runtime.acquire({ capability: "analysis", providers: [{ id: "missing-evidence", kind: "tool", capabilities: ["analysis"], installed: false, install: { source: "approved-catalog", package: "missing-evidence", version: "1.0.0" }, health: async () => installed ? { status: "ready", evidenceRef: "health:missing-evidence" } : { status: "unavailable" } }] });
	assert.equal(result.status, "blocked");
	assert.equal(result.blocker?.code, "installation_failed");
	assert.match(result.blocker?.reason ?? "", /receipt evidence/i);
});

test("Provider acquisition keeps an installed but unverified Provider blocked", async () => {
	const runtime = new CapabilityProviderRuntime({
		installAuthority: { authorize: async () => ({ allowed: true, evidenceRef: "approval:unverified" }) },
		installer: { install: async () => ({ receiptId: "install:unverified", installedAt: 42, evidenceRef: "catalog:unverified" }) },
	});
	const result = await runtime.acquire({ capability: "analysis", providers: [{ id: "unverified", kind: "mcp", capabilities: ["analysis"], installed: false, install: { source: "approved-catalog", package: "unverified", version: "1.0.0" }, health: async () => ({ status: "unverified", reason: "first real execution has not succeeded" }) }] });
	assert.equal(result.status, "blocked");
	assert.equal(result.blocker?.code, "installation_failed");
	assert.match(result.blocker?.reason ?? "", /did not pass.*health check/i);
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

test("Provider acquisition bounds authority and installer calls that ignore cancellation", async () => {
	const provider = { id: "slow", kind: "mcp", capabilities: ["research"], installed: false, install: { source: "approved-catalog", package: "slow", version: "1.0.0" }, health: async () => ({ status: "ready", evidenceRef: "health:slow" }) };
	const slowAuthority = new CapabilityProviderRuntime({ authorityTimeoutMs: 100, installAuthority: { authorize: async () => new Promise((resolve) => setTimeout(() => resolve({ allowed: true, evidenceRef: "approval:late" }), 300)) }, installer: { install: async () => ({ receiptId: "never", installedAt: 1, evidenceRef: "never" }) } });
	const authorityStartedAt = Date.now();
	const authorityResult = await slowAuthority.acquire({ capability: "research", providers: [provider] });
	assert.ok(Date.now() - authorityStartedAt < 250);
	assert.equal(authorityResult.blocker?.code, "installation_authorization_required");
	assert.match(authorityResult.blocker?.reason ?? "", /timed out/i);

	const slowInstaller = new CapabilityProviderRuntime({ installTimeoutMs: 100, installAuthority: { authorize: async () => ({ allowed: true, evidenceRef: "approval:fast" }) }, installer: { install: async () => new Promise((resolve) => setTimeout(() => resolve({ receiptId: "install:late", installedAt: 1, evidenceRef: "catalog:late" }), 300)) } });
	const installStartedAt = Date.now();
	const installResult = await slowInstaller.acquire({ capability: "research", providers: [provider] });
	assert.ok(Date.now() - installStartedAt < 250);
	assert.equal(installResult.blocker?.code, "installation_outcome_unknown");
	assert.match(installResult.blocker?.reason ?? "", /timed out/i);
});

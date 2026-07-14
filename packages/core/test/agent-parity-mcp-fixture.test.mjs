import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { collectFixtureEvidence, isolatedEvaluationWorkspace, startFixtureAuthorityServer } from "../../../evals/adapters/subprocess.mjs";

test("agent parity MCP fixture exposes real Tools and commits an unknown Effect only once", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "beemax-parity-mcp-workspace-"));
	const authority = await mkdtemp(join(tmpdir(), "beemax-parity-mcp-authority-"));
	const receiptKey = "test-receipt-key-which-is-at-least-32-bytes";
	const server = new URL("../../../evals/fixtures/agent-parity/mcp-server.mjs", import.meta.url).pathname;
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [server],
		env: { ...process.env, AGENT_PARITY_WORKSPACE: workspace, AGENT_PARITY_STATE_DIR: authority, AGENT_PARITY_RECEIPT_KEY: receiptKey },
		stderr: "pipe",
	});
	const client = new Client({ name: "agent-parity-test", version: "1.0.0" });
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["activate_skill", "deliver", "effect_status", "inspect_image", "memory_recall", "read_source_a", "read_source_b", "recover_step", "schedule_delivery", "send_unknown", "status", "structured_lookup"].sort());
		const status = await client.callTool({ name: "status", arguments: {} });
		assert.match(status.content[0].text, /MCP-STATUS-READY/);
		const first = await client.callTool({ name: "send_unknown", arguments: { idempotencyKey: "fixture-effect-1" } });
		assert.equal(first.isError, true);
		const reconciled = await client.callTool({ name: "effect_status", arguments: { idempotencyKey: "fixture-effect-1" } });
		assert.match(reconciled.content[0].text, /committed/);
		const second = await client.callTool({ name: "send_unknown", arguments: { idempotencyKey: "fixture-effect-1" } });
		assert.equal(second.isError, true);
		const evidence = await collectFixtureEvidence(workspace, authority, receiptKey);
		assert.equal(evidence.facts.effectAttemptCount, 2);
		assert.equal(evidence.facts.effectCommitCount, 1);
		assert.equal(evidence.facts.effectReconcileCount, 1);
		assert.equal(evidence.duplicateEffects, 0);
	} finally {
		await client.close().catch(() => {});
		await Promise.all([rm(workspace, { recursive: true, force: true }), rm(authority, { recursive: true, force: true })]);
	}
});

test("benchmark supervisor owns fixture authority while the Agent receives only an HTTP endpoint", async () => {
	const workspace = await isolatedEvaluationWorkspace(new URL("../../../evals/fixtures/agent-parity", import.meta.url).pathname, "beemax-parity-http-");
	let authority;
	const client = new Client({ name: "agent-parity-http-test", version: "1.0.0" });
	try {
		authority = await startFixtureAuthorityServer({ serverPath: new URL("../../../evals/fixtures/agent-parity/mcp-server.mjs", import.meta.url).pathname, workspace });
		assert.match(authority.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		await client.connect(new StreamableHTTPClientTransport(new URL(authority.url)));
		const status = await client.callTool({ name: "status", arguments: {} });
		assert.match(status.content[0].text, /MCP-STATUS-READY/);
		const skill = await client.callTool({ name: "activate_skill", arguments: { name: "evaluation-research" } });
		assert.match(skill.content[0].text, /SKILL-evaluation-research-v1/);
		const scope = await client.callTool({ name: "memory_recall", arguments: { profile: "target" } });
		assert.match(scope.content[0].text, /PROFILE-TARGET-ISOLATED/);
		const evidence = await collectFixtureEvidence(workspace.cwd, workspace.authorityDir, workspace.receiptKey);
		assert.deepEqual(evidence.facts.authorityIds, ["MCP-STATUS-READY", "SKILL-evaluation-research-v1", "PROFILE-TARGET-ISOLATED"]);
		assert.equal(evidence.facts.profileIsolationVerified, true);
		assert.ok(evidence.kinds.includes("skill"));
		assert.ok(evidence.kinds.includes("scope"));
	} finally {
		await client.close().catch(() => {});
		await authority?.dispose();
		await workspace.dispose();
	}
});

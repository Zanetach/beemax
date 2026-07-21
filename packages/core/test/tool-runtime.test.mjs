import test from "node:test";
import assert from "node:assert/strict";
import { FileToolAuditJournal, MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, ToolPolicyRegistry, boundToolResultContent, defineTool, governToolDefinition, withToolPolicy } from "../dist/index.js";
import { Type } from "typebox";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("Tool policy registry prefers first-class metadata and keeps unclassified tools conservative", () => {
	const explicit = withToolPolicy(defineTool({
		name: "calendar_create", label: "Create Calendar Event", description: "Create an event", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	}), { ...MUTATING_TOOL_POLICY, risk: "medium", reversible: true, impact: "Creates a calendar event that can be deleted" });
	const legacy = defineTool({ name: "legacy_read", label: "Legacy Read", description: "Read", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
	const registry = new ToolPolicyRegistry([explicit, legacy]);
	assert.equal(registry.get("calendar_create").risk, "medium");
	assert.equal(registry.get("calendar_create").sideEffect, "external");
	assert.equal("approval" in registry.get("calendar_create"), false);
	assert.equal(registry.get("legacy_read").sideEffect, "external");
	assert.equal(registry.get("legacy_read").risk, "medium");
	assert.equal(registry.get("unregistered").risk, "medium");
	assert.equal("approval" in registry.get("unregistered"), false);
});

test("Tool capability grants combine availability and policy in one catalog", () => {
	const external = withToolPolicy(defineTool({
		name: "calendar_create", label: "Create", description: "Create", parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	}), { ...MUTATING_TOOL_POLICY, risk: "medium" });
	const catalog = new ToolPolicyRegistry([external]);
	catalog.enable(["read", "calendar_create"]);
	assert.deepEqual(catalog.enabledNames(), ["calendar_create", "read"]);
	assert.deepEqual(catalog.grant("calendar_create"), {
		name: "calendar_create",
		enabled: true,
		policy: catalog.get("calendar_create"),
	});
	assert.equal(catalog.grant("write").enabled, false);
});

test("governed read-only tools retry safely, truncate output, and emit lifecycle audit", async () => {
	let calls = 0;
	const audit = [];
	const tool = defineTool({
		name: "stable_read", label: "Stable Read", description: "Read data", parameters: Type.Object({}),
		execute: async () => { calls++; if (calls === 1) throw new Error("transient read failure"); return { content: [{ type: "text", text: "x".repeat(4_000) }], details: {} }; },
	});
	const governed = governToolDefinition(tool, { ...READ_ONLY_TOOL_POLICY, maxAttempts: 2, maxResultBytes: 1_024 }, source, (event) => audit.push(event));
	const result = await governed.execute("call", {}, undefined, undefined, {});
	assert.equal(calls, 2);
	assert.match(result.content.at(-1).text, /truncated/);
	assert.deepEqual(audit.map((event) => event.phase), ["started", "failed", "started", "completed"]);
});

test("one estimated-token budget bounds every governed Tool result including multilingual MCP-style text", async () => {
	const audit = [];
	const tool = defineTool({
		name: "mcp_large_result", label: "Large MCP result", description: "Read remote text", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: `header\n${"汉".repeat(2_000)}` }], details: {} }),
	});
	const governed = governToolDefinition(tool, { ...READ_ONLY_TOOL_POLICY, maxResultBytes: 128 * 1024 }, source, (event) => audit.push(event), { maxEstimatedTokens: 256 });
	const result = await governed.execute("call", {}, undefined, undefined, {});
	assert.match(result.content.at(-1).text, /truncated/);
	assert.ok(result.content[0].text.length < 600, "non-ASCII text must not inherit an unsafe ASCII chars/token ratio");
	const completed = audit.find((event) => event.phase === "completed");
	assert.equal(completed.resultTruncated, true);
	assert.ok(completed.resultEstimatedTokens <= 300);
	assert.ok(completed.resultBytes < 128 * 1024);
});

test("the shared Tool result ceiling accounts for non-text image content and its truncation marker", () => {
	const bounded = boundToolResultContent([
		{ type: "image", data: "first" },
		{ type: "image", data: "second" },
	], { maxBytes: 128 * 1024, maxEstimatedTokens: 1_500 });
	assert.equal(bounded.truncated, true);
	assert.equal(bounded.content.filter((block) => block.type === "image").length, 1);
	assert.match(bounded.content.at(-1).text, /truncated/);
	assert.ok(bounded.estimatedTokens <= 1_500);
});

test("governed mutating tools never retry after a failure", async () => {
	let calls = 0;
	const tool = defineTool({ name: "mutate", label: "Mutate", description: "Mutate", parameters: Type.Object({}), execute: async () => { calls++; throw new Error("failed mutation"); } });
	const governed = governToolDefinition(tool, { ...MUTATING_TOOL_POLICY, maxAttempts: 5 }, source);
	await assert.rejects(governed.execute("call", {}, undefined, undefined, {}), /failed mutation/);
	assert.equal(calls, 1);
});

test("governed mutating tools preserve a final structured error result for Effect settlement", async () => {
	let calls = 0;
	const details = { beemaxEffect: { operation: "render", proof: { provider: "beemax-artifact-runtime", resourceType: "workspace-artifact", resourceId: "report.pdf" } } };
	const tool = defineTool({ name: "structured_mutation", label: "Structured mutation", description: "Mutate with evidence", parameters: Type.Object({}), execute: async () => {
		calls++;
		return { content: [{ type: "text", text: "output was written but verification failed" }], details, isError: true };
	} });
	const governed = governToolDefinition(tool, { ...MUTATING_TOOL_POLICY, sideEffect: "local", maxAttempts: 5 }, source);
	const result = await governed.execute("call", {}, undefined, undefined, {});
	assert.equal(calls, 1);
	assert.equal(result.isError, true);
	assert.equal(result.details, details);
});

test("governed read-only tools treat structured isError results as retryable failures", async () => {
	let attempts = 0;
	const tool = defineTool({ name: "remote_read", label: "Remote read", description: "Read remote data", parameters: Type.Object({}), execute: async () => {
		attempts++;
		if (attempts === 1) return { content: [{ type: "text", text: "temporary upstream failure" }], details: {}, isError: true };
		return { content: [{ type: "text", text: "recovered" }], details: {}, isError: false };
	} });
	const governed = governToolDefinition(tool, { ...READ_ONLY_TOOL_POLICY, maxAttempts: 2 }, source);
	const result = await governed.execute("call", {}, undefined, undefined, {});
	assert.equal(attempts, 2);
	assert.equal(result.content[0].text, "recovered");
});

test("governed tools enforce their timeout even when a legacy implementation ignores AbortSignal", async () => {
	let calls = 0;
	const tool = defineTool({ name: "hung_read", label: "Hung Read", description: "Never settles", parameters: Type.Object({}), execute: async () => { calls++; return new Promise(() => {}); } });
	const governed = governToolDefinition(tool, { ...READ_ONLY_TOOL_POLICY, timeoutMs: 100, maxAttempts: 2 }, source);
	await assert.rejects(governed.execute("call", {}, undefined, undefined, {}), /timed out|timeout|aborted/i);
	assert.equal(calls, 1, "an uncooperative timed-out operation must not be duplicated");
});

test("a pre-aborted governed Tool never starts its underlying implementation", async () => {
	let calls = 0;
	const controller = new AbortController();
	controller.abort(new Error("Objective execution already stopped"));
	const tool = defineTool({
		name: "cancelled_read", label: "Cancelled read", description: "Must not start", parameters: Type.Object({}),
		execute: async () => { calls++; throw new Error("orphaned implementation executed"); },
	});
	const governed = governToolDefinition(tool, { ...READ_ONLY_TOOL_POLICY, maxAttempts: 2 }, source);
	await assert.rejects(governed.execute("call", {}, controller.signal, undefined, {}), /already stopped/i);
	assert.equal(calls, 0);
});

test("Profile Tool audit journal persists bounded operational events without arguments or results", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-audit-"));
	try {
		const path = join(root, "tool-audit.jsonl");
		const journal = new FileToolAuditJournal(path, 100);
		journal.append({ phase: "started", source, toolName: "write", policy: { ...MUTATING_TOOL_POLICY }, at: 10, attempt: 1 });
		journal.append({ phase: "completed", source, toolName: "write", policy: { ...MUTATING_TOOL_POLICY }, at: 20, attempt: 1, durationMs: 10 });
		journal.append({ phase: "failed", source, toolName: "write", policy: { ...MUTATING_TOOL_POLICY }, at: 30, reason: "token=private-secret and user content" });
		journal.append({ phase: "blocked", source, toolName: "write", policy: { ...MUTATING_TOOL_POLICY }, at: 40, reason: "sensitive business rationale", enterprisePolicy: { decisionId: "freeze", publisherId: "security", version: "v7", disposition: "deny", effectiveScopeId: "enterprise", effectiveFrom: 1, effectiveUntil: 100, evaluatedAt: 40, evidenceRefs: ["policy:freeze:7"] }, governance: { decisionId: "governance:call:40", outcome: "deny", reasonCode: "enterprise_policy_deny", factors: ["risk:high"], policyDecisionId: "freeze" } });
		const events = journal.events();
		assert.deepEqual(events.map((event) => event.phase), ["started", "completed", "failed", "blocked"]);
		assert.equal(events[2].hasReason, true);
		assert.equal(events[0].scope.userId, "local");
		assert.equal(events[3].enterprisePolicy.version, "v7");
		assert.deepEqual(events[3].enterprisePolicy.evidenceRefs, ["policy:freeze:7"]);
		assert.equal(events[3].governance.reasonCode, "enterprise_policy_deny");
		assert.doesNotMatch(JSON.stringify(events), /args|result|private-secret|user content/);
		assert.equal(statSync(path).mode & 0o777, 0o600);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

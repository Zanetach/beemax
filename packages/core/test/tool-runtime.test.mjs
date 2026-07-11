import test from "node:test";
import assert from "node:assert/strict";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, ToolPolicyRegistry, approvalDetails, defineTool, governToolDefinition, withToolPolicy } from "../dist/index.js";
import { Type } from "typebox";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("Tool policy registry prefers first-class metadata and keeps legacy tools conservative", () => {
	const explicit = withToolPolicy(defineTool({
		name: "calendar_create", label: "Create Calendar Event", description: "Create an event", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	}), { ...MUTATING_TOOL_POLICY, risk: "medium", reversible: true, impact: "Creates a calendar event that can be deleted" });
	const legacy = defineTool({ name: "legacy_read", label: "Legacy Read", description: "Read", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
	const registry = new ToolPolicyRegistry([explicit, legacy], ["unknown_mutation"]);
	assert.equal(registry.get("calendar_create").risk, "medium");
	assert.equal(registry.get("calendar_create").approval, "always");
	assert.deepEqual(registry.get("legacy_read"), READ_ONLY_TOOL_POLICY);
	assert.equal(registry.get("unknown_mutation").risk, "high");
	assert.equal(registry.get("unregistered").approval, "always");
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

test("governed mutating tools never retry after a failure", async () => {
	let calls = 0;
	const tool = defineTool({ name: "mutate", label: "Mutate", description: "Mutate", parameters: Type.Object({}), execute: async () => { calls++; throw new Error("failed mutation"); } });
	const governed = governToolDefinition(tool, { ...MUTATING_TOOL_POLICY, maxAttempts: 5 }, source);
	await assert.rejects(governed.execute("call", {}, undefined, undefined, {}), /failed mutation/);
	assert.equal(calls, 1);
});

test("governed tools enforce their timeout even when a legacy implementation ignores AbortSignal", async () => {
	let calls = 0;
	const tool = defineTool({ name: "hung_read", label: "Hung Read", description: "Never settles", parameters: Type.Object({}), execute: async () => { calls++; return new Promise(() => {}); } });
	const governed = governToolDefinition(tool, { ...READ_ONLY_TOOL_POLICY, timeoutMs: 100, maxAttempts: 2 }, source);
	await assert.rejects(governed.execute("call", {}, undefined, undefined, {}), /timed out|timeout|aborted/i);
	assert.equal(calls, 1, "an uncooperative timed-out operation must not be duplicated");
});

test("approval cards derive risk and reversibility from Tool policy rather than tool names", () => {
	const details = approvalDetails({
		source, toolName: "innocent_sounding_name", args: { path: "calendar/42" },
		policy: { ...MUTATING_TOOL_POLICY, risk: "medium", reversible: true, impact: "Creates a reversible calendar event" },
	});
	assert.equal(details.risk, "中");
	assert.equal(details.impact, "Creates a reversible calendar event");
	assert.equal(details.reversibility, "可逆或只读");
});

import test from "node:test";
import assert from "node:assert/strict";
import { MUTATING_TOOL_POLICY, ToolApprovalBroker } from "../dist/index.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("Core approval broker owns one-time and task-scoped grants", async () => {
	const prompts = [];
	const broker = new ToolApprovalBroker(async (_source, text) => { prompts.push(text); }, 1_000);
	try {
		broker.beginTask(source, "turn-1");
		const once = broker.authorize({ source, toolName: "write", args: { path: "a.txt", token: "hidden" }, policy: MUTATING_TOOL_POLICY });
		assert.match(prompts[0], /\[REDACTED\]/);
		assert.match(prompts[0], /目标：a.txt/);
		assert.match(prompts[0], /风险：高/);
		assert.match(prompts[0], /可逆性：/);
		assert.equal(await broker.handleReply(source, "1"), true);
		assert.deepEqual(await once, { allowed: true });

		const granted = broker.authorize({ source, toolName: "write", args: {}, policy: MUTATING_TOOL_POLICY });
		assert.equal(await broker.handleReply(source, "2"), true);
		assert.deepEqual(await granted, { allowed: true });
		assert.deepEqual(await broker.authorize({ source, toolName: "write", args: {}, policy: MUTATING_TOOL_POLICY }), { allowed: true });

		assert.equal(broker.endTask(source, "turn-1"), true);
		broker.beginTask(source, "turn-2");
		const nextTask = broker.authorize({ source, toolName: "write", args: {}, policy: MUTATING_TOOL_POLICY });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(await broker.handleReply(source, "3"), true);
		assert.deepEqual(await nextTask, { allowed: false, reason: "User denied the tool call" });
	} finally {
		broker.dispose();
	}
});

test("task grants are bound to the active task and expose a content-free snapshot", async () => {
	const broker = new ToolApprovalBroker(async () => {}, 1_000);
	broker.beginTask(source, "turn-a");
	const waiting = broker.authorize({ source, toolName: "write", args: { path: "report.md" }, policy: MUTATING_TOOL_POLICY });
	await new Promise((resolve) => setImmediate(resolve));
	await broker.decide(source, "task");
	await waiting;
	assert.deepEqual(broker.executionGrant(source), {
		taskId: "turn-a",
		allowedCapabilities: ["write"],
		status: "active",
	});
	broker.beginTask(source, "turn-b");
	assert.deepEqual(broker.executionGrant(source), {
		taskId: "turn-b",
		allowedCapabilities: [],
		status: "active",
	});
	broker.dispose();
});

test("Profile-authorized workspace writes seed every fresh task grant without widening other capabilities", async () => {
	const broker = new ToolApprovalBroker(async () => {}, 1_000, undefined, ["write"]);
	broker.beginTask(source, "turn-a");
	assert.deepEqual(broker.executionGrant(source), {
		taskId: "turn-a",
		allowedCapabilities: ["write"],
		status: "active",
	});
	assert.deepEqual(await broker.authorize({ source, toolName: "write", args: { path: "draft.md" }, policy: MUTATING_TOOL_POLICY }), { allowed: true });
	broker.beginTask(source, "turn-b");
	assert.deepEqual(broker.executionGrant(source)?.allowedCapabilities, ["write"]);
	assert.deepEqual(broker.executionGrant(source)?.allowedCapabilities.includes("bash"), false);
	broker.dispose();
});

test("Profile Task Grants accept the same namespaced capability identities as configuration", () => {
	const broker = new ToolApprovalBroker(async () => {}, 1_000, undefined, ["mcp.partner:deliver-v2"]);
	broker.beginTask(source, "turn-namespaced");
	assert.deepEqual(broker.executionGrant(source)?.allowedCapabilities, ["mcp.partner:deliver-v2"]);
	broker.dispose();
});

test("approval lifecycle exposes only redacted presenter-safe card details", async () => {
	const events = [];
	const broker = new ToolApprovalBroker(async () => {}, 1_000);
	broker.subscribe((event) => events.push(event));
	const waiting = broker.authorize({ source, toolName: "browser_fill", args: { url: "https://alice:pw@example.com/?token=secret-value", selector: "#email", password: "secret-value" }, policy: MUTATING_TOOL_POLICY });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(events[0].type, "requested");
	assert.equal(events[0].details.risk, "高");
	assert.doesNotMatch(events[0].details.target, /secret-value|alice|:pw@/);
	assert.match(events[0].details.argsSummary, /\[REDACTED\]/);
	assert.doesNotMatch(events[0].details.argsSummary, /secret-value/);
	await broker.handleReply(source, "3");
	assert.deepEqual(await waiting, { allowed: false, reason: "User denied the tool call" });
});

test("semantic approval decisions share the same policy and audit path as text replies", async () => {
	const broker = new ToolApprovalBroker(async () => {}, 1_000);
	const waiting = broker.authorize({ source, toolName: "write", args: { path: "report.md" }, policy: MUTATING_TOOL_POLICY });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(await broker.decide(source, "once"), true);
	assert.deepEqual(await waiting, { allowed: true });
});

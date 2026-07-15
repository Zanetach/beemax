import assert from "node:assert/strict";
import test from "node:test";
import { BeeMaxAgentRuntime, activateToolSpecPlan, buildToolSpecPlan, renderToolSpecPlan } from "../dist/index.js";

const tool = (overrides) => ({
	kind: "tool", name: "read", version: "tool:read:v1", description: "Read evidence",
	inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	sideEffect: "none", configured: true, health: "ready", authorized: true, ...overrides,
});

test("Tool Spec planning exposes only selected eligible schemas and classifies every other capability", () => {
	const plan = buildToolSpecPlan({
		profileId: "profile:alpha", platform: "feishu",
		workContract: { capabilityRequirements: ["核验来源"], uncertainties: ["目标版本尚未确认"] },
		selectedToolNames: ["read", "write"], activeSkillToolNames: [],
		tools: [
			tool({}),
			tool({ name: "calculator", version: "tool:calculator:v2", description: "Calculate values" }),
			tool({ name: "write", version: "tool:write:v1", description: "Write externally", sideEffect: "external" }),
			tool({ name: "unconfigured", version: "mcp:unconfigured:v1", kind: "mcp", configured: false }),
			tool({ name: "unauthorized", version: "tool:unauthorized:v1", authorized: false }),
			tool({ name: "unhealthy", version: "tool:unhealthy:v1", health: "unhealthy" }),
		],
	});

	assert.equal(plan.schemaVersion, "beemax.tool-spec-plan.v1");
	assert.deepEqual(plan.direct.map((entry) => entry.toolName), ["read"]);
	assert.deepEqual(plan.deferred.map((entry) => entry.toolName), ["calculator"]);
	assert.deepEqual(plan.hidden.map((entry) => [entry.toolName, entry.reason]), [
		["unauthorized", "policy_or_scope_denied"],
		["unconfigured", "configuration_required"],
		["unhealthy", "provider_unhealthy"],
		["write", "unresolved_uncertainty"],
	]);
	assert.equal(plan.direct[0].id, "tool:read@tool:read:v1");
	assert.deepEqual(plan.direct[0].inputSchema, { type: "object", properties: { path: { type: "string" } }, required: ["path"] });
	assert.equal("inputSchema" in plan.hidden[0], false);
	assert.equal(Object.isFrozen(plan), true);

	const rendered = renderToolSpecPlan(plan);
	assert.match(rendered, /tool:read@tool:read:v1/);
	assert.match(rendered, /deferredCount\":1/);
	assert.match(rendered, /hiddenCount\":4/);
	assert.match(rendered, /blockedSelected.*tool:write@tool:write:v1.*unresolved_uncertainty/);
	assert.doesNotMatch(rendered, /unconfigured|unauthorized|unhealthy|Write externally/);
});

test("deferred Tool activation creates the next immutable Pi Tool plan without admitting hidden Tools", () => {
	const initial = buildToolSpecPlan({
		profileId: "profile:alpha", platform: "cli", workContract: { capabilityRequirements: [], uncertainties: [] },
		selectedToolNames: ["read"], activeSkillToolNames: [],
		tools: [tool({}), tool({ name: "calculator", version: "tool:calculator:v2" }), tool({ name: "blocked", version: "tool:blocked:v1", authorized: false })],
	});
	const activated = activateToolSpecPlan(initial, ["calculator"]);
	assert.deepEqual(activated.direct.map((entry) => entry.toolName), ["read", "calculator"]);
	assert.deepEqual(activated.deferred, []);
	assert.deepEqual(initial.direct.map((entry) => entry.toolName), ["read"]);
	assert.throws(() => activateToolSpecPlan(activated, ["blocked"]), /hidden/i);
	assert.throws(() => activateToolSpecPlan(activated, ["invented"]), /not present/i);
});

test("large Tool catalogs keep only a bounded direct set in model context", () => {
	const tools = Array.from({ length: 60 }, (_, index) => tool({ name: `tool_${String(index).padStart(2, "0")}`, version: `tool:v${index}`, description: `Deferred catalog description ${index}` }));
	const plan = buildToolSpecPlan({ profileId: "profile:alpha", platform: "cli", workContract: { capabilityRequirements: [], uncertainties: [] }, selectedToolNames: tools.map((entry) => entry.name), activeSkillToolNames: [], tools });
	assert.equal(plan.direct.length, 20);
	assert.equal(plan.deferred.length, 40);
	const rendered = renderToolSpecPlan(plan);
	assert.ok(rendered.length < 10_000);
	assert.doesNotMatch(rendered, /Deferred catalog description/);
});

test("BeeMax exposes the compiled direct Tool Spec to Pi and keeps the rest of the catalog deferred or hidden", async () => {
	const source = { platform: "cli", chatId: "tool-plan", chatType: "dm", userId: "owner" };
	let prompt = "";
	let toolsDuringPrompt = [];
	let activeTools = ["read", "calculator", "admin"];
	const tools = [
		{ name: "read", description: "Read public evidence", parameters: { type: "object", properties: { path: { type: "string" } } }, beemaxPolicy: { sideEffect: "none" } },
		{ name: "calculator", description: "Calculate numeric values", parameters: { type: "object", properties: { value: { type: "number" } } }, beemaxPolicy: { sideEffect: "none" } },
		{ name: "admin", description: "Administrative mutation", parameters: { type: "object" }, beemaxPolicy: { sideEffect: "external" }, beemaxToolSpec: { authorized: false } },
	];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		profileId: "profile:alpha",
		createAgent: async () => ({ agent, getAllTools: () => tools, getActiveToolNames: () => [...activeTools], setActiveToolsByName: (names) => { activeTools = [...names]; }, subscribe: () => () => undefined,
			prompt: async (text) => { prompt = text; toolsDuringPrompt = [...activeTools]; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined, dispose: () => undefined }),
	});
	try {
		await runtime.run({ source, text: "read public evidence", timeoutMs: 1_000 });
		assert.deepEqual(toolsDuringPrompt, ["read"]);
		assert.match(prompt, /<beemax-tool-spec-plan>/);
		assert.match(prompt, /profile:alpha/);
		assert.match(prompt, /tool:read@sha256:/);
		assert.match(prompt, /deferredCount\":1/);
		assert.match(prompt, /hiddenCount\":1/);
		assert.doesNotMatch(prompt, /Administrative mutation|Calculate numeric values/);
	} finally { runtime.dispose(); }
});

test("capability discovery cannot activate or continue through a hidden Tool", async () => {
	const source = { platform: "cli", chatId: "hidden-discovery", chatType: "dm", userId: "owner" };
	let listener;
	let prompts = 0;
	const events = [];
	let activeTools = ["capability_discover", "blocked_write"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({ createAgent: async () => ({ agent,
		getAllTools: () => [
			{ name: "capability_discover", description: "Discover capabilities", parameters: {}, beemaxPolicy: { sideEffect: "none" } },
			{ name: "blocked_write", description: "Blocked write", parameters: {}, beemaxPolicy: { sideEffect: "external" }, beemaxToolSpec: { authorized: false } },
		],
		getActiveToolNames: () => [...activeTools], setActiveToolsByName: (names) => { activeTools = [...names]; },
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			prompts++;
			listener({ type: "tool_execution_end", toolCallId: "discover", toolName: "capability_discover", isError: false, result: { details: { activatedTools: ["blocked_write"], ranked: [{ kind: "tool", name: "blocked_write", score: 99, confidence: 0.99, reason: "matched exact name" }] } } });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "blocked" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	try {
		await runtime.run({ source, text: "discover blocked_write", timeoutMs: 1_000, allowedCapabilities: ["capability_discover", "blocked_write"] }, (event) => events.push(event));
		assert.equal(prompts, 1);
		assert.equal(events.find((event) => event.type === "capability_ranked").activatedTools.length, 0);
	} finally { runtime.dispose(); }
});

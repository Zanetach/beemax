import assert from "node:assert/strict";
import test from "node:test";
import { BeeMaxAgentRuntime, activateToolSpecPlan, buildToolSpecPlan, renderToolSpecPlan } from "../dist/index.js";

const createRuntime = (options) => new BeeMaxAgentRuntime({ profileId: "profile:test", ...options });

const tool = (overrides) => ({
	kind: "tool", name: "read", version: "tool:read:v1", description: "Read evidence",
	inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	sideEffect: "none", configured: true, health: "ready", authorized: true, ...overrides,
});

test("Agent Runtime composition rejects a missing trusted Profile identity", () => {
	assert.throws(() => new BeeMaxAgentRuntime({ createAgent: async () => undefined }), /Trusted Profile identity/i);
	assert.throws(() => new BeeMaxAgentRuntime({ profileId: "x".repeat(257), createAgent: async () => undefined }), /256 characters/i);
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

test("activation deterministically replaces the lowest-priority direct Tools when the turn window is full", () => {
	const tools = Array.from({ length: 22 }, (_, index) => tool({ name: `tool_${String(index).padStart(2, "0")}`, version: `tool:v${index}` }));
	const initial = buildToolSpecPlan({ profileId: "profile:alpha", platform: "cli", workContract: { capabilityRequirements: [], uncertainties: [] }, selectedToolNames: tools.slice(0, 20).map((entry) => entry.name), activeSkillToolNames: [], tools });
	const activated = activateToolSpecPlan(initial, ["tool_20", "tool_21"]);
	assert.deepEqual(activated.direct.slice(0, 2).map((entry) => entry.toolName), ["tool_20", "tool_21"]);
	assert.equal(activated.direct.length, 20);
	assert.deepEqual(activated.deferred.map((entry) => entry.toolName), ["tool_18", "tool_19"]);
});

test("Tool Spec inventory summarizes schemas beyond the cumulative direct-plan budget without rejecting the Turn", () => {
	const tools = Array.from({ length: 20 }, (_, index) => tool({ name: `large_${index}`, version: `tool:v${index}`, inputSchema: { type: "object", description: "x".repeat(40_000) } }));
	const plan = buildToolSpecPlan({ profileId: "profile:alpha", platform: "cli", workContract: { capabilityRequirements: [], uncertainties: [] }, selectedToolNames: tools.map((entry) => entry.name), activeSkillToolNames: [], tools });
	assert.equal(plan.direct.length, 20);
	assert.ok(plan.direct.some((entry) => entry.inputSchema === undefined));
	assert.ok(plan.direct.reduce((bytes, entry) => bytes + (entry.inputSchema ? Buffer.byteLength(JSON.stringify(entry.inputSchema)) : 0), 0) <= 512 * 1024);
});

test("native and MCP Tool identifiers use one activation grammar", () => {
	const name = "mcp.partner:deliver-v2";
	const initial = buildToolSpecPlan({ profileId: "profile:alpha", platform: "cli", workContract: { capabilityRequirements: [], uncertainties: [] }, selectedToolNames: [], activeSkillToolNames: [], tools: [tool({ kind: "mcp", name, version: "mcp:v1" })] });
	assert.deepEqual(activateToolSpecPlan(initial, [name]).direct.map((entry) => entry.toolName), [name]);
});

test("activation batches larger than the direct window keep overflow Tools deferred", () => {
	const tools = Array.from({ length: 25 }, (_, index) => tool({ name: `batch_${index}`, version: `tool:v${index}` }));
	const initial = buildToolSpecPlan({ profileId: "profile:alpha", platform: "cli", workContract: { capabilityRequirements: [], uncertainties: [] }, selectedToolNames: tools.slice(0, 5).map((entry) => entry.name), activeSkillToolNames: [], tools });
	const activated = activateToolSpecPlan(initial, tools.map((entry) => entry.name));
	assert.equal(activated.direct.length, 20);
	assert.equal(activated.deferred.length, 5);
	assert.equal(new Set([...activated.direct, ...activated.deferred].map((entry) => entry.toolName)).size, 25);
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
	const runtime = createRuntime({
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
	const runtime = createRuntime({ profileId: "profile:alpha", createAgent: async () => ({ agent,
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

test("a non-empty Tool catalog fails closed when Pi cannot change the model-visible active Tool set", async () => {
	const source = { platform: "cli", chatId: "legacy-tools", chatType: "dm", userId: "owner" };
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ profileId: "profile:alpha", createAgent: async () => ({ agent, getAllTools: () => [{ name: "read", description: "Read", parameters: {}, beemaxPolicy: { sideEffect: "none" } }], subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined }) });
	try { await assert.rejects(runtime.run({ source, text: "read", timeoutMs: 1_000 }), /turn-scoped Tool activation/i); }
	finally { runtime.dispose(); }
});

test("unresolved authoritative Task Effects hide the matching mutating Tool from the next Pi plan", async () => {
	const source = { platform: "cli", chatId: "effect-plan", chatType: "dm", userId: "owner", delegatedTask: { id: "task:1", ownerKey: "profile-owner:alpha" } };
	let prompt = "";
	let activeTools = ["deliver"];
	let toolsDuringPrompt = [];
	let queriedOwner = "";
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		profileId: "profile:alpha",
		toolEffectProjectionReader: { taskProjection: ({ ownerKey }) => { queriedOwner = ownerKey; return [{ id: "effect:1", taskRunId: "run:1", tool: "deliver", status: "unknown", occurredAt: 1 }]; } },
		createAgent: async () => ({ agent, getAllTools: () => [{ name: "deliver", description: "Deliver", parameters: {}, beemaxPolicy: { sideEffect: "external" } }], getActiveToolNames: () => [...activeTools], setActiveToolsByName: (names) => { activeTools = [...names]; }, subscribe: () => () => undefined, prompt: async (text) => { prompt = text; toolsDuringPrompt = [...activeTools]; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "blocked" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }),
	});
	try {
		await runtime.run({ source, text: "deliver", timeoutMs: 1_000, executionEnvelope: { schemaVersion: "beemax.execution-envelope.v1", executionId: "execution:1", trigger: { kind: "delegation" }, taskId: "task:1", taskRunId: "run:1", mode: "normal" } });
		assert.deepEqual(toolsDuringPrompt, []);
		assert.equal(queriedOwner, "profile-owner:alpha");
		assert.match(prompt, /effect_reconciliation_required/);
	} finally { runtime.dispose(); }
});

test("Skill route activation enters the Tool Spec Plan before the next Pi sample", async () => {
	const source = { platform: "cli", chatId: "skill-route-plan", chatType: "dm", userId: "owner" };
	let listener;
	let activeTools = ["skill_route", "route_tool"];
	let routeBoundary;
	let transitionContext = "";
	const version = `sha256:${"c".repeat(64)}`;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover Skill", parameters: {}, beemaxPolicy: { sideEffect: "none" }, beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:route", candidates: [{ kind: "skill", name: "route-skill", version, confidence: 0.98 }], activatedTools: ["skill_activate", "skill_read"], skills: [{ name: "route-skill" }] }) },
		{ name: "skill_activate", description: "Activate Skill", parameters: {}, beemaxPolicy: { sideEffect: "none" } },
		{ name: "skill_read", description: "Read Skill", parameters: {}, beemaxPolicy: { sideEffect: "none" } },
		{ name: "skill_route", description: "Route Skill", parameters: {}, beemaxPolicy: { sideEffect: "none" } },
		{ name: "skill_resource_read", description: "Read Skill resource", parameters: {}, beemaxPolicy: { sideEffect: "none" } },
		{ name: "skill_complete", description: "Complete Skill", parameters: {}, beemaxPolicy: { sideEffect: "none" } },
		{ name: "route_tool", description: "Execute declared route", parameters: {}, beemaxPolicy: { sideEffect: "none" } },
	];
	const runtime = createRuntime({ createAgent: async () => ({ agent, getAllTools: () => tools, getActiveToolNames: () => [...activeTools], setActiveToolsByName: (names) => { activeTools = [...names]; }, subscribe: (next) => { listener = next; return () => undefined; }, prompt: async () => {
		listener({ type: "tool_execution_end", toolCallId: "activate:1", toolName: "skill_activate", isError: false, result: { details: { skill: "route-skill", activatedTools: ["skill_route", "skill_complete"], skillLifecycleReceipt: { id: "receipt:activate", name: "route-skill", version, phase: "activated", sourceTool: "skill_activate" } } } });
		listener({ type: "tool_execution_end", toolCallId: "route:1", toolName: "skill_route", isError: false, result: { details: { skill: "route-skill", tools: ["route_tool"], activatedTools: ["skill_resource_read", "skill_complete", "route_tool"], skillLifecycleReceipt: { id: "receipt:route", name: "route-skill", version, phase: "routed", sourceTool: "skill_route" } } } });
		transitionContext = agent.state.messages.filter((message) => message.role === "custom" && message.customType === "beemax-tool-spec-transition").at(-1)?.content ?? "";
		listener({ type: "message_end", message: { role: "assistant", responseId: "response:route-tool", content: [{ type: "toolCall", id: "route-tool:1", name: "route_tool", arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
		routeBoundary = await agent.beforeToolCall({ toolCall: { id: "route-tool:1", name: "route_tool", arguments: {} } }, new AbortController().signal);
		listener({ type: "tool_execution_end", toolCallId: "complete:1", toolName: "skill_complete", isError: false, result: { details: { skill: "route-skill", skillLifecycleReceipt: { id: "receipt:complete", name: "route-skill", version, phase: "completed", sourceTool: "skill_complete" }, capabilityReceipt: { id: "receipt:skill", kind: "skill", name: "route-skill", version, sourceTool: "skill_complete" } } } });
		agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
	}, abort: async () => undefined, dispose: () => undefined }) });
	try {
		await runtime.run({ source, text: "use skill_route", timeoutMs: 1_000 });
		assert.equal(routeBoundary?.block, undefined);
		assert.match(transitionContext, /route_tool/);
		assert.match(transitionContext, /tool-plan:sha256:/);
	} finally { runtime.dispose(); }
});

test("Skill route activation cannot expose a Tool absent from the declared route", async () => {
	const source = { platform: "cli", chatId: "skill-route-undeclared", chatType: "dm", userId: "owner" };
	let listener;
	let routeBoundary;
	let activeTools = ["skill_route", "route_tool"];
	const version = `sha256:${"d".repeat(64)}`;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover Skill", parameters: {}, beemaxPolicy: { sideEffect: "none" }, beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:undeclared", candidates: [{ kind: "skill", name: "route-skill", version, confidence: 0.98 }], activatedTools: ["skill_activate"], skills: [{ name: "route-skill" }] }) },
		...['skill_activate', 'skill_read', 'skill_route', 'skill_resource_read', 'skill_complete'].map((name) => ({ name, description: name, parameters: {}, beemaxPolicy: { sideEffect: "none" } })),
		{ name: "route_tool", description: "Undeclared route Tool", parameters: {}, beemaxPolicy: { sideEffect: "none" } },
	];
	const runtime = createRuntime({ createAgent: async () => ({ agent, getAllTools: () => tools, getActiveToolNames: () => [...activeTools], setActiveToolsByName: (names) => { activeTools = [...names]; }, subscribe: (next) => { listener = next; return () => undefined; }, prompt: async () => {
		listener({ type: "tool_execution_end", toolCallId: "activate", toolName: "skill_activate", isError: false, result: { details: { skill: "route-skill", activatedTools: ["skill_route"], skillLifecycleReceipt: { id: "receipt:activate", name: "route-skill", version, phase: "activated", sourceTool: "skill_activate" } } } });
		listener({ type: "tool_execution_end", toolCallId: "route", toolName: "skill_route", isError: false, result: { details: { skill: "route-skill", tools: [], activatedTools: ["route_tool", "skill_complete"], skillLifecycleReceipt: { id: "receipt:route", name: "route-skill", version, phase: "routed", sourceTool: "skill_route" } } } });
		listener({ type: "message_end", message: { role: "assistant", responseId: "response:undeclared", content: [{ type: "toolCall", id: "route-tool", name: "route_tool", arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
		routeBoundary = await agent.beforeToolCall({ toolCall: { id: "route-tool", name: "route_tool", arguments: {} } }, new AbortController().signal);
		listener({ type: "tool_execution_end", toolCallId: "complete", toolName: "skill_complete", isError: false, result: { details: { skill: "route-skill", skillLifecycleReceipt: { id: "receipt:complete", name: "route-skill", version, phase: "completed", sourceTool: "skill_complete" }, capabilityReceipt: { id: "receipt:skill", kind: "skill", name: "route-skill", version, sourceTool: "skill_complete" } } } });
		agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
	}, abort: async () => undefined, dispose: () => undefined }) });
	try {
		await runtime.run({ source, text: "Use the route Skill", timeoutMs: 1_000 });
		assert.equal(routeBoundary?.block, true);
		assert.match(routeBoundary?.reason ?? "", /not direct/i);
	} finally { runtime.dispose(); }
});

test("dynamic Provider health hides an unavailable discovery candidate before activation", async () => {
	const source = { platform: "cli", chatId: "provider-plan", chatType: "dm", userId: "owner" };
	let listener;
	let activeTools = ["capability_discover", "remote_tool"];
	let toolsAfterDiscovery = [];
	const events = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ createAgent: async () => ({ agent, getAllTools: () => [
		{ name: "capability_discover", description: "Discover capabilities", parameters: {}, beemaxPolicy: { sideEffect: "none" } },
		{ name: "remote_tool", description: "Remote capability", parameters: {}, beemaxPolicy: { sideEffect: "none" } },
	], getActiveToolNames: () => [...activeTools], setActiveToolsByName: (names) => { activeTools = [...names]; }, subscribe: (next) => { listener = next; return () => undefined; }, prompt: async () => {
		listener({ type: "tool_execution_end", toolCallId: "discover:1", toolName: "capability_discover", isError: false, result: { details: { activatedTools: ["remote_tool"], providerResolutions: [{ capability: "remote_tool", status: "blocked", blocker: { code: "provider_unhealthy" } }] } } });
		toolsAfterDiscovery = [...activeTools];
		agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "blocked" }], usage: { input: 1, output: 1 } }];
	}, abort: async () => undefined, dispose: () => undefined }) });
	try {
		await runtime.run({ source, text: "使用 capability_discover 查找 remote_tool", timeoutMs: 1_000 }, (event) => events.push(event));
		assert.equal(toolsAfterDiscovery.includes("remote_tool"), false);
		assert.deepEqual(events.find((event) => event.type === "capability_ranked")?.activatedTools, []);
	} finally { runtime.dispose(); }
});

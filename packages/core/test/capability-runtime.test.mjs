import assert from "node:assert/strict";
import test from "node:test";
import {
	CapabilityRuntime,
	LexicalCapabilityRanker,
	ModelBackedSemanticCapabilityPort,
	PiSemanticCapabilityPort,
	ProgressiveCapabilityRanker,
	SEMANTIC_CAPABILITY_SYSTEM_PROMPT,
	SemanticCapabilityRanker,
	capabilityDescriptor,
	capabilityVersionOf,
} from "../dist/index.js";

const inventory = [
	capabilityDescriptor({ kind: "tool", name: "web_search", description: "Search public evidence", aliases: ["查找公开证据"], version: "tool:web-search:v1", activeTools: ["web_search"] }),
	capabilityDescriptor({ kind: "mcp", name: "mcp_calendar_list", description: "List calendar meetings", aliases: ["查询会议"], version: "mcp:calendar:v3", activeTools: ["mcp_calendar_list"] }),
	capabilityDescriptor({ kind: "skill", name: "source-review", description: "Review claims against sources", aliases: ["来源审查"], version: "sha256:abc123", activeTools: ["skill_activate", "skill_read"] }),
];

test("lexical and semantic Capability rankers return one candidate shape with explanations", async () => {
	const lexical = await new CapabilityRuntime({ ranker: new LexicalCapabilityRanker() }).discover({ query: "查找公开证据", inventory, limit: 5 });
	const semantic = await new CapabilityRuntime({ ranker: new SemanticCapabilityRanker({
		async similarities() { return [{ name: "web_search", similarity: 0.93, signals: ["public evidence intent"] }]; },
	}) }).discover({ query: "investigate material using primary sources", inventory, limit: 5 });
	for (const selection of [lexical, semantic]) {
		assert.deepEqual(Object.keys(selection).sort(), ["activatedTools", "candidates", "cognitionId", "query"]);
		assert.deepEqual(Object.keys(selection.candidates[0]).sort(), ["confidence", "explanation", "kind", "name", "score", "version"]);
		assert.deepEqual(Object.keys(selection.candidates[0].explanation).sort(), ["signals", "strategy", "summary"]);
		assert.equal(selection.candidates[0].name, "web_search");
		assert.equal(selection.candidates[0].version, "tool:web-search:v1");
	}
	assert.equal(lexical.candidates[0].explanation.strategy, "lexical");
	assert.equal(semantic.candidates[0].explanation.strategy, "semantic");
});

test("Capability selection carries one content-free cognition identity through model usage", async () => {
	let receivedCognitionId;
	const usage = [];
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "correlated" } }], maxModelAttempts: 1, onUsage(event) { usage.push(event); },
		complete: async (_model, context) => {
			const payload = JSON.parse(context.messages[0].content);
			return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches: [{ id: payload.candidates[0].id, name: payload.candidates[0].name, similarity: 0.9 }] }) }] };
		},
	});
	const ranker = new SemanticCapabilityRanker({ async similarities(input) { receivedCognitionId = input.cognitionId; return port.similarities(input); } });
	const selection = await new CapabilityRuntime({ ranker }).discover({ query: "known", inventory: [capabilityDescriptor({ kind: "tool", name: "known", version: "1", activeTools: ["known"] })], cognitionId: "cap:test-correlation" });
	assert.equal(selection.cognitionId, "cap:test-correlation");
	assert.equal(receivedCognitionId, "cap:test-correlation");
	assert.equal(usage[0].cognitionId, "cap:test-correlation");
});

test("semantic capability cognition defaults to a compact decision output budget", async () => {
	let observedMaxTokens;
	let observedReasoning;
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "compact-default" } }],
		maxModelAttempts: 1,
		complete: async (_model, context, options) => {
			observedMaxTokens = options.maxTokens;
			observedReasoning = options.reasoning;
			const payload = JSON.parse(context.messages[0].content);
			return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches: [{ id: payload.candidates[0].id, name: payload.candidates[0].name, similarity: 0.9 }] }) }] };
		},
	});
	await port.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 });
	assert.equal(observedMaxTokens, 512);
	assert.equal(observedReasoning, undefined, "bounded routing should disable Provider thinking");
});

test("Capability discovery changes execution only through Pi active tools", async () => {
	const activations = [];
	const runtime = new CapabilityRuntime({ ranker: new LexicalCapabilityRanker(), activeTools: { setActiveTools(names) { activations.push(names); } } });
	const selection = await runtime.discover({ query: "来源审查", inventory, limit: 1 });
	assert.deepEqual(selection.activatedTools, ["skill_activate", "skill_read"]);
	assert.deepEqual(activations, [["skill_activate", "skill_read"]]);
	assert.equal("execute" in selection.candidates[0], false);
});

test("Capability discovery does not activate a Tool from one weak description-word collision", async () => {
	const activations = [];
	const weakInventory = [capabilityDescriptor({ kind: "mcp", name: "activate_workflow", description: "Activate a pinned research workflow", version: "mcp:workflow:v1", activeTools: ["activate_workflow"] })];
	const runtime = new CapabilityRuntime({ activeTools: { setActiveTools(names) { activations.push(names); } } });
	const selection = await runtime.discover({ query: "research current public information", inventory: weakInventory });
	assert.deepEqual(selection.candidates, []);
	assert.deepEqual(selection.activatedTools, []);
	assert.deepEqual(activations, [[]]);
});

test("semantic no-match remains empty instead of forcing a lexical substitute", async () => {
	const runtime = new CapabilityRuntime({ ranker: new SemanticCapabilityRanker({
		async similarities() { return []; },
	}, { fallback: new LexicalCapabilityRanker() }) });
	const selection = await runtime.discover({ query: "research current public information", inventory: [
		capabilityDescriptor({ kind: "mcp", name: "activate_workflow", description: "Activate a pinned research workflow", version: "1", activeTools: ["activate_workflow"] }),
	] });
	assert.deepEqual(selection.candidates, []);
	assert.deepEqual(selection.activatedTools, []);
});

test("semantic ranking falls back to bounded lexical recall only when its provider is unavailable", async () => {
	const fallbacks = [];
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "offline" } }],
		complete: async () => { const error = new Error("https://user:secret@example.invalid/provider"); error.code = "ECONNREFUSED"; throw error; },
	});
	const runtime = new CapabilityRuntime({ ranker: new SemanticCapabilityRanker(port, { fallback: new LexicalCapabilityRanker(), onFallback(event) { fallbacks.push(event); } }) });
	const selection = await runtime.discover({ query: "查找公开证据", inventory, limit: 2 });
	assert.equal(selection.candidates[0].name, "web_search");
	assert.equal(selection.candidates[0].explanation.strategy, "lexical");
	assert.match(selection.candidates[0].explanation.summary, /semantic provider unavailable/u);
	assert.equal(JSON.stringify(selection).includes("secret"), false);
	assert.equal(fallbacks.length, 1);
	assert.deepEqual({ query: fallbacks[0].query, code: fallbacks[0].code }, { query: "查找公开证据", code: "provider_unavailable" });
	assert.match(fallbacks[0].cognitionId, /^cap:/u);
});

test("semantic ranking recognizes a typed Undici timeout through the Provider cause chain", async () => {
	let fallbackCalled = false;
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "offline-fetch" } }], maxModelAttempts: 1,
		complete: async () => { throw new Error("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }); },
	});
	const ranker = new SemanticCapabilityRanker(port, { fallback: { async rank() { fallbackCalled = true; return []; } } });
	await ranker.rank("known", [capabilityDescriptor({ kind: "tool", name: "known", version: "1", activeTools: ["known"] })], 1);
	assert.equal(fallbackCalled, true);
});

test("semantic ranking fails closed on authentication, request, and adapter programming errors", async () => {
	for (const providerError of [Object.assign(new Error("auth secret"), { status: 401 }), Object.assign(new Error("bad request"), { statusCode: 400 }), new Error("adapter invariant failed")]) {
		let fallbackCalled = false;
		const port = new PiSemanticCapabilityPort({ models: [{ model: { id: "broken" } }], maxModelAttempts: 1, complete: async () => { throw providerError; } });
		const ranker = new SemanticCapabilityRanker(port, { fallback: { async rank() { fallbackCalled = true; return []; } } });
		await assert.rejects(() => ranker.rank("known", [capabilityDescriptor({ kind: "tool", name: "known", version: "1", activeTools: ["known"] })], 1), /provider_error/u);
		assert.equal(fallbackCalled, false);
	}
});

test("an invalid semantic result fails closed even when a later Provider is unavailable", async () => {
	let calls = 0;
	let fallbackCalled = false;
	const fallbacks = [];
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "invalid" } }, { model: { id: "offline" } }],
		complete: async () => {
			calls++;
			if (calls === 1) return { stopReason: "stop", content: [{ type: "text", text: "not-json" }] };
			throw Object.assign(new Error("offline"), { code: "ECONNRESET" });
		},
	});
	const ranker = new SemanticCapabilityRanker(port, { fallback: { async rank() { fallbackCalled = true; return []; } }, onFallback(event) { fallbacks.push(event); } });
	await assert.rejects(
		() => ranker.rank("known", [capabilityDescriptor({ kind: "tool", name: "known", version: "1", activeTools: ["known"] })], 1),
		/invalid_json/u,
	);
	assert.equal(fallbackCalled, false);
	assert.deepEqual(fallbacks, []);
});

test("semantic ranking never turns invalid model output into lexical authority", async () => {
	const fallbacks = [];
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "invalid" } }],
		complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches: [{ name: "invented", similarity: 0.99 }] }) }] }),
	});
	const runtime = new CapabilityRuntime({ ranker: new SemanticCapabilityRanker(port, {
		fallback: new LexicalCapabilityRanker(),
		onFallback(event) { fallbacks.push(event); },
	}) });
	await assert.rejects(() => runtime.discover({
		query: "known",
		inventory: [capabilityDescriptor({ kind: "tool", name: "known", version: "1", activeTools: ["known"] })],
		limit: 1,
	}), /invalid_response/u);
	assert.deepEqual(fallbacks, []);
});

test("Provider-unavailable repair binds exact Core requirement ids independently", async () => {
	const requirements = [
		{ id: "capreq:0:aaaaaaaa", text: "使用多个实时公开来源" },
		{ id: "capreq:1:bbbbbbbb", text: "检查 HTML 内容与渲染" },
	];
	const liveSources = capabilityDescriptor({
		kind: "tool", name: "live_sources", version: "1", activeTools: ["live_sources"],
		triggers: ["实时公开来源"], description: "Retrieve current public evidence",
	});
	const inspectHtml = capabilityDescriptor({
		kind: "tool", name: "inspect_html", version: "1", activeTools: ["inspect_html"],
		triggers: ["检查 html"], description: "Inspect an existing HTML artifact",
	});
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "offline" } }], maxModelAttempts: 1,
		complete: async () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); },
	});
	const selection = await new CapabilityRuntime({
		ranker: new SemanticCapabilityRanker(port, { fallback: new LexicalCapabilityRanker() }),
	}).discover({ query: requirements.map(({ text }) => text).join("\n"), requirements, inventory: [liveSources, inspectHtml] });
	assert.deepEqual(selection.candidates.map(({ name, requirementId, outcomeIndex, necessity }) => ({ name, requirementId, outcomeIndex, necessity })), [
		{ name: "live_sources", requirementId: requirements[0].id, outcomeIndex: 0, necessity: "required" },
		{ name: "inspect_html", requirementId: requirements[1].id, outcomeIndex: 0, necessity: "required" },
	]);
	assert.deepEqual(selection.activatedTools, ["inspect_html", "live_sources"]);
});

test("deterministic requirement repair fails closed on weak lexical overlap", async () => {
	const requirement = { id: "capreq:0:aaaaaaaa", text: "所有关键事实附来源 URL" };
	const selection = await new CapabilityRuntime({ ranker: new LexicalCapabilityRanker() }).discover({
		query: requirement.text,
		requirements: [requirement],
		inventory: [capabilityDescriptor({ kind: "tool", name: "generic_sources", description: "Review sources", version: "1", activeTools: ["generic_sources"] })],
	});
	assert.deepEqual(selection.candidates, []);
	assert.deepEqual(selection.activatedTools, []);
});

test("progressive capability ranking skips semantic cognition when exact metadata covers every Contract requirement", async () => {
	let semanticCalls = 0;
	const requirements = [
		{ id: "capreq:0:aaaaaaaa", text: "retrieve current market series" },
		{ id: "capreq:1:bbbbbbbb", text: "render the final PDF artifact" },
	];
	const ranker = new ProgressiveCapabilityRanker(
		new LexicalCapabilityRanker(),
		{ async rank() { semanticCalls++; return []; } },
	);
	const selection = await new CapabilityRuntime({ ranker }).discover({
		query: requirements.map(({ text }) => text).join("\n"),
		requirements,
		inventory: [
			capabilityDescriptor({ kind: "tool", name: "market_series", description: "Retrieve current market series", triggers: ["current market series"], version: "1", activeTools: ["market_series"] }),
			capabilityDescriptor({ kind: "tool", name: "artifact_render", description: "Render the final PDF artifact", triggers: ["render the final pdf artifact"], version: "1", activeTools: ["artifact_render"] }),
		],
	});
	assert.equal(semanticCalls, 0);
	assert.deepEqual(selection.candidates.map(({ name, requirementId }) => ({ name, requirementId })), [
		{ name: "market_series", requirementId: requirements[0].id },
		{ name: "artifact_render", requirementId: requirements[1].id },
	]);
});

test("progressive Contract routing retains one best task-level Skill after exact Tools cover every requirement", async () => {
	const requirements = [{ id: "capreq:0:aaaaaaaa", text: "retrieve current market series" }];
	let semanticCalls = 0;
	const selection = await new CapabilityRuntime({
		ranker: new ProgressiveCapabilityRanker(
			new LexicalCapabilityRanker(),
			{ async rank() { semanticCalls++; return []; } },
		),
	}).discover({
		query: "Use existing research to prepare a business report from the current market series",
		requirements,
		inventory: [
			capabilityDescriptor({ kind: "tool", name: "market_series", description: "Retrieve current market series", triggers: ["current market series"], version: "1", activeTools: ["market_series"] }),
			capabilityDescriptor({ kind: "skill", name: "business-report", description: "Prepare a structured business report", triggers: ["business report"], version: "1", activeTools: ["skill_read"] }),
			capabilityDescriptor({ kind: "skill", name: "research-and-brief", description: "Research and prepare a brief", triggers: ["research"], exclude: ["use existing research"], version: "1", activeTools: ["skill_read"] }),
		],
	});
	assert.equal(semanticCalls, 0);
	assert.deepEqual(selection.candidates.map(({ kind, name, requirementId }) => ({ kind, name, requirementId })), [
		{ kind: "tool", name: "market_series", requirementId: requirements[0].id },
		{ kind: "skill", name: "business-report", requirementId: undefined },
	]);
});

test("progressive capability ranking sends only lexically unresolved Contract requirements to semantic cognition", async () => {
	const requirements = [
		{ id: "capreq:0:aaaaaaaa", text: "retrieve current market series" },
		{ id: "capreq:1:bbbbbbbb", text: "reconcile disputed evidence" },
	];
	let receivedRequirements;
	const semanticDescriptor = capabilityDescriptor({ kind: "skill", name: "evidence-reconciliation", description: "Resolve conflicting claims", version: "1", activeTools: ["skill_read"] });
	const ranker = new ProgressiveCapabilityRanker(
		new LexicalCapabilityRanker(),
		{ async rank(_query, _inventory, _limit, _signal, context) {
			receivedRequirements = context.requirements;
			return [{
				descriptor: semanticDescriptor,
				score: 95,
				confidence: 0.95,
				explanation: { strategy: "semantic", summary: "semantic match", signals: ["semantic match"] },
				requirementId: requirements[1].id,
				outcomeIndex: 0,
				necessity: "required",
			}];
		} },
	);
	const selection = await new CapabilityRuntime({ ranker }).discover({
		query: requirements.map(({ text }) => text).join("\n"),
		requirements,
		inventory: [
			capabilityDescriptor({ kind: "tool", name: "market_series", description: "Retrieve current market series", triggers: ["current market series"], version: "1", activeTools: ["market_series"] }),
			semanticDescriptor,
		],
	});
	assert.deepEqual(receivedRequirements, [requirements[1]]);
	assert.deepEqual(selection.candidates.map(({ name, requirementId }) => ({ name, requirementId })), [
		{ name: "market_series", requirementId: requirements[0].id },
		{ name: "evidence-reconciliation", requirementId: requirements[1].id },
	]);
});

test("progressive capability ranking skips semantic cognition for strong unbound metadata matches", async () => {
	let semanticCalls = 0;
	const selection = await new CapabilityRuntime({
		ranker: new ProgressiveCapabilityRanker(
			new LexicalCapabilityRanker(),
			{ async rank() { semanticCalls++; return []; } },
		),
	}).discover({
		query: "研究本周黄金走势并交叉验证公开来源",
		inventory: [
			capabilityDescriptor({ kind: "skill", name: "research-and-brief", description: "Produce a sourced brief", triggers: ["研究"], version: "1", activeTools: ["skill_read"] }),
			capabilityDescriptor({ kind: "tool", name: "exa_web_search", description: "Search public evidence", triggers: ["交叉验证"], version: "1", activeTools: ["exa_web_search"] }),
			capabilityDescriptor({ kind: "tool", name: "generic_report", description: "Write a generic report", version: "1", activeTools: ["generic_report"] }),
		],
	});
	assert.equal(semanticCalls, 0);
	assert.deepEqual(selection.candidates.map(({ name }) => name), ["exa_web_search", "research-and-brief"]);
	assert.ok(selection.candidates.every(({ confidence }) => confidence >= 0.75));
});

test("progressive capability ranking does not treat a canonical name inside a larger token as exact metadata", async () => {
	const query = "必须调用 web_search 搜索 Thruvera-Agent GitHub";
	const capabilities = [
		capabilityDescriptor({ kind: "tool", name: "web_search", description: "Search current public information", version: "1", activeTools: ["web_search"] }),
		capabilityDescriptor({ kind: "skill", name: "hub", description: "Read web_search results aloud with VoxFlow voices", version: "1", activeTools: ["skill_activate"] }),
	];
	const hubRecall = (await new LexicalCapabilityRanker().rank(query, capabilities, 10)).find(({ descriptor }) => descriptor.name === "hub");
	assert.ok(hubRecall, "description overlap should keep hub available for weak semantic recall");
	assert.ok(hubRecall.confidence < 0.2, "GitHub must not add canonical-name authority to hub");
	let semanticCalls = 0;
	const selection = await new CapabilityRuntime({
		ranker: new ProgressiveCapabilityRanker(
			new LexicalCapabilityRanker(),
			{ async rank() { semanticCalls++; return []; } },
		),
	}).discover({ query, inventory: capabilities });
	assert.equal(semanticCalls, 0);
	assert.deepEqual(selection.candidates.map(({ name }) => name), ["web_search"]);
});

test("progressive capability ranking still admits an independently named canonical capability", async () => {
	let semanticCalls = 0;
	const selection = await new CapabilityRuntime({
		ranker: new ProgressiveCapabilityRanker(
			new LexicalCapabilityRanker(),
			{ async rank() { semanticCalls++; return []; } },
		),
	}).discover({
		query: "Use hub to read text aloud",
		inventory: [
			capabilityDescriptor({ kind: "skill", name: "hub", description: "Read text aloud with VoxFlow voices", version: "1", activeTools: ["skill_activate"] }),
		],
	});
	assert.equal(semanticCalls, 0);
	assert.deepEqual(selection.candidates.map(({ name, confidence }) => ({ name, confidence })), [{ name: "hub", confidence: 0.99 }]);
});

test("progressive capability ranking keeps semantic cognition for weak unbound lexical overlap", async () => {
	let semanticCalls = 0;
	const semanticDescriptor = capabilityDescriptor({ kind: "tool", name: "trusted_route", description: "Resolve an ambiguous objective", version: "1", activeTools: ["trusted_route"] });
	const ranked = await new ProgressiveCapabilityRanker(
		new LexicalCapabilityRanker(),
		{ async rank() {
			semanticCalls++;
			return [{ descriptor: semanticDescriptor, score: 90, confidence: 0.9, explanation: { strategy: "semantic", summary: "resolved ambiguity", signals: ["resolved ambiguity"] } }];
		} },
	).rank("prepare a generic objective", [
		capabilityDescriptor({ kind: "tool", name: "weak_generic", description: "A generic workflow", version: "1", activeTools: ["weak_generic"] }),
		semanticDescriptor,
	], 5);
	assert.equal(semanticCalls, 1);
	assert.equal(ranked[0].descriptor.name, "trusted_route");
});

test("progressive capability ranking does not turn many description terms into exact metadata authority", async () => {
	let semanticCalls = 0;
	const semanticDescriptor = capabilityDescriptor({ kind: "skill", name: "verified_report_route", description: "Resolve the workflow semantically", version: "1", activeTools: ["skill_read"] });
	const query = "prepare detailed ordinary quarterly report tables charts sources analysis metrics narrative evidence summary";
	const ranked = await new ProgressiveCapabilityRanker(
		new LexicalCapabilityRanker(),
		{ async rank() {
			semanticCalls++;
			return [{ descriptor: semanticDescriptor, score: 91, confidence: 0.91, explanation: { strategy: "semantic", summary: "semantic route", signals: ["semantic route"] } }];
		} },
	).rank(query, [
		capabilityDescriptor({ kind: "skill", name: "generic_overlap", description: query, version: "1", activeTools: ["skill_read"] }),
		semanticDescriptor,
	], 5);
	assert.equal(semanticCalls, 1);
	assert.equal(ranked[0].descriptor.name, "verified_report_route");
});

test("Provider-unavailable fallback admits only explicit local metadata, not description overlap", async () => {
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "offline" } }], maxModelAttempts: 1,
		complete: async () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); },
	});
	const query = "prepare detailed ordinary quarterly report tables charts sources analysis metrics narrative evidence summary";
	const selection = await new CapabilityRuntime({ ranker: new SemanticCapabilityRanker(port, { fallback: new LexicalCapabilityRanker() }) }).discover({
		query,
		inventory: [capabilityDescriptor({ kind: "skill", name: "generic_overlap", description: query, version: "1", activeTools: ["skill_read"] })],
	});
	assert.deepEqual(selection.candidates, []);
	assert.deepEqual(selection.activatedTools, []);
});

test("model-backed semantic selection receives generic operational signals and validates model output", async () => {
	let request;
	const port = new ModelBackedSemanticCapabilityPort(async (input) => {
		request = input;
		return { matches: [
			{ name: "live_sources", similarity: 0.91, signals: ["meaning", "freshness:realtime", "health:ready"] },
		] };
	});
	const descriptor = capabilityDescriptor({
		kind: "tool", name: "live_sources", description: "Retrieve current external evidence", version: "1", activeTools: ["live_sources"],
		signals: {
			inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt",
			effect: "none", health: "ready", relativeCost: 0.3, expectedLatencyMs: 850, profilePreference: 0.8,
		},
	});
	const ranked = await new SemanticCapabilityRanker(port).rank("what changed today", [descriptor], 5);
	assert.equal(ranked.length, 1);
	assert.equal(ranked[0].descriptor.name, "live_sources");
	assert.equal(ranked[0].confidence, 0.91);
	assert.deepEqual(request.candidates[0].signals, descriptor.signals);
});

test("semantic capability obligations retain alternatives as evidence but activate only required primaries", async () => {
	const primary = capabilityDescriptor({ kind: "tool", name: "primary_search", description: "Search current evidence", version: "1", activeTools: ["primary_search"] });
	const backup = capabilityDescriptor({ kind: "tool", name: "backup_search", description: "Alternative search for current evidence", version: "1", activeTools: ["backup_search"] });
	const analyze = capabilityDescriptor({ kind: "tool", name: "analyze_data", description: "Analyze the retrieved data", version: "1", activeTools: ["analyze_data"] });
	const port = new ModelBackedSemanticCapabilityPort(async ({ candidates }) => ({ matches: [
		{ id: candidates.find((candidate) => candidate.name === "primary_search").id, name: "primary_search", similarity: 0.96, requirementId: "current-evidence", necessity: "required" },
		{ id: candidates.find((candidate) => candidate.name === "backup_search").id, name: "backup_search", similarity: 0.94, requirementId: "current-evidence", necessity: "alternative" },
		{ id: candidates.find((candidate) => candidate.name === "analyze_data").id, name: "analyze_data", similarity: 0.93, requirementId: "data-analysis", necessity: "required" },
	] }));
	const selection = await new CapabilityRuntime({ ranker: new SemanticCapabilityRanker(port) }).discover({ query: "search current evidence and analyze the data", inventory: [primary, backup, analyze], limit: 5 });
	assert.deepEqual(selection.candidates.map((candidate) => candidate.name), ["primary_search", "backup_search", "analyze_data"]);
	assert.deepEqual(selection.activatedTools, ["primary_search", "analyze_data"]);
});

test("semantic capability cognition must cover every Core-issued Work Contract requirement id", async () => {
	const search = capabilityDescriptor({ kind: "tool", name: "search", description: "Search evidence", version: "1", activeTools: ["search"] });
	const archive = capabilityDescriptor({ kind: "tool", name: "archive", description: "Archive evidence", version: "1", activeTools: ["archive"] });
	const requirements = [{ id: "capreq:0:aaaaaaaa", text: "search evidence" }, { id: "capreq:1:bbbbbbbb", text: "archive evidence" }];
	const port = new ModelBackedSemanticCapabilityPort(async ({ candidates }) => ({ matches: [{
		id: candidates.find((candidate) => candidate.name === "search").id, name: "search", similarity: 0.99,
		requirementId: requirements[0].id, outcomeIndex: 0, necessity: "required",
	}] }));
	await assert.rejects(
		() => new CapabilityRuntime({ ranker: new SemanticCapabilityRanker(port) }).discover({ query: "search and archive", requirements, inventory: [search, archive] }),
		/omitted a Work Contract requirement/i,
	);
});

test("semantic capability selection fails closed when thresholding drops one required outcome", async () => {
	const search = capabilityDescriptor({ kind: "tool", name: "search", description: "Search current evidence", triggers: ["current evidence"], version: "1", activeTools: ["search"] });
	const cite = capabilityDescriptor({ kind: "tool", name: "cite", description: "Retain source URLs", triggers: ["source URL"], version: "1", activeTools: ["cite"] });
	const requirements = [{ id: "capreq:0:aaaaaaaa", text: "current evidence" }, { id: "capreq:1:bbbbbbbb", text: "source URL" }];
	const port = new ModelBackedSemanticCapabilityPort(async ({ candidates }) => ({ matches: [
		{ id: candidates.find((candidate) => candidate.name === "search").id, name: "search", similarity: 0.95, requirementId: requirements[0].id, outcomeIndex: 0, necessity: "required" },
		{ id: candidates.find((candidate) => candidate.name === "cite").id, name: "cite", similarity: 0.7, requirementId: requirements[1].id, outcomeIndex: 0, necessity: "required" },
	] }));
	await assert.rejects(() => new CapabilityRuntime({ ranker: new SemanticCapabilityRanker(port, { fallback: new LexicalCapabilityRanker() }) }).discover({
		query: "current evidence with source URL", requirements, inventory: [search, cite],
	}), /invalid_response/u);
});

test("one Capability may retain distinct mappings to multiple Core-issued obligation groups", async () => {
	const requirements = [{ id: "capreq:0:aaaaaaaa", text: "read source" }, { id: "capreq:1:bbbbbbbb", text: "read metadata" }];
	const candidate = { id: "tool:unified_reader:1", name: "unified_reader", text: "Read source content and metadata" };
	const port = new ModelBackedSemanticCapabilityPort(async () => ({ matches: requirements.map((requirement) => ({
		id: candidate.id, name: candidate.name, similarity: 0.99,
		requirementId: requirement.id, outcomeIndex: 0, necessity: "required",
	})) }));
	const matches = await port.similarities({ query: "read source and metadata", candidates: [candidate], requirements, limit: 10 });
	assert.deepEqual(matches.map(({ requirementId }) => requirementId), requirements.map(({ id }) => id));
});

test("Contract-bound selection preserves more than ten atomic obligations and their alternatives", async () => {
	const requirements = Array.from({ length: 12 }, (_, index) => ({ id: `capreq:${index}:aaaaaaaa`, text: `outcome ${index}` }));
	const descriptors = requirements.map((_requirement, index) => capabilityDescriptor({ kind: "tool", name: `tool_${index}`, version: "1", activeTools: [`tool_${index}`] }));
	descriptors.push(capabilityDescriptor({ kind: "tool", name: "tool_0_backup", version: "1", activeTools: ["tool_0_backup"] }));
	let payload;
	const port = new PiSemanticCapabilityPort({ models: [{ model: { id: "all-obligations" } }], maxModelAttempts: 1,
		complete: async (_model, context) => {
			payload = JSON.parse(context.messages[0].content);
			return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches: [
				...requirements.map((requirement, index) => ({ id: payload.candidates[index].id, name: `tool_${index}`, similarity: 0.99, requirementId: requirement.id, outcomeIndex: 0, necessity: "required" })),
				{ id: payload.candidates.at(-1).id, name: "tool_0_backup", similarity: 0.98, requirementId: requirements[0].id, outcomeIndex: 0, necessity: "alternative" },
			] }) }] };
		},
	});
	const selection = await new CapabilityRuntime({ ranker: new SemanticCapabilityRanker(port) }).discover({
		query: "complete all outcomes", inventory: descriptors, requirements, contractDigest: "a".repeat(64), limit: 10,
	});
	assert.equal(payload.requirements.length, 12);
	assert.equal(payload.contractDigest, "a".repeat(64));
	assert.equal(selection.candidates.length, 13);
});

test("a Contract-bound atomic requirement rejects selector-invented sub-outcomes", async () => {
	const requirement = { id: "capreq:0:aaaaaaaa", text: "one atomic outcome" };
	const port = new ModelBackedSemanticCapabilityPort(async ({ candidates }) => ({ matches: [{
		id: candidates[0].id, name: candidates[0].name, similarity: 0.99,
		requirementId: requirement.id, outcomeIndex: 1, necessity: "required",
	}] }));
	await assert.rejects(() => port.similarities({ query: requirement.text, candidates: [{ id: "tool:one:1", name: "one", text: "one" }], requirements: [requirement], limit: 10 }), /invalid atomic obligation/i);
});

test("semantic selection rejects ambiguous multi-match output without obligation metadata", async () => {
	const first = capabilityDescriptor({ kind: "tool", name: "primary", description: "Primary route", version: "1", activeTools: ["primary"] });
	const backup = capabilityDescriptor({ kind: "tool", name: "backup", description: "Backup route", version: "1", activeTools: ["backup"] });
	const port = new ModelBackedSemanticCapabilityPort(async ({ candidates }) => ({ matches: candidates.map((candidate, index) => ({ id: candidate.id, name: candidate.name, similarity: 0.95 - index * 0.01 })) }));
	await assert.rejects(() => new SemanticCapabilityRanker(port).rank("use the primary route", [first, backup], 2), /invalid candidate or score/u);
});

test("model-backed semantic selection rejects invented candidates and out-of-range scores", async () => {
	const descriptor = capabilityDescriptor({ kind: "tool", name: "known", version: "1", activeTools: ["known"] });
	for (const match of [{ name: "invented", similarity: 0.9 }, { name: "known", similarity: 99 }]) {
		const port = new ModelBackedSemanticCapabilityPort(async () => ({ matches: [match] }));
		await assert.rejects(() => new SemanticCapabilityRanker(port).rank("query", [descriptor], 1), /invalid candidate or score/u);
	}
});

test("semantic ranking rejects weak model overlap below the calibrated activation floor", async () => {
	const descriptor = capabilityDescriptor({ kind: "skill", name: "generic-review", description: "Review a supplied artifact", version: "1", activeTools: ["skill_activate"] });
	const ranked = await new SemanticCapabilityRanker({ async similarities() { return [{ name: "generic-review", similarity: 0.7 }]; } }).rank("hello there", [descriptor], 5);
	assert.deepEqual(ranked, []);
});

test("semantic ranking preserves immutable Capability identity when Tool and Skill names collide", async () => {
	const tool = capabilityDescriptor({ kind: "tool", name: "review", description: "Direct review Tool", version: "tool:1", activeTools: ["review"] });
	const skill = capabilityDescriptor({ kind: "skill", name: "review", description: "Multi-step review Skill", version: "skill:1", activeTools: ["skill_activate"] });
	const port = new ModelBackedSemanticCapabilityPort(async ({ candidates }) => ({ matches: [
		{ id: candidates.find((candidate) => candidate.text.includes("Multi-step"))?.id, name: "review", similarity: 0.9 },
	] }));
	const ranked = await new SemanticCapabilityRanker(port).rank("perform the multi-step review", [tool, skill], 2);
	assert.equal(ranked.length, 1);
	assert.equal(ranked[0].descriptor.kind, "skill");
	assert.equal(ranked[0].descriptor.version, "skill:1");
});

test("cancelling semantic selection never activates the lexical fallback", async () => {
	let fallbackCalled = false;
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));
	const ranker = new SemanticCapabilityRanker({ async similarities() { throw new Error("provider stopped"); } }, { fallback: { async rank() { fallbackCalled = true; return []; } } });
	await assert.rejects(() => ranker.rank("查找公开证据", inventory, 2, controller.signal), /cancelled/u);
	assert.equal(fallbackCalled, false);
});

test("semantic model context stays within the interactive preflight window while lexical recall preserves an explicit tail match", async () => {
	let candidateCount = 0;
	const inventory = Array.from({ length: 60 }, (_, index) => capabilityDescriptor({ kind: "skill", name: `generic-${String(index).padStart(3, "0")}`, description: "A generic workflow", version: "1", activeTools: ["skill_activate"] }));
	inventory.push(capabilityDescriptor({ kind: "tool", name: "tail_match", description: "Retrieve exact lunar telemetry", aliases: ["lunar telemetry"], version: "1", activeTools: ["tail_match"] }));
	const ranker = new SemanticCapabilityRanker({ async similarities({ candidates }) {
		candidateCount = candidates.length;
		const selected = candidates.find((candidate) => candidate.name === "tail_match");
		return selected ? [{ id: selected.id, name: selected.name, similarity: 0.95 }] : [];
	} });
	const ranked = await ranker.rank("lunar telemetry", inventory, 5);
	assert.equal(candidateCount, 12);
	assert.equal(ranked[0].descriptor.name, "tail_match");
});

test("bounded semantic discovery preserves recall for every Core-issued Contract requirement", async () => {
	const requirements = [
		{ id: "capreq:0:aaaaaaaa", text: "核验精确外部来源回执" },
		{ id: "capreq:1:bbbbbbbb", text: "生成可解析页面介质" },
	];
	const inventory = Array.from({ length: 60 }, (_, index) => capabilityDescriptor({
		kind: "tool", name: `generic_${String(index).padStart(2, "0")}`, description: "Prepare an ordinary report", version: "1", activeTools: [`generic_${index}`],
	}));
	inventory.push(
		capabilityDescriptor({ kind: "tool", name: "source_attestation", description: "Verify exact external source receipts", aliases: ["核验精确外部来源回执"], version: "1", activeTools: ["source_attestation"] }),
		capabilityDescriptor({ kind: "tool", name: "page_rendition", description: "Produce a parseable page medium", aliases: ["生成可解析页面介质"], version: "1", activeTools: ["page_rendition"] }),
	);
	let providerCandidates = [];
	const runtime = new CapabilityRuntime({ ranker: new SemanticCapabilityRanker({
		async similarities({ candidates }) {
			providerCandidates = candidates.map(({ name }) => name);
			return requirements.map((requirement) => {
				const name = requirement.id.includes(":0:") ? "source_attestation" : "page_rendition";
				const candidate = candidates.find((item) => item.name === name);
				return candidate ? { id: candidate.id, name, similarity: 0.99, requirementId: requirement.id, outcomeIndex: 0, necessity: "required" } : undefined;
			}).filter(Boolean);
		},
	}) });
	const selection = await runtime.discover({ query: "prepare report", inventory, requirements, limit: 10 });
	assert.equal(providerCandidates.length, 12);
	assert.equal(providerCandidates.includes("source_attestation"), true);
	assert.equal(providerCandidates.includes("page_rendition"), true);
	assert.deepEqual(selection.candidates.map(({ name, requirementId }) => ({ name, requirementId })).sort((left, right) => left.requirementId.localeCompare(right.requirementId)), [
		{ name: "source_attestation", requirementId: requirements[0].id },
		{ name: "page_rendition", requirementId: requirements[1].id },
	]);
});

test("Pi semantic production port retries a parseable invalid response on the next bounded model", async () => {
	let calls = 0;
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "first" } }, { model: { id: "second" } }],
		maxModelAttempts: 2,
		complete: async (model) => {
			calls++;
			const text = model.id === "first"
				? JSON.stringify({ matches: [{ name: "invented", similarity: 0.9 }] })
				: JSON.stringify({ matches: [{ id: "tool:known:1", name: "known", similarity: 0.9 }] });
			return { stopReason: "stop", content: [{ type: "text", text }] };
		},
	});
	const result = await port.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 });
	assert.equal(calls, 2);
	assert.equal(result[0].name, "known");
});

test("Pi semantic production port gives one configured model a bounded repair attempt", async () => {
	let calls = 0;
	const usage = [];
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "only" } }], maxModelAttempts: 2, onUsage(event) { usage.push(event); },
		complete: async () => {
			calls++;
			const matches = calls === 1 ? [{ name: "invented", similarity: 0.9 }] : [{ id: "tool:known:1", name: "known", similarity: 0.9 }];
			return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches }) }], usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1 } };
		},
	});
	const result = await port.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 });
	assert.equal(calls, 2);
	assert.equal(result[0].name, "known");
	assert.equal(usage[0].failureCode, "invalid_response");
	assert.equal(usage[0].actualTokens, 16);
	assert.equal(usage[0].usageStatus, "partial");
	assert.equal(usage[1].status, "succeeded");
});

test("Pi semantic production port extracts a strict JSON envelope from bounded model prose", async () => {
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "prose" } }],
		complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "I checked the candidates.\n```json\n{\"matches\":[{\"id\":\"tool:known:1\",\"name\":\"known\",\"similarity\":0.9}]}\n```\nDone." }] }),
	});
	const result = await port.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 });
	assert.equal(result[0].name, "known");
});

test("Pi semantic production port ignores irrelevant grouping metadata on one unscoped match", async () => {
	assert.match(SEMANTIC_CAPABILITY_SYSTEM_PROMPT, /requirements are not supplied.*one match.*omit requirementId.*outcomeIndex.*necessity/i);
	assert.match(SEMANTIC_CAPABILITY_SYSTEM_PROMPT, /multiple matches.*short ASCII.*exactly one required/i);
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "singleton" } }], maxModelAttempts: 1,
		complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches: [{
			id: "tool:known:1", name: "known", similarity: 0.95,
			requirementId: "联网检索最新公开证据", outcomeIndex: 0, necessity: "required",
		}] }) }] }),
	});
	const result = await port.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 });
	assert.equal(result[0].name, "known");
});

test("Pi semantic production port normalizes only a bare empty no-match array", async () => {
	const noMatch = new PiSemanticCapabilityPort({
		models: [{ model: { id: "bare-empty" } }], maxModelAttempts: 1,
		complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "[]" }] }),
	});
	assert.deepEqual(await noMatch.similarities({ query: "chat", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 }), []);
	const bareSelection = new PiSemanticCapabilityPort({
		models: [{ model: { id: "bare-selection" } }], maxModelAttempts: 1,
		complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: '[{"id":"tool:known:1","name":"known","similarity":0.9}]' }] }),
	});
	await assert.rejects(() => bareSelection.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 }), /invalid_response/u);
});

test("Pi semantic production port rejects a mixed valid and malformed match array before failover", async () => {
	let calls = 0;
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "malformed" } }, { model: { id: "valid" } }],
		complete: async (model) => {
			calls++;
			const matches = model.id === "malformed"
				? [{ id: "tool:known:1", name: "known", similarity: 0.9 }, null]
				: [{ id: "tool:known:1", name: "known", similarity: 0.9 }];
			return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches }) }] };
		},
	});
	const result = await port.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 });
	assert.equal(calls, 2);
	assert.equal(result[0].name, "known");
});

test("Pi semantic production port reserves total-deadline time for a second Provider attempt", async () => {
	const calledModels = [];
	const startedAt = Date.now();
	let slowAbortedAt = 0;
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "slow" } }, { model: { id: "recovery" } }], timeoutMs: 1_000, maxModelAttempts: 2,
		complete: async (model, _context, options) => {
			calledModels.push(model.id);
			if (model.id === "recovery") return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches: [{ id: "tool:known:1", name: "known", similarity: 0.9 }] }) }] };
			await new Promise((resolve, reject) => {
				if (options.signal.aborted) { reject(options.signal.reason); return; }
				const keepAlive = setTimeout(() => reject(new Error("test Provider ignored cancellation")), 1_000);
				options.signal.addEventListener("abort", () => { slowAbortedAt = Date.now(); clearTimeout(keepAlive); reject(options.signal.reason); }, { once: true });
			});
		},
	});
	const result = await port.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 });
	assert.equal(result[0].name, "known");
	assert.deepEqual(calledModels, ["slow", "recovery"]);
	assert.ok(slowAbortedAt - startedAt >= 700, "the first attempt must receive at least three quarters of the total deadline");
	assert.ok(Date.now() - startedAt < 1_500, "recovery must stay inside the original total deadline");
});

test("Pi semantic production port reports an aborted attempt slice without claiming the total deadline expired", async () => {
	const usage = [];
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "slice-timeout" } }, { model: { id: "recovery" } }], timeoutMs: 1_000, maxModelAttempts: 2, onUsage(event) { usage.push(event); },
		complete: async (model, _context, options) => {
			if (model.id === "recovery") return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches: [] }) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
			await new Promise((resolve) => {
				const keepAlive = setTimeout(resolve, 2_000);
				options.signal.addEventListener("abort", () => { clearTimeout(keepAlive); resolve(); }, { once: true });
			});
			return { stopReason: "aborted", content: [], usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } };
		},
	});
	await port.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 });
	assert.equal(usage[0].failureCode, "provider_unavailable");
	assert.equal(usage[1].status, "succeeded");
});

test("Pi semantic production port enforces its deadline when a Provider ignores cancellation", async () => {
	const usage = [];
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "ignores-signal" } }], timeoutMs: 100, maxModelAttempts: 2, onUsage(event) { usage.push(event); },
		complete: async () => new Promise(() => {}),
	});
	const outcome = await Promise.race([
		port.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 }).then(() => "settled", () => "settled"),
		new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
	]);
	assert.equal(outcome, "settled");
	assert.equal(usage.length, 1, "one stalled model must not be retried under a different slice of the same deadline");
	assert.equal(usage[0].failureCode, "total_deadline");
});

test("Pi semantic production port reports bounded estimated and actual cognition usage", async () => {
	const usage = [];
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "usage" } }], onUsage(event) { usage.push(event); },
		complete: async () => ({
			stopReason: "stop",
			content: [{ type: "text", text: JSON.stringify({ matches: [] }) }],
			usage: { input: 21, output: 4, cacheRead: 3, cacheWrite: 2 },
		}),
	});
	await port.similarities({ query: "跨语言语义请求", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 });
	assert.equal(usage.length, 1);
	assert.equal(usage[0].status, "succeeded");
	assert.equal(usage[0].actualTokens, 30);
	assert.equal(usage[0].usageStatus, "partial");
	assert.ok(usage[0].durationMs >= 0);
	assert.ok(usage[0].estimatedTokens >= usage[0].actualTokens);
});

test("Pi semantic production port records large calls without a cumulative auxiliary token ceiling", async () => {
	let called = false;
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "only" } }], maxTokens: 256,
		complete: async () => { called = true; return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches: [{ id: "one", name: "one", similarity: 0.9 }] }) }], usage: { input: 2_100, output: 10, cacheRead: 0, cacheWrite: 0 } }; },
	});
	const result = await port.similarities({ query: "query", candidates: [{ id: "one", name: "one", text: "x".repeat(2_000) }], limit: 1 });
	assert.equal(called, true);
	assert.equal(result[0].id, "one");
});

test("Capability discovery excludes unavailable health and explicit exclusions deterministically", async () => {
	let semanticCandidates = [];
	const ranker = new SemanticCapabilityRanker({ async similarities({ candidates }) { semanticCandidates = candidates.map((candidate) => candidate.name); return candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, similarity: 0.99 })); } });
	const runtime = new CapabilityRuntime({ ranker });
	const selection = await runtime.discover({ query: "inspect locally and do not search online", inventory: [
		capabilityDescriptor({ kind: "tool", name: "offline", version: "1", activeTools: ["offline"], signals: { health: "unavailable" } }),
		capabilityDescriptor({ kind: "tool", name: "online", version: "1", activeTools: ["online"], exclude: ["do not search online"], signals: { health: "ready" } }),
		capabilityDescriptor({ kind: "tool", name: "local", version: "1", activeTools: ["local"], signals: { health: "ready" } }),
	] });
	assert.deepEqual(semanticCandidates, ["local"]);
	assert.deepEqual(selection.activatedTools, ["local"]);
});

test("Capability inventory rejects duplicate immutable identities and unbounded metadata", async () => {
	const duplicate = capabilityDescriptor({ kind: "tool", name: "same", version: "1", activeTools: ["same"] });
	await assert.rejects(() => new CapabilityRuntime().discover({ query: "same", inventory: [duplicate, duplicate] }), /Duplicate Capability identity/u);
	assert.throws(() => capabilityDescriptor({ kind: "tool", name: "too-many", version: "1", activeTools: ["too-many"], aliases: Array.from({ length: 101 }, (_, index) => `alias-${index}`) }), /exceeds 100/u);
	assert.throws(() => capabilityDescriptor({ kind: "tool", name: "too-large", description: "x".repeat(2_000), aliases: Array.from({ length: 29 }, () => "a".repeat(500)), version: "1", activeTools: ["too-large"] }), /metadata exceeds 16000/u);
	const aggregate = Array.from({ length: 126 }, (_, index) => capabilityDescriptor({ kind: "tool", name: `large-${index}`, description: "x".repeat(2_000), aliases: Array.from({ length: 28 }, () => "a".repeat(495)), version: "1", activeTools: [`large-${index}`] }));
	await assert.rejects(() => new CapabilityRuntime().discover({ query: "large", inventory: aggregate }), /inventory metadata exceeds 2000000/u);
});

test("Capability version hashing rejects oversized, cyclic, and deeply nested Tool schemas", () => {
	assert.throws(() => capabilityVersionOf({ schema: "x".repeat(70_000) }), /exceeds 65536 bytes/u);
	const cyclic = {}; cyclic.self = cyclic;
	assert.throws(() => capabilityVersionOf(cyclic), /acyclic JSON tree/u);
	let deep = {}; for (let index = 0; index < 40; index++) deep = { child: deep };
	assert.throws(() => capabilityVersionOf(deep), /exceeds depth 32/u);
});

test("canonical Capability identity cannot collide through colon-bearing names and versions", async () => {
	let ids = [];
	const ranker = new SemanticCapabilityRanker({ async similarities({ candidates }) { ids = candidates.map((candidate) => candidate.id); return []; } });
	await ranker.rank("query", [
		capabilityDescriptor({ kind: "tool", name: "alpha:beta", version: "gamma", activeTools: ["first"] }),
		capabilityDescriptor({ kind: "tool", name: "alpha", version: "beta:gamma", activeTools: ["second"] }),
	], 2);
	assert.equal(new Set(ids).size, 2);
	assert.equal(ids.every((id) => /^sha256:[a-f0-9]{64}$/u.test(id)), true);
});

test("direct lexical discovery honors cancellation before activation", async () => {
	let activated = false;
	const controller = new AbortController(); controller.abort(new Error("stop now"));
	const runtime = new CapabilityRuntime({ ranker: new LexicalCapabilityRanker(), activeTools: { setActiveTools() { activated = true; } } });
	await assert.rejects(() => runtime.discover({ query: "查找公开证据", inventory, signal: controller.signal }), /stop now/u);
	assert.equal(activated, false);
});

test("Capability reroute rejects mutation replay and unresolved Effects before Policy runs again", () => {
	const runtime = new CapabilityRuntime();
	assert.deepEqual(runtime.canReroute({ sideEffect: "none", effectStatus: "failed" }), { allowed: true, reason: "read-only capability failed without an unresolved Effect" });
	for (const sideEffect of ["local", "external"]) assert.equal(runtime.canReroute({ sideEffect, effectStatus: "failed" }).allowed, false);
	for (const effectStatus of ["planned", "executing", "committed", "unknown"]) assert.equal(runtime.canReroute({ sideEffect: "none", effectStatus }).allowed, false);
});

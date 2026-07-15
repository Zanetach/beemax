import assert from "node:assert/strict";
import test from "node:test";
import {
	CapabilityRuntime,
	LexicalCapabilityRanker,
	ModelBackedSemanticCapabilityPort,
	PiSemanticCapabilityPort,
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

test("a closed semantic failure remains dominant over a later transient Provider failure", async () => {
	let calls = 0;
	let fallbackCalled = false;
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "invalid" } }, { model: { id: "offline" } }],
		complete: async () => {
			calls++;
			if (calls === 1) return { stopReason: "stop", content: [{ type: "text", text: "not-json" }] };
			throw Object.assign(new Error("offline"), { code: "ECONNRESET" });
		},
	});
	const ranker = new SemanticCapabilityRanker(port, { fallback: { async rank() { fallbackCalled = true; return []; } } });
	await assert.rejects(() => ranker.rank("known", [capabilityDescriptor({ kind: "tool", name: "known", version: "1", activeTools: ["known"] })], 1), /invalid_json/u);
	assert.equal(fallbackCalled, false);
});

test("semantic ranking fails closed on invalid model output instead of misreporting Provider unavailability", async () => {
	let fallbackCalled = false;
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "invalid" } }],
		complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ matches: [{ name: "invented", similarity: 0.99 }] }) }] }),
	});
	const ranker = new SemanticCapabilityRanker(port, { fallback: { async rank() { fallbackCalled = true; return []; } } });
	await assert.rejects(() => ranker.rank("known", [capabilityDescriptor({ kind: "tool", name: "known", version: "1", activeTools: ["known"] })], 1), /invalid_response/u);
	assert.equal(fallbackCalled, false);
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

test("semantic model context is bounded while lexical recall preserves an explicit tail match", async () => {
	let candidateCount = 0;
	const inventory = Array.from({ length: 300 }, (_, index) => capabilityDescriptor({ kind: "skill", name: `generic-${String(index).padStart(3, "0")}`, description: "A generic workflow", version: "1", activeTools: ["skill_activate"] }));
	inventory.push(capabilityDescriptor({ kind: "tool", name: "tail_match", description: "Retrieve exact lunar telemetry", aliases: ["lunar telemetry"], version: "1", activeTools: ["tail_match"] }));
	const ranker = new SemanticCapabilityRanker({ async similarities({ candidates }) {
		candidateCount = candidates.length;
		const selected = candidates.find((candidate) => candidate.name === "tail_match");
		return selected ? [{ id: selected.id, name: selected.name, similarity: 0.95 }] : [];
	} });
	const ranked = await ranker.rank("lunar telemetry", inventory, 5);
	assert.equal(candidateCount, 128);
	assert.equal(ranked[0].descriptor.name, "tail_match");
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

test("Pi semantic production port never resets the total deadline for another Provider attempt", async () => {
	const calledModels = [];
	const startedAt = Date.now();
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "slow" } }, { model: { id: "must-not-reset-timeout" } }], timeoutMs: 100,
		complete: async (model, _context, options) => {
			calledModels.push(model.id);
			await new Promise((resolve, reject) => {
				if (options.signal.aborted) { reject(options.signal.reason); return; }
				const keepAlive = setTimeout(() => reject(new Error("test Provider ignored cancellation")), 1_000);
				options.signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(options.signal.reason); }, { once: true });
			});
		},
	});
	await assert.rejects(() => port.similarities({ query: "known", candidates: [{ id: "tool:known:1", name: "known", text: "Known capability" }], limit: 1 }));
	assert.deepEqual(calledModels, ["slow"]);
	assert.ok(Date.now() - startedAt < 500, "the total deadline must not reset for the next Provider");
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

test("Pi semantic production port enforces one cumulative auxiliary token budget", async () => {
	let called = false;
	const port = new PiSemanticCapabilityPort({
		models: [{ model: { id: "only" } }], maxTokens: 256, maxTotalEstimatedTokens: 512,
		complete: async () => { called = true; return { stopReason: "stop", content: [{ type: "text", text: "{}" }] }; },
	});
	await assert.rejects(() => port.similarities({ query: "query", candidates: [{ id: "one", name: "one", text: "x".repeat(2_000) }], limit: 1 }), /budget_exceeded/u);
	assert.equal(called, false);
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

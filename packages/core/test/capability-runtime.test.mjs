import assert from "node:assert/strict";
import test from "node:test";
import {
	CapabilityRuntime,
	LexicalCapabilityRanker,
	SemanticCapabilityRanker,
	capabilityDescriptor,
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
		assert.deepEqual(Object.keys(selection).sort(), ["activatedTools", "candidates", "query"]);
		assert.deepEqual(Object.keys(selection.candidates[0]).sort(), ["confidence", "explanation", "kind", "name", "score", "version"]);
		assert.deepEqual(Object.keys(selection.candidates[0].explanation).sort(), ["signals", "strategy", "summary"]);
		assert.equal(selection.candidates[0].name, "web_search");
		assert.equal(selection.candidates[0].version, "tool:web-search:v1");
	}
	assert.equal(lexical.candidates[0].explanation.strategy, "lexical");
	assert.equal(semantic.candidates[0].explanation.strategy, "semantic");
});

test("Capability discovery changes execution only through Pi active tools", async () => {
	const activations = [];
	const runtime = new CapabilityRuntime({ ranker: new LexicalCapabilityRanker(), activeTools: { setActiveTools(names) { activations.push(names); } } });
	const selection = await runtime.discover({ query: "来源审查", inventory, limit: 1 });
	assert.deepEqual(selection.activatedTools, ["skill_activate", "skill_read"]);
	assert.deepEqual(activations, [["skill_activate", "skill_read"]]);
	assert.equal("execute" in selection.candidates[0], false);
});

test("Capability reroute rejects mutation replay and unresolved Effects before Policy runs again", () => {
	const runtime = new CapabilityRuntime();
	assert.deepEqual(runtime.canReroute({ sideEffect: "none", effectStatus: "failed" }), { allowed: true, reason: "read-only capability failed without an unresolved Effect" });
	for (const sideEffect of ["local", "external"]) assert.equal(runtime.canReroute({ sideEffect, effectStatus: "failed" }).allowed, false);
	for (const effectStatus of ["planned", "executing", "committed", "unknown"]) assert.equal(runtime.canReroute({ sideEffect: "none", effectStatus }).allowed, false);
});

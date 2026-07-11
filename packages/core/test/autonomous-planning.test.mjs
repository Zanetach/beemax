import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousPlanningPolicy, BeeMaxAgentRuntime } from "../dist/index.js";

test("planning policy keeps simple conversational requests direct", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 8 });
	const decision = policy.decide("What model are you using?");
	assert.equal(decision.mode, "direct");
	assert.equal(decision.suggestedConcurrency, 1);
	assert.equal(decision.budget.maxSubagents, 0);
	assert.match(decision.reason, /simple|single/i);
});

test("planning policy delegates one substantial isolated work item", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 8 });
	const decision = policy.decide("Research the official documentation deeply and produce an evidence-backed comparison report");
	assert.equal(decision.mode, "delegate");
	assert.equal(decision.suggestedConcurrency, 1);
	assert.equal(decision.budget.maxSubagents, 1);
	assert.ok(decision.budget.maxToolCalls > 0);
});

test("planning policy selects a DAG and derives bounded parallel resources for independent deliverables", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 8, maxSubagents: 6, maxToolCalls: 60, maxTokens: 120_000 });
	const decision = policy.decide("Review the API, CLI, memory, security, and operations modules in parallel; compare each independently, then synthesize and verify a release report");
	assert.equal(decision.mode, "dag");
	assert.ok(decision.suggestedConcurrency >= 2);
	assert.ok(decision.suggestedConcurrency <= 6);
	assert.ok(decision.budget.maxSubagents >= decision.suggestedConcurrency);
	assert.ok(decision.budget.maxToolCalls <= 60);
	assert.ok(decision.budget.maxTokens <= 120_000);
	assert.ok(decision.signals.independentWorkItems >= 2);
});

test("planning policy degrades a complex request when its resource ceiling cannot support a DAG", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 1, maxSubagents: 1, maxToolCalls: 8, maxTokens: 8_000 });
	const decision = policy.decide("Research three independent providers in parallel, compare them, verify every result, and publish one report");
	assert.equal(decision.mode, "delegate");
	assert.equal(decision.suggestedConcurrency, 1);
	assert.equal(decision.budget.maxSubagents, 1);
	assert.match(decision.reason, /budget|capacity/i);
});

test("planning policy exposes a content-free directive for the Agent runtime", () => {
	const decision = new AutonomousPlanningPolicy().decide("Review frontend and backend independently, then combine the results");
	const directive = decision.directive();
	assert.match(directive, /mode=(?:dag|delegate)/);
	assert.match(directive, /maxSubagents=/);
	assert.doesNotMatch(directive, /frontend|backend/);
});

test("Agent runtime injects a deterministic planning directive without changing the user exchange", async () => {
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
	let received = "";
	const recorded = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		planningPolicy: new AutonomousPlanningPolicy(),
		context: { enrich: (_source, text) => text, record: (_source, exchange) => recorded.push(exchange) },
		createAgent: async () => ({
			agent,
			subscribe: () => () => undefined,
			prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	await runtime.run({ source, text: "Review frontend and backend independently, then combine the results", timeoutMs: 1_000 });
	assert.match(received, /BeeMax execution policy/);
	assert.match(received, /mode=(?:dag|delegate)/);
	assert.deepEqual(recorded, [{ user: "Review frontend and backend independently, then combine the results", assistant: "done" }]);
	runtime.dispose();
});

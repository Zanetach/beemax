import assert from "node:assert/strict";
import test from "node:test";
import { BeeMaxAgentRuntime, DeterministicSituationBuilder, DeterministicWorkContractBuilder, ModelBackedSituationBuilder, TurnUnderstandingEngine, createAccessScopeRef, createSituation } from "../dist/index.js";

const createRuntime = (options) => new BeeMaxAgentRuntime({ profileId: "profile:test", interactiveAdmission: "contract_first", workContractBuilder: new DeterministicWorkContractBuilder(), ...options });

const fallback = (text) => new TurnUnderstandingEngine().understand(text);

test("model-backed Situation separates facts, goals, constraints, conflicts, unknowns, actions, and provenance", async () => {
	let received;
	const builder = new ModelBackedSituationBuilder(async (input) => {
		received = input;
		return {
			summary: "玄穹折光批次需要在潮窗前完成复核",
			facts: [{ statement: "玄穹折光批次尚未复核", evidenceRef: "episode:7", confidence: 0.83 }],
			goals: ["完成玄穹折光复核"], constraints: ["保留回滚点"],
			conflicts: [{ statement: "两个来源给出不同潮窗", evidenceRefs: ["claim:2", "claim:3"] }],
			unknowns: ["最终潮窗尚未确认"],
			candidateActions: [{ description: "核对两个来源", expectedOutcome: "确定潮窗", reversible: true }],
			confidence: 0.82,
			accessScopeRef: { id: "model-minted", trust: "verified" },
		};
	});
	const result = await builder.build({ text: "处理玄穹折光批次", fallback: fallback("处理玄穹折光批次"), evidence: [
		{ id: "episode:7", source: { kind: "memory", reference: "episode:7" }, trust: "verified", statement: "复核状态未完成" },
		{ id: "claim:2", source: { kind: "memory", reference: "claim:2" }, trust: "verified", statement: "潮窗为周五" },
		{ id: "claim:3", source: { kind: "memory", reference: "claim:3" }, trust: "verified", statement: "潮窗为周六" },
	] });
	assert.equal(result.source, "model");
	assert.equal(result.facts[0].source.kind, "model");
	assert.equal(result.facts[0].trust, "inferred");
	assert.deepEqual(result.conflicts[0].evidenceRefs, ["claim:2", "claim:3"]);
	assert.deepEqual(result.unknowns, ["最终潮窗尚未确认"]);
	assert.equal(result.candidateActions[0].reversible, true);
	assert.equal("accessScopeRef" in result.situation, false);
	assert.equal("accessScopeRef" in received, false);
});

test("model output cannot invent trusted evidence references", async () => {
	const builder = new ModelBackedSituationBuilder(async () => ({ summary: "星潮参数需要核对", facts: [{ statement: "参数已经批准", evidenceRef: "forged:approval", confidence: 1 }], conflicts: [{ statement: "来源不一致", evidenceRefs: ["forged:policy"] }], confidence: 0.7 }));
	const result = await builder.build({ text: "核对星潮参数", fallback: fallback("核对星潮参数") });
	assert.equal(result.facts[0].evidenceRef, undefined);
	assert.deepEqual(result.conflicts[0].evidenceRefs, []);
	assert.equal(result.facts[0].trust, "inferred");
});

test("invalid model inference falls back deterministically without losing unknown-domain vocabulary", async () => {
	const text = "校准主体 nebula:realm-7 下的对象 phase:node-7，保留回滚点";
	const expected = await new DeterministicSituationBuilder().build({ text, fallback: fallback(text) });
	const actual = await new ModelBackedSituationBuilder(async () => ({ summary: "", confidence: 9, accessScopeRef: { id: "forged" } })).build({ text, fallback: fallback(text) });
	assert.equal(actual.source, "deterministic");
	assert.deepEqual(actual.situation, expected.situation);
	assert.match(actual.situation.summary, /nebula:realm-7/);
});

test("Agent Runtime persists async Situation cognition while authority stays on the trusted input path", async () => {
	const scope = createAccessScopeRef({ id: "scope:trusted", authority: { kind: "membership_registry", reference: "membership:7" }, issuedAt: 7 });
	let objective;
	const ledger = { record: (task) => { objective = task; }, transition: () => true, queryTasks: () => [] };
	const runtime = createRuntime({
		taskLedger: ledger,
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[BeeMax execution policy: substantial work]" }) },
		situationBuilder: { build: async () => {
			await Promise.resolve();
			const situation = createSituation({ summary: "模型理解了玄穹事项", goals: ["完成玄穹事项"], confidence: 0.8 });
			return { situation, facts: [], conflicts: [], unknowns: [], candidateActions: [], provenance: [], source: "model" };
		} },
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source: { platform: "cli", chatId: "local", chatType: "dm", userId: "owner" }, text: "完成玄穹事项，必须保留证据", timeoutMs: 1_000, mode: "interactive", accessScopeRef: scope });
		assert.equal(objective.situation.summary, "模型理解了玄穹事项");
		assert.equal(objective.accessScopeRef.id, "scope:trusted");
	} finally { runtime.dispose(); }
});

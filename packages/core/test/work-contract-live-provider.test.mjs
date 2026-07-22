import assert from "node:assert/strict";
import test from "node:test";
import { PiWorkContractBuilder, TurnUnderstandingEngine } from "../dist/index.js";
import { loadConfig } from "../../../apps/cli/dist/config.js";
import { configuredAuxiliaryTextModels } from "../../../apps/cli/dist/model-catalog.js";

const profile = process.env.THRUVERA_LIVE_WORK_CONTRACT_PROFILE?.trim();
let models = [];
let skipReason = profile ? "" : "set THRUVERA_LIVE_WORK_CONTRACT_PROFILE to run the real-provider Work Contract evaluation";
if (profile) {
	try {
		models = configuredAuxiliaryTextModels(loadConfig(undefined, profile));
		if (!models.length) skipReason = `profile ${profile} has no configured, authenticated auxiliary text model`;
	} catch (error) {
		skipReason = `profile ${profile} could not load a real Provider: ${error instanceof Error ? error.message : String(error)}`;
	}
}

const cases = [
	{
		name: "Chinese negated cancellation continues the selected Objective",
		rawRequest: "不要取消市场分析，继续完成周报",
		action: "continue",
		targetObjectiveId: "objective-report",
		activeObjectives: [{ id: "objective-market", title: "市场分析" }, { id: "objective-report", title: "周报" }],
		requiredProhibitions: ["不要取消市场分析"],
	},
	{
		name: "English negated goal change corrects the selected Objective",
		rawRequest: "Don't change the market analysis; revise the weekly report in Chinese",
		action: "correct",
		targetObjectiveId: "objective-report",
		activeObjectives: [{ id: "objective-market", title: "market analysis" }, { id: "objective-report", title: "weekly report" }],
		requiredProhibitions: ["Don't change the market analysis"],
		requiredAcceptance: ["revise the weekly report in Chinese"],
	},
	{
		name: "Chinese draft-only request preserves publish prohibition",
		rawRequest: "无需发布，只保存最终草稿",
		action: "create",
		activeObjectives: [],
		requiredProhibitions: ["无需发布"],
		requiredAcceptance: ["只保存最终草稿"],
	},
	{
		name: "Mixed-language cancellation selects one Objective without cancelling the other",
		rawRequest: "不要停止 market analysis; cancel the weekly report only",
		action: "cancel",
		targetObjectiveId: "objective-report",
		activeObjectives: [{ id: "objective-market", title: "market analysis" }, { id: "objective-report", title: "weekly report" }],
		requiredProhibitions: ["不要停止 market analysis"],
	},
];

test("real Provider preserves multilingual Work Contract lifecycle, target, and raw-request completeness", {
	skip: skipReason || false,
	timeout: 600_000,
}, async () => {
	const builder = new PiWorkContractBuilder({ models, timeoutMs: 60_000 });
	const understanding = new TurnUnderstandingEngine();
	for (const scenario of cases) {
		await test(scenario.name, async () => {
			const fallback = understanding.understand(scenario.rawRequest, scenario.activeObjectives.length === 1 ? { activeObjective: scenario.activeObjectives[0].title } : {});
			const result = await builder.build({ rawRequest: scenario.rawRequest, fallback, activeObjectives: scenario.activeObjectives });
			assert.equal(result.source, "model");
			assert.equal(result.contract.action, scenario.action);
			assert.equal(result.contract.targetObjective?.id, scenario.targetObjectiveId);
			assert.ok(result.contract.confidence >= 0.6, `confidence ${result.contract.confidence} is below live admission floor`);
			assertRawSources(result.contract, scenario.rawRequest);
			assertCovered(result.contract.prohibitions, scenario.requiredProhibitions ?? [], "prohibition");
			assertCovered(result.contract.acceptanceCriteria, scenario.requiredAcceptance ?? [], "acceptance criterion");
		});
	}
});

function assertRawSources(contract, rawRequest) {
	for (const clause of [contract.objective, ...contract.constraints, ...contract.prohibitions, ...contract.acceptanceCriteria, ...contract.capabilityRequirements, ...contract.uncertainties]) {
		assert.equal(clause.source.kind, "raw_request", `${clause.text} is not bound to the Raw Request`);
		assert.equal(rawRequest.slice(clause.source.start, clause.source.end), clause.text);
	}
}

function assertCovered(clauses, required, category) {
	for (const phrase of required) {
		assert.ok(clauses.some(({ text }) => normalize(text).includes(normalize(phrase))), `${category} is missing: ${phrase}`);
	}
}

function normalize(value) { return value.normalize("NFKC").trim().toLocaleLowerCase(); }

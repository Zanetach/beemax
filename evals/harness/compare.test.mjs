import assert from "node:assert/strict";
import test from "node:test";
import { buildJudgeRequest, checkOutputConstraints, checkToolExpectations, evaluateCase, judgeOutput, matchRecordsToCases, orderCases } from "./compare.mjs";

function record(overrides = {}) {
	return {
		input: { text: "[memory]\n\n明天北京会下雨吗?帮我查一下再回答。\n\n[directive]" },
		toolCalls: [{ id: "c1", name: "web_search", arguments: { query: "北京 天气" }, result: { text: "晴", isError: false, chars: 1 } }],
		output: { text: "明天北京多云转晴,不会下雨。", stopReason: "stop" },
		...overrides,
	};
}

test("orderCases places dependencies before dependents and rejects cycles", () => {
	const ordered = orderCases([
		{ id: "b", dependsOn: "a", prompt: "b", expect: {} },
		{ id: "c", prompt: "c", expect: {} },
		{ id: "a", prompt: "a", expect: {} },
	]);
	assert.deepEqual(ordered.map((testCase) => testCase.id), ["a", "b", "c"]);
	assert.throws(() => orderCases([
		{ id: "x", dependsOn: "y", prompt: "x", expect: {} },
		{ id: "y", dependsOn: "x", prompt: "y", expect: {} },
	]), /cycle/);
});

test("matchRecordsToCases matches by prompt substring and consumes records in order", () => {
	const cases = [
		{ id: "one", prompt: "第一个问题", expect: {} },
		{ id: "two", prompt: "第二个问题", expect: {} },
		{ id: "missing", prompt: "从未发送的问题", expect: {} },
	];
	const records = [
		record({ input: { text: "context\n\n第一个问题" } }),
		record({ input: { text: "context\n\n第二个问题\n\ndirective" } }),
	];
	const matched = matchRecordsToCases(cases, records);
	assert.equal(matched[0].record, records[0]);
	assert.equal(matched[1].record, records[1]);
	assert.equal(matched[2].record, undefined);
});

test("checkToolExpectations covers required, anyOf, forbidden, arguments, and maxToolCalls", () => {
	const sample = record();
	assert.deepEqual(checkToolExpectations(sample, { tools: { required: ["web_search"] } }), []);
	assert.match(checkToolExpectations(sample, { tools: { required: ["memory_recall"] } })[0], /required tool not called: memory_recall/);
	assert.deepEqual(checkToolExpectations(sample, { tools: { anyOf: [["bash"], ["web_search"]] } }), []);
	assert.match(checkToolExpectations(sample, { tools: { anyOf: [["bash"], ["write"]] } })[0], /no tools.anyOf group satisfied/);
	assert.match(checkToolExpectations(sample, { tools: { forbidden: ["web_search"] } })[0], /forbidden tool was called/);
	assert.deepEqual(checkToolExpectations(sample, { toolArguments: [{ tool: "web_search", mustContain: ["北京"] }] }), []);
	assert.match(checkToolExpectations(sample, { toolArguments: [{ tool: "web_search", mustContain: ["上海"] }] })[0], /arguments missing/);
	assert.deepEqual(checkToolExpectations(sample, { toolArguments: [{ tool: "write", mustContain: ["notes"] }] }), [], "argument rules do not fire when the tool was never called");
	assert.match(checkToolExpectations(sample, { maxToolCalls: 0 })[0], /too many tool calls/);
});

test("checkOutputConstraints covers mustContain, anyContain, mustNotContain", () => {
	const sample = record();
	assert.deepEqual(checkOutputConstraints(sample, { output: { mustContain: ["北京"], anyContain: ["不会下雨", "会下雨"], mustNotContain: ["无法访问"] } }), []);
	const failures = checkOutputConstraints(sample, { output: { mustContain: ["上海"], anyContain: ["晴天预警"], mustNotContain: ["北京"] } });
	assert.equal(failures.length, 3);
});

test("judgeOutput parses a structured verdict and survives failures", async () => {
	const testCase = { id: "x", prompt: "p", expect: { output: { example: "参考答案" } } };
	const good = {
		messages: {
			create: async (request) => {
				assert.equal(request.model, "claude-opus-4-8");
				assert.equal(request.output_config.format.type, "json_schema");
				return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ equivalent: false, score: 3, differences: ["缺少关键事实"], reasoning: "r" }) }] };
			},
		},
	};
	const verdict = await judgeOutput(good, testCase, record());
	assert.equal(verdict.equivalent, false);
	assert.equal(verdict.score, 3);

	const failing = { messages: { create: async () => { throw new Error("401 auth"); } } };
	const skipped = await judgeOutput(failing, testCase, record());
	assert.equal(skipped.skipped, true);
	assert.match(skipped.reason, /judge call failed/);

	const noExample = await judgeOutput(good, { id: "y", prompt: "p", expect: {} }, record());
	assert.equal(noExample.skipped, true);
});

test("buildJudgeRequest embeds prompt, reference, and actual answer", () => {
	const request = buildJudgeRequest({ prompt: "问题?", expect: { output: { example: "参考" } } }, record());
	const text = request.messages[0].content;
	assert.match(text, /<user_prompt>\n问题\?/);
	assert.match(text, /<reference_answer>\n参考/);
	assert.match(text, /<actual_answer>\n明天北京多云转晴/);
});

test("evaluateCase aggregates deterministic failures and judge verdicts", async () => {
	const testCase = {
		id: "weather",
		prompt: "明天北京会下雨吗?帮我查一下再回答。",
		expect: { tools: { required: ["web_search"] }, output: { mustContain: ["北京"], example: "参考" } },
	};
	const passJudge = async () => ({ equivalent: true, score: 9, differences: [], reasoning: "ok" });
	const failJudge = async () => ({ equivalent: false, score: 2, differences: ["答非所问"], reasoning: "bad" });

	const pass = await evaluateCase(testCase, record(), passJudge);
	assert.equal(pass.passed, true);

	const judged = await evaluateCase(testCase, record(), failJudge);
	assert.equal(judged.passed, false);
	assert.match(judged.failures[0], /LLM judge: not equivalent/);

	const missing = await evaluateCase(testCase, undefined, passJudge);
	assert.equal(missing.passed, false);
	assert.equal(missing.missingRecord, true);

	const deterministicOnly = await evaluateCase(testCase, record(), undefined);
	assert.equal(deterministicOnly.passed, true);
	assert.equal(deterministicOnly.judge, undefined);
});

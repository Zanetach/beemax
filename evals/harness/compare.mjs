/**
 * Eval-harness comparison: match exported session records to baseline cases,
 * apply deterministic tool/output checks, and judge output equivalence with an
 * LLM (Anthropic API) against each case's reference example.
 *
 * Pure logic lives here so it is unit-testable; the judge client is injected.
 */

/** Order cases so that every case runs after its dependsOn case. */
export function orderCases(cases) {
	const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
	const ordered = [];
	const placed = new Set();
	const visit = (testCase, trail) => {
		if (placed.has(testCase.id)) return;
		if (trail.has(testCase.id)) throw new Error(`Baseline dependsOn cycle at: ${testCase.id}`);
		trail.add(testCase.id);
		const dependency = testCase.dependsOn ? byId.get(testCase.dependsOn) : undefined;
		if (testCase.dependsOn && !dependency) throw new Error(`${testCase.id}: unknown dependsOn ${testCase.dependsOn}`);
		if (dependency) visit(dependency, trail);
		placed.add(testCase.id);
		ordered.push(testCase);
	};
	for (const testCase of cases) visit(testCase, new Set());
	return ordered;
}

/**
 * Match each case to the first unconsumed record whose input contains the
 * case prompt verbatim (the runtime prepends memory context and appends
 * planning directives, so the prompt is a substring of the assembled input).
 */
export function matchRecordsToCases(cases, records) {
	const remaining = [...records];
	return cases.map((testCase) => {
		const index = remaining.findIndex((record) => (record.input?.text ?? "").includes(testCase.prompt));
		if (index === -1) return { testCase, record: undefined };
		const [record] = remaining.splice(index, 1);
		return { testCase, record };
	});
}

export function checkToolExpectations(record, expect) {
	const failures = [];
	const called = (record.toolCalls ?? []).map((call) => call.name);
	const calledSet = new Set(called);
	const tools = expect.tools ?? {};
	for (const name of tools.required ?? []) {
		if (!calledSet.has(name)) failures.push(`required tool not called: ${name} (called: ${called.join(", ") || "none"})`);
	}
	if (tools.anyOf?.length) {
		const satisfied = tools.anyOf.some((group) => group.every((name) => calledSet.has(name)));
		if (!satisfied) failures.push(`no tools.anyOf group satisfied: ${JSON.stringify(tools.anyOf)} (called: ${called.join(", ") || "none"})`);
	}
	for (const name of tools.forbidden ?? []) {
		if (calledSet.has(name)) failures.push(`forbidden tool was called: ${name}`);
	}
	for (const rule of expect.toolArguments ?? []) {
		const calls = (record.toolCalls ?? []).filter((call) => call.name === rule.tool);
		if (!calls.length) continue; // absence is judged by required/anyOf, not by argument rules
		const satisfied = calls.some((call) => {
			const serialized = JSON.stringify(call.arguments ?? {});
			return rule.mustContain.every((needle) => serialized.includes(needle));
		});
		if (!satisfied) failures.push(`tool ${rule.tool} arguments missing ${JSON.stringify(rule.mustContain)}`);
	}
	if (expect.maxToolCalls !== undefined && called.length > expect.maxToolCalls) {
		failures.push(`too many tool calls: ${called.length} > ${expect.maxToolCalls}`);
	}
	return failures;
}

export function checkOutputConstraints(record, expect) {
	const failures = [];
	const text = record.output?.text ?? "";
	const output = expect.output ?? {};
	for (const needle of output.mustContain ?? []) {
		if (!text.includes(needle)) failures.push(`output missing required text: ${needle}`);
	}
	if (output.anyContain?.length && !output.anyContain.some((needle) => text.includes(needle))) {
		failures.push(`output contains none of: ${output.anyContain.join(" | ")}`);
	}
	for (const needle of output.mustNotContain ?? []) {
		if (text.includes(needle)) failures.push(`output contains forbidden text: ${needle}`);
	}
	return failures;
}

export const JUDGE_MODEL = "claude-opus-4-8";

const JUDGE_SCHEMA = {
	type: "object",
	properties: {
		equivalent: { type: "boolean", description: "true when the actual answer fulfills the same user intent and key facts as the reference example" },
		score: { type: "integer", description: "similarity of intent fulfillment from 0 (unrelated or wrong) to 10 (fully equivalent)" },
		differences: { type: "array", items: { type: "string" }, description: "meaningful differences between actual and reference; empty when equivalent" },
		reasoning: { type: "string", description: "one short paragraph explaining the verdict" },
	},
	required: ["equivalent", "score", "differences", "reasoning"],
	additionalProperties: false,
};

export function buildJudgeRequest(testCase, record) {
	return {
		model: JUDGE_MODEL,
		max_tokens: 2048,
		thinking: { type: "adaptive" },
		output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA } },
		messages: [{
			role: "user",
			content: [
				"You are grading an AI agent's answer against a reference example.",
				"Judge semantic equivalence of intent fulfillment, not wording: the actual answer passes when a user asking the prompt would be equally well served.",
				"Different phrasing, ordering, or level of detail is acceptable; missing key facts, wrong facts, refusing when the reference answers (or answering when the reference refuses), or ignoring the request are not.",
				"",
				`<user_prompt>\n${testCase.prompt}\n</user_prompt>`,
				`<reference_answer>\n${testCase.expect?.output?.example ?? ""}\n</reference_answer>`,
				`<actual_answer>\n${record.output?.text ?? ""}\n</actual_answer>`,
			].join("\n"),
		}],
	};
}

/** Judge one case with the injected Anthropic client; never throws. */
export async function judgeOutput(client, testCase, record) {
	if (!testCase.expect?.output?.example) return { skipped: true, reason: "case has no output.example" };
	try {
		const response = await client.messages.create(buildJudgeRequest(testCase, record));
		if (response.stop_reason === "refusal") return { skipped: true, reason: "judge refused" };
		const text = response.content.find((block) => block.type === "text")?.text ?? "";
		const verdict = JSON.parse(text);
		return { equivalent: verdict.equivalent === true, score: verdict.score, differences: verdict.differences, reasoning: verdict.reasoning };
	} catch (error) {
		return { skipped: true, reason: `judge call failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Evaluate one matched case. `judge` is optional; pass undefined to run
 * deterministic checks only. A case passes when the record exists, no
 * deterministic check fails, and the judge (when it ran) says equivalent.
 */
export async function evaluateCase(testCase, record, judge) {
	if (!record) return { id: testCase.id, passed: false, missingRecord: true, failures: ["no session record matched this case prompt"] };
	const failures = [...checkToolExpectations(record, testCase.expect ?? {}), ...checkOutputConstraints(record, testCase.expect ?? {})];
	const judgeResult = judge ? await judge(testCase, record) : undefined;
	const judgeFailed = judgeResult && !judgeResult.skipped && !judgeResult.equivalent;
	if (judgeFailed) failures.push(`LLM judge: not equivalent (score ${judgeResult.score}): ${(judgeResult.differences ?? []).join("; ")}`);
	return {
		id: testCase.id,
		passed: failures.length === 0,
		failures,
		toolCalls: (record.toolCalls ?? []).map((call) => call.name),
		output: record.output?.text ?? "",
		...(judgeResult ? { judge: judgeResult } : {}),
	};
}

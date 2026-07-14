import assert from "node:assert/strict";
import test from "node:test";
import { assessTaskPlanQuality } from "../dist/index.js";

test("Task Plan quality rejects duplicate work and non-observable acceptance criteria", () => {
	const result = assessTaskPlanQuality([
		{ title: "Review API", goal: "Inspect the API", acceptanceCriteria: "完成" },
		{ title: " review api ", goal: "Inspect it again", acceptanceCriteria: "Done" },
	]);
	assert.equal(result.accepted, false);
	assert.deepEqual(result.issues, [
		"Task 1 acceptance criteria must describe observable evidence",
		"Task 2 duplicates another Task title: review api",
		"Task 2 acceptance criteria must describe observable evidence",
	]);
});

test("Task Plan quality rejects mutation goals assigned to read-only Sub-Agents", () => {
	const result = assessTaskPlanQuality([
		{ title: "Change auth", goal: "Edit src/auth.ts and commit the changes", acceptanceCriteria: "Tests demonstrate the new authentication behavior" },
		{ title: "Notify team", goal: "发送邮件并发布报告", acceptanceCriteria: "Delivery receipt identifies the destination" },
	]);
	assert.deepEqual(result.issues, [
		"Task 1 goal requires mutating capability unavailable to isolated Sub-Agents",
		"Task 2 goal requires mutating capability unavailable to isolated Sub-Agents",
	]);
});

test("Task Plan quality permits returning findings to the parent Agent", () => {
	const result = assessTaskPlanQuality([
		{ title: "Review auth", goal: "Send findings back to the parent Agent", acceptanceCriteria: "The response identifies inspected files and concrete findings" },
	]);
	assert.deepEqual(result, { accepted: true, issues: [] });
});

test("Task Plan quality permits producing text without publishing or writing it", () => {
	const result = assessTaskPlanQuality([
		{
			title: "Draft launch copy",
			goal: "Create a Chinese launch article and three social copy variants as text. Return the drafts to the parent Agent only; do not publish or write files.",
			acceptanceCriteria: "Returns one complete article and exactly three clearly labelled social variants in the Task result.",
		},
	]);
	assert.deepEqual(result, { accepted: true, issues: [] });
});

test("Task Plan quality does not mistake urgency wording for mutation negation", () => {
	const result = assessTaskPlanQuality([
		{
			title: "Publish immediately",
			goal: "Without delay, publish the approved report.",
			acceptanceCriteria: "A publication receipt identifies the destination and report.",
		},
	]);
	assert.equal(result.accepted, false);
});

test("Task Plan quality treats publish-ready copy as content when publication is explicitly forbidden", () => {
	const result = assessTaskPlanQuality([
		{ title: "English copy", goal: "Draft publish-ready copy. Do not publish or write files; return text only.", acceptanceCriteria: "Returns complete copy as text to the parent Agent." },
		{ title: "Chinese copy", goal: "生成可发布文案，但不要发布或写入文件，只返回文本。", acceptanceCriteria: "向父 Agent 返回完整中文文案文本。" },
	]);
	assert.deepEqual(result, { accepted: true, issues: [] });
});

test("Task Plan quality distinguishes file writes from explicit no-write constraints", () => {
	const mutating = assessTaskPlanQuality([
		{ title: "Write English", goal: "Write the final report to a workspace file.", acceptanceCriteria: "The file exists in the workspace." },
		{ title: "Write Chinese", goal: "将最终报告写入文件。", acceptanceCriteria: "工作区中存在对应报告文件。" },
	]);
	assert.equal(mutating.accepted, false);
	assert.equal(mutating.issues.length, 2);
	const readOnly = assessTaskPlanQuality([
		{ title: "Return English", goal: "Draft the final report; do not write files, return text only.", acceptanceCriteria: "Returns the complete report text." },
		{ title: "Return Chinese", goal: "起草最终报告，不要写入文件，只返回文本。", acceptanceCriteria: "返回完整的报告文本。" },
	]);
	assert.deepEqual(readOnly, { accepted: true, issues: [] });
});

test("Task Plan quality accepts common publication-ready content attributes under a no-publish constraint", () => {
	const result = assessTaskPlanQuality([
		{ title: "Ready to publish", goal: "Draft ready-to-publish copy; do not publish it.", acceptanceCriteria: "Returns the complete copy as text." },
		{ title: "Chinese ready copy", goal: "生成可直接发布的文案，但不要发布。", acceptanceCriteria: "返回完整中文文案文本。" },
	]);
	assert.deepEqual(result, { accepted: true, issues: [] });
});

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

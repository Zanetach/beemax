import test from "node:test";
import assert from "node:assert/strict";
import { FullWorkbench } from "../dist/full-workbench.js";

test("full workbench renders persistent state, activity, and a structured approval panel", () => {
	const workbench = new FullWorkbench({ profile: "personal", model: "openai/gpt", session: "local-1", details: "expanded" });
	workbench.user("write a report");
	workbench.event({ type: "tool.changed", turnId: "t", callId: "1", name: "write", state: "running", at: 1, sessionId: "s", scope: { profileId: "personal", platform: "cli", chatId: "local" }, sequence: 1 }, "工具 write · running");
	workbench.event({ type: "approval.requested", turnId: "t", toolName: "write", at: 2, sessionId: "s", scope: { profileId: "personal", platform: "cli", chatId: "local" }, sequence: 2, details: { target: "report.md", risk: "高", impact: "modifies file", reversibility: "reversible", argsSummary: "{}" } }, "工具 write · running");
	workbench.setPicker("Model Picker · /model <number>", ["1. openai/gpt", "2. anthropic/claude"]);
	workbench.setSubagents([{ id: "sub-1", name: "research", goal: "inspect architecture", capability: "research", status: "running", createdAt: 1, startedAt: 1, timeoutMs: 60_000 }]);
	const screen = workbench.render(80, 30);
	assert.match(screen, /BeeMax Workbench/);
	assert.match(screen, /Transcript/);
	assert.match(screen, /Activity/);
	assert.match(screen, /Approval/);
	assert.match(screen, /report\.md/);
	assert.match(screen, /Composer/);
	assert.match(screen, /Model Picker/);
	assert.match(screen, /Sub-Agents/);
	assert.match(screen, /inspect architecture/);
	assert.equal(workbench.pendingApprovalRequest()?.toolName, "write");
	workbench.event({ type: "approval.resolved", turnId: "t", toolName: "write", allowed: false, at: 3, sessionId: "s", scope: { profileId: "personal", platform: "cli", chatId: "local" }, sequence: 3 }, "工具 write · running");
	assert.equal(workbench.pendingApprovalRequest(), undefined);
});

test("full workbench distinguishes an incomplete Objective from a completed Turn", () => {
	const workbench = new FullWorkbench({ profile: "personal", model: "test/model", session: "local-1", details: "collapsed" });
	workbench.event({
		type: "turn.finished", turnId: "t", at: 1, sessionId: "s", scope: { profileId: "personal", platform: "cli", chatId: "local" }, sequence: 1,
		result: { answer: "任务尚未完成", model: "test/model", durationMs: 1, usage: {}, outcome: { status: "verification_unavailable", objectiveId: "objective:1" } },
	}, "");
	assert.match(workbench.render(80, 20), /incomplete/);
	assert.doesNotMatch(workbench.render(80, 20), / · completed/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { FullWorkbench } from "../dist/full-workbench.js";

test("full workbench renders persistent state, activity, and a structured approval panel", () => {
	const workbench = new FullWorkbench({ profile: "personal", model: "openai/gpt", session: "local-1", details: "expanded" });
	workbench.user("write a report");
	workbench.event({ type: "tool.changed", turnId: "t", callId: "1", name: "write", state: "running", at: 1, sessionId: "s", scope: { profileId: "personal", platform: "cli", chatId: "local" }, sequence: 1 }, "工具 write · running");
	workbench.event({ type: "approval.requested", turnId: "t", toolName: "write", at: 2, sessionId: "s", scope: { profileId: "personal", platform: "cli", chatId: "local" }, sequence: 2, details: { target: "report.md", risk: "高", impact: "modifies file", reversibility: "reversible", argsSummary: "{}" } }, "工具 write · running");
	workbench.setPicker("Model Picker · /model <number>", ["1. openai/gpt", "2. anthropic/claude"]);
	const screen = workbench.render(80, 30);
	assert.match(screen, /BeeMax Workbench/);
	assert.match(screen, /Transcript/);
	assert.match(screen, /Activity/);
	assert.match(screen, /Approval/);
	assert.match(screen, /report\.md/);
	assert.match(screen, /Composer/);
	assert.match(screen, /Model Picker/);
});

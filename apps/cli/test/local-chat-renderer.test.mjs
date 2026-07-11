import assert from "node:assert/strict";
import test from "node:test";
import { LocalActivityPresenter, LocalReasoningPresenter, parseChatCommand, parseReasoningCommand } from "../dist/local-chat-renderer.js";

test("reasoning visibility keeps raw thought separate and makes summaries opt-in", () => {
	const off = new LocalReasoningPresenter("off");
	assert.equal(off.thinking("hidden"), "");
	assert.equal(off.beforeAnswer(), "");

	const summary = new LocalReasoningPresenter("summary");
	assert.equal(summary.thinking("first"), "\n思考中…");
	assert.equal(summary.thinking("second"), "");
	assert.equal(summary.beforeAnswer(), "\r\x1b[2K");

	const pipedSummary = new LocalReasoningPresenter("summary", false);
	assert.equal(pipedSummary.thinking("hidden"), "");
	assert.equal(pipedSummary.beforeAnswer(), "");

	const raw = new LocalReasoningPresenter("raw");
	assert.equal(raw.thinking("first"), "\n思考：\nfirst");
	assert.equal(raw.thinking("second"), "second");
	assert.equal(raw.beforeAnswer(), "\n\n");
	assert.equal(raw.thinking("late reasoning"), "");
});

test("reasoning commands follow the session visibility pattern", () => {
	assert.deepEqual(parseReasoningCommand("/reasoning"), { kind: "status" });
	assert.deepEqual(parseReasoningCommand("/reason raw"), { kind: "set", display: "raw" });
	assert.deepEqual(parseReasoningCommand("/reasoning hidden"), { kind: "invalid" });
	assert.equal(parseReasoningCommand("hello"), undefined);
});

test("chat controls expose a small, explicit console contract", () => {
	assert.deepEqual(parseChatCommand("/help"), { kind: "help" });
	assert.deepEqual(parseChatCommand("/status"), { kind: "status" });
	assert.deepEqual(parseChatCommand("/new"), { kind: "new" });
	assert.deepEqual(parseChatCommand("/reset"), { kind: "reset" });
	assert.deepEqual(parseChatCommand("/stop"), { kind: "stop" });
	assert.deepEqual(parseChatCommand("/compact"), { kind: "compact" });
	assert.deepEqual(parseChatCommand("/usage"), { kind: "usage" });
	assert.deepEqual(parseChatCommand("/sessions"), { kind: "sessions" });
	assert.deepEqual(parseChatCommand("/models"), { kind: "models" });
	assert.deepEqual(parseChatCommand("/retry"), { kind: "retry" });
	assert.deepEqual(parseChatCommand("/tools"), { kind: "tools" });
	assert.deepEqual(parseChatCommand("/history"), { kind: "history", limit: undefined });
	assert.deepEqual(parseChatCommand("/history 12"), { kind: "history", limit: 12 });
	assert.deepEqual(parseChatCommand("/resume local-123"), { kind: "resume", sessionId: "local-123" });
	assert.deepEqual(parseChatCommand("/think high"), { kind: "think", level: "high" });
	assert.deepEqual(parseChatCommand("/think"), { kind: "think", level: undefined });
	assert.deepEqual(parseChatCommand("/details hidden"), { kind: "details", mode: "hidden" });
	assert.deepEqual(parseChatCommand("/details collapsed"), { kind: "details", mode: "collapsed" });
	assert.deepEqual(parseChatCommand("/details"), { kind: "details", mode: "status" });
	assert.deepEqual(parseChatCommand("hello"), undefined);
});

test("tool activity remains separate from the answer stream", () => {
	const presenter = new LocalActivityPresenter("expanded");
	assert.equal(presenter.event({ type: "tool.changed", turnId: "t", callId: "1", name: "web_search", state: "running" }), "\n工具 web_search 运行中…\n");
	assert.equal(presenter.event({ type: "tool.changed", turnId: "t", callId: "1", name: "web_search", state: "completed" }), "\n工具 web_search 完成\n");
	assert.equal(presenter.event({ type: "tool.changed", turnId: "t", callId: "2", name: "task_spawn", state: "running" }), "\n子代理 task_spawn 运行中…\n");
	assert.equal(new LocalActivityPresenter("collapsed").event({ type: "tool.changed", turnId: "t", callId: "1", name: "bash", state: "running" }), "");
	assert.equal(new LocalActivityPresenter("collapsed").event({ type: "tool.changed", turnId: "t", callId: "1", name: "bash", state: "completed" }), "\n工具 bash 完成\n");
	assert.equal(new LocalActivityPresenter("hidden", false).event({ type: "tool.changed", turnId: "t", callId: "1", name: "bash", state: "running" }), "");
	assert.equal(presenter.event({ type: "approval.requested", turnId: "t", toolName: "write", at: 1 }), "\n等待审批：工具 write。可输入 /stop 取消。\n");
	assert.equal(presenter.event({ type: "approval.resolved", turnId: "t", toolName: "write", allowed: true, at: 2 }), "\n审批已允许，继续执行。\n");
});

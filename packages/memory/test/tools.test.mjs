import test from "node:test";
import assert from "node:assert/strict";
import { canAutomaticallyUnderstand, createMemoryTools } from "../dist/index.js";

test("automatic long-term understanding requires stable, non-sensitive source evidence", () => {
	assert.equal(canAutomaticallyUnderstand("用户默认使用中文", 0.9, "high", "以后默认中文回复"), true);
	assert.equal(canAutomaticallyUnderstand("用户默认使用中文", 0.7, "high", "以后默认中文回复"), false);
	assert.equal(canAutomaticallyUnderstand("用户默认使用中文", 0.9, "medium", "我的身份证是 123456789012345678"), false);
	assert.equal(canAutomaticallyUnderstand("用户银行卡号是 1234", 0.9, "high", "请记住这个"), false);
	assert.equal(canAutomaticallyUnderstand("用户默认使用中文", 0.9, "high", "我的密码是 abc"), false);
	assert.equal(canAutomaticallyUnderstand("用户默认使用中文", 0.9, "high", "我的手机号是 13800138000"), false);
	assert.equal(canAutomaticallyUnderstand("用户默认使用中文", 0.9, "high", "我有高血压"), false);
});

test("memory tools declare intelligent write and destructive approval policies", () => {
	let remembered = 0;
	const store = { stats: () => ({ curated: 0, pending: 0, promoted: 0, rejected: 0 }), listCandidates: () => [], promoteCandidate: () => false, rejectCandidate: () => false, remember: () => { remembered++; return "id"; }, recall: () => [], list: () => [], forget: () => false };
	const tools = createMemoryTools(store, { platform: "cli", chatId: "local", chatType: "dm", userId: "local" });
	assert.equal(tools.find((tool) => tool.name === "memory_recall").beemaxPolicy.approval, "never");
	assert.equal(tools.find((tool) => tool.name === "memory_understand").beemaxPolicy.approval, "never");
	assert.equal(tools.find((tool) => tool.name === "memory_understand").beemaxPolicy.sideEffect, "local");
	assert.equal(tools.find((tool) => tool.name === "memory_forget").beemaxPolicy.reversible, false);
	return tools.find((tool) => tool.name === "memory_remember").execute("call", { content: "我的密码是 private-secret" }).then((result) => {
		assert.match(result.content[0].text, /Refused/);
		assert.equal(remembered, 0);
	});
});

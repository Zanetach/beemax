import test from "node:test";
import assert from "node:assert/strict";
import { canAutomaticallyUnderstand } from "../dist/index.js";

test("automatic long-term understanding requires stable, non-sensitive source evidence", () => {
	assert.equal(canAutomaticallyUnderstand("用户默认使用中文", 0.9, "high", "以后默认中文回复"), true);
	assert.equal(canAutomaticallyUnderstand("用户默认使用中文", 0.7, "high", "以后默认中文回复"), false);
	assert.equal(canAutomaticallyUnderstand("用户默认使用中文", 0.9, "medium", "我的身份证是 123456789012345678"), false);
	assert.equal(canAutomaticallyUnderstand("用户银行卡号是 1234", 0.9, "high", "请记住这个"), false);
});

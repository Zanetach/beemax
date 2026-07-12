import assert from "node:assert/strict";
import test from "node:test";
import { TurnStatusPulse } from "../dist/core/turn-status.js";

test("TurnStatusPulse acknowledges immediately and reports truthful waiting time", async () => {
	const statuses = [];
	const pulse = new TurnStatusPulse((message) => { statuses.push(message); }, { thresholdsMs: [10, 20], repeatMs: 1_000 });
	pulse.start();
	assert.deepEqual(statuses, ["已收到 · 正在理解需求"]);
	await new Promise((resolve) => setTimeout(resolve, 35));
	pulse.stop();
	assert.ok(statuses.some((message) => message.startsWith("等待模型响应")));
});

test("TurnStatusPulse switches to composing and stops waiting updates", async () => {
	const statuses = [];
	const pulse = new TurnStatusPulse((message) => { statuses.push(message); }, { thresholdsMs: [20], repeatMs: 1_000 });
	pulse.start();
	pulse.contentStarted();
	await new Promise((resolve) => setTimeout(resolve, 35));
	pulse.stop();
	assert.deepEqual(statuses, ["已收到 · 正在理解需求", "正在组织回答"]);
});

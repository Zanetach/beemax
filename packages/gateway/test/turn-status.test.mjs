import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveTextBuffer, TurnStatusPulse } from "../../core/dist/index.js";

test("AdaptiveTextBuffer can surface a tiny first answer within its bounded wait", async () => {
	const chunks = [];
	const buffer = new AdaptiveTextBuffer((chunk) => { chunks.push(chunk); }, { minChunkChars: 6, maxWaitMs: 50, flushSmallOnMaxWait: true });
	buffer.push("好的"); await new Promise((resolve) => setTimeout(resolve, 70)); await buffer.close();
	assert.deepEqual(chunks, ["好的"]);
});

test("TurnStatusPulse acknowledges immediately and reports truthful waiting time", async () => {
	const statuses = [];
	const pulse = new TurnStatusPulse((message) => { statuses.push(message); }, { thresholdsMs: [10, 20], repeatMs: 1_000 });
	pulse.start();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(statuses, ["已收到 · 正在理解需求"]);
	await new Promise((resolve) => setTimeout(resolve, 35));
	await pulse.stop();
	assert.ok(statuses.some((message) => message.startsWith("等待模型响应")));
});

test("TurnStatusPulse switches to composing and stops waiting updates", async () => {
	const statuses = [];
	const pulse = new TurnStatusPulse((message) => { statuses.push(message); }, { thresholdsMs: [20], repeatMs: 1_000 });
	pulse.start();
	pulse.contentStarted();
	await new Promise((resolve) => setTimeout(resolve, 35));
	await pulse.stop();
	assert.deepEqual(statuses, ["已收到 · 正在理解需求", "正在组织回答"]);
});

test("TurnStatusPulse serializes async presenter updates and surfaces failures on stop", async () => {
	const order = [];
	const pulse = new TurnStatusPulse(async (message) => {
		if (message.includes("理解")) await new Promise((resolve) => setTimeout(resolve, 20));
		order.push(message);
		if (message.includes("组织")) throw new Error("presenter failed");
	});
	pulse.start();
	pulse.contentStarted();
	await assert.rejects(pulse.stop(), /presenter failed/);
	assert.deepEqual(order, ["已收到 · 正在理解需求", "正在组织回答"]);
});

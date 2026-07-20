import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveTextBuffer } from "../dist/index.js";

test("AdaptiveTextBuffer emits the first readable chunk quickly and aggregates later chunks", async () => {
	const chunks = [];
	const buffer = new AdaptiveTextBuffer((chunk) => { chunks.push(chunk); }, {
		minChunkChars: 24,
		initialPreferredChunkChars: 48,
		preferredChunkChars: 120,
		maxChunkChars: 240,
		initialMaxWaitMs: 50,
		maxWaitMs: 250,
		flushSmallOnMaxWait: true,
	});

	buffer.push("首块需要尽快显示给用户这是首块内容");
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(chunks.length, 1);
	buffer.push("后续内容应该先聚合成更大的语义块");
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(chunks.length, 1, "later small deltas should wait for a larger semantic chunk");
	buffer.push(`${"继续补充正文内容".repeat(12)}。`);
	await buffer.flush();
	assert.equal(chunks.length, 2);
	assert.match(chunks[1], /后续内容应该先聚合/);
	await buffer.close();
});

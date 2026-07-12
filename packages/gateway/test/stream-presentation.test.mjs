import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveTextBuffer } from "../../core/dist/index.js";

test("AdaptiveTextBuffer hides tiny token deltas and commits readable sentences", async () => {
	const chunks = [];
	const buffer = new AdaptiveTextBuffer((chunk) => { chunks.push(chunk); }, { minChunkChars: 6, preferredChunkChars: 10, maxWaitMs: 50 });
	for (const delta of ["这个", "问题", "主要", "有三个", "原因。", "下一句", "还没完成"]) buffer.push(delta);
	assert.deepEqual(chunks, []);
	await buffer.flush();
	assert.deepEqual(chunks, ["这个问题主要有三个原因。", "下一句还没完成"]);
});

test("AdaptiveTextBuffer commits a stalled readable chunk after bounded wait", async () => {
	const chunks = [];
	const buffer = new AdaptiveTextBuffer((chunk) => { chunks.push(chunk); }, { minChunkChars: 6, preferredChunkChars: 20, maxWaitMs: 20 });
	buffer.push("这是一段暂时没有标点的内容");
	await new Promise((resolve) => setTimeout(resolve, 70));
	assert.deepEqual(chunks, ["这是一段暂时没有标点的内容"]);
	await buffer.close();
});

test("AdaptiveTextBuffer keeps incomplete Markdown code fences private until complete", async () => {
	const chunks = [];
	const buffer = new AdaptiveTextBuffer((chunk) => { chunks.push(chunk); }, { minChunkChars: 4, preferredChunkChars: 4, maxWaitMs: 20 });
	buffer.push("```ts\nconst value = 1;");
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.deepEqual(chunks, []);
	buffer.push("\n```\n");
	await buffer.flush();
	assert.deepEqual(chunks, ["```ts\nconst value = 1;\n```\n"]);
});

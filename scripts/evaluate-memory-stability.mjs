import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEnvelope, FileExecutionTraceStore, FileInteractionInputQueueStore } from "../packages/core/dist/index.js";
import { CardSession } from "../packages/channel-feishu/dist/index.js";

if (typeof global.gc !== "function") throw new Error("memory stability gate requires node --expose-gc");

const root = mkdtempSync(join(tmpdir(), "beemax-memory-stability-"));
try {
	global.gc();
	const baseline = process.memoryUsage();
	const traces = new FileExecutionTraceStore(join(root, "execution-trace.jsonl"), 100);
	for (let index = 0; index < 5_000; index++) {
		const executionEnvelope = createExecutionEnvelope({ executionId: `execution:${index}`, trigger: { kind: "interaction" }, mode: "normal" });
		traces.record({ type: "execution.started", executionEnvelope, at: index });
	}
	assert.ok(traces.sequenceCacheSize <= 100, `execution sequence cache grew to ${traces.sequenceCacheSize}`);
	const queuePath = join(root, "interaction-inputs.json");
	const queue = new FileInteractionInputQueueStore(queuePath, { maxRecords: 500, maxBytes: 2 * 1024 * 1024 });
	for (let index = 0; index < 1_000; index++) queue.enqueue({
		id: `input:${index}`, key: `conversation:${index}`, text: "queued", createdAt: index,
		source: { platform: "cli", chatId: `chat:${index}`, chatType: "dm", userId: `user:${index}` },
	});
	assert.equal(queue.all().length, 500);
	assert.ok(statSync(queuePath).size <= 2 * 1024 * 1024);

	const card = new CardSession();
	for (let index = 0; index < 2_000; index++) card.apply("answer.delta", { text: "x".repeat(1_000) });
	assert.ok(card.answerText.length <= 200_100, `streaming answer retained ${card.answerText.length} characters`);

	global.gc();
	const final = process.memoryUsage();
	const heapGrowth = Math.max(0, final.heapUsed - baseline.heapUsed);
	const rssGrowth = Math.max(0, final.rss - baseline.rss);
	const mib = 1024 * 1024;
	assert.ok(heapGrowth < 64 * mib, `heap grew by ${(heapGrowth / mib).toFixed(1)} MiB`);
	assert.ok(rssGrowth < 128 * mib, `RSS grew by ${(rssGrowth / mib).toFixed(1)} MiB`);
	process.stdout.write(`${JSON.stringify({ passed: true, samples: 8_000, sequenceCacheSize: traces.sequenceCacheSize, queuedInputs: queue.all().length, answerChars: card.answerText.length, heapGrowthBytes: heapGrowth, rssGrowthBytes: rssGrowth })}\n`);
} finally {
	rmSync(root, { recursive: true, force: true });
}

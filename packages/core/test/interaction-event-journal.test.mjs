import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileInteractionEventJournal, InteractionEventAdapter } from "../dist/index.js";

const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };

test("durable interaction recovery excludes answer and reasoning content while preserving sequence", async () => {
	const dir = mkdtempSync(join(tmpdir(), "beemax-interaction-journal-"));
	try {
		const journal = new FileInteractionEventJournal(join(dir, "events.jsonl"));
		const runtime = {
			async run(_input, sink) {
				await sink({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "sensitive answer" } });
				await sink({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } });
				return { answer: "sensitive answer", model: "test/model", durationMs: 1, usage: {} };
			},
			async cancel() { return false; }, async modelStatus() { return undefined; }, async usage() { return undefined; },
		};
		const first = new InteractionEventAdapter(runtime, { profileId: "personal", eventJournal: journal });
		await first.dispatch({ type: "message.send", source, text: "private question", input: { timeoutMs: 1_000 } });
		const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
		assert.doesNotMatch(raw, /sensitive answer|private reasoning|private question/);
		const sessionId = first.events(source)[0].sessionId;
		assert.deepEqual(journal.events(sessionId).map((event) => event.type), ["turn.started", "turn.finished"]);

		const recovered = new InteractionEventAdapter(runtime, { profileId: "personal", eventJournal: journal });
		assert.deepEqual(recovered.events(source).map((event) => event.sequence), [1, 4]);
		const next = [];
		await recovered.dispatch({ type: "message.send", source, text: "next", input: { timeoutMs: 1_000 } }, (event) => { next.push(event.sequence); });
		assert.equal(next[0], 5);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

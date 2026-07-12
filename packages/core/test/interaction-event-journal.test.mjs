import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
		const sessionId = first.events(source)[0].sessionId;
		const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
		assert.doesNotMatch(raw, /sensitive answer|private reasoning|private question/);
		journal.append({ type: "approval.requested", sessionId: "other-session", scope: { profileId: "personal", platform: "cli", chatId: "local" }, turnId: "t", at: 1, sequence: 99, toolName: "write", details: { target: "private-file.txt", risk: "高", impact: "private", reversibility: "private", argsSummary: "secret=value" } });
		assert.doesNotMatch(readFileSync(join(dir, "events.jsonl"), "utf8"), /private-file|secret=value/);
		assert.deepEqual(journal.events(sessionId).map((event) => event.type), ["turn.started", "turn.finished"]);

		const reopenedJournal = new FileInteractionEventJournal(join(dir, "events.jsonl"));
		assert.equal(reopenedJournal.lastSequence(sessionId), 4);
		const recovered = new InteractionEventAdapter(runtime, { profileId: "personal", eventJournal: reopenedJournal });
		assert.deepEqual(recovered.events(source).map((event) => event.sequence), [1, 4]);
		const next = [];
		await recovered.dispatch({ type: "message.send", source, text: "next", input: { timeoutMs: 1_000 } }, (event) => { next.push(event.sequence); });
		assert.equal(next[0], 5);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interaction journal tightens existing permissions and compacts with append headroom", () => {
	const dir = mkdtempSync(join(tmpdir(), "beemax-interaction-journal-bounds-"));
	try {
		const path = join(dir, "events.jsonl");
		writeFileSync(path, "", { mode: 0o644 });
		chmodSync(path, 0o644);
		const journal = new FileInteractionEventJournal(path, 20);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		for (let sequence = 1; sequence <= 21; sequence++) journal.append(event(sequence));
		assert.deepEqual(journal.events("session").map((item) => item.sequence), Array.from({ length: 16 }, (_, index) => index + 6));
		assert.equal(journal.lastSequence("session"), 21);
		assert.equal(statSync(`${path}.sequences.json`).mode & 0o777, 0o600);
		assert.equal(new FileInteractionEventJournal(path, 20).lastSequence("session"), 21);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interaction event journal prunes sequence entries with compacted sessions", () => {
	const dir = mkdtempSync(join(tmpdir(), "beemax-event-journal-index-"));
	try {
		const path = join(dir, "events.jsonl");
		const journal = new FileInteractionEventJournal(path, 20);
		for (let index = 0; index < 100; index++) journal.append({ ...event(1), sessionId: `session-${index}` });
		const reopened = new FileInteractionEventJournal(path, 20);
		assert.ok(reopened.lastSequence("session-0") >= 1);
		assert.equal(reopened.lastSequence("session-99"), 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

function event(sequence) {
	return { type: "turn.started", sessionId: "session", scope: { profileId: "personal", platform: "cli", chatId: "local" }, turnId: `turn-${sequence}`, at: sequence, sequence };
}

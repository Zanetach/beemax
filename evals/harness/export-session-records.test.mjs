import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectSessionFiles, exportSessions, parseArgs, serializeRecords, turnsFromEntries } from "./export-session-records.mjs";

const HEADER = { type: "session", id: "session-1", timestamp: "2026-07-15T08:00:00.000Z", cwd: "/tmp" };

function messageEntry(message, id) {
	return { type: "message", id, parentId: null, timestamp: "2026-07-15T08:00:00.000Z", message };
}

function assistantMessage(content, usage = {}) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.001 }, ...usage },
		stopReason: "stop",
		timestamp: 1_784_000_000_000,
	};
}

function fixtureLines() {
	return [
		HEADER,
		messageEntry({ role: "user", content: "[memory context]\n\nWhat is the weather?", timestamp: 1_784_000_000_000 }, "e1"),
		messageEntry(assistantMessage([
			{ type: "thinking", thinking: "should call the tool" },
			{ type: "toolCall", id: "call-1", name: "web_search", arguments: { query: "weather" } },
		]), "e2"),
		messageEntry({
			role: "toolResult", toolCallId: "call-1", toolName: "web_search",
			content: [{ type: "text", text: "Sunny, 25C" }], isError: false, timestamp: 1_784_000_001_000,
		}, "e3"),
		messageEntry(assistantMessage([{ type: "text", text: "It is sunny and 25C." }]), "e4"),
		messageEntry({ role: "user", content: [{ type: "text", text: "Thanks" }, { type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1_784_000_002_000 }, "e5"),
		messageEntry(assistantMessage([{ type: "text", text: "You are welcome." }]), "e6"),
	];
}

test("groups one record per user turn with tool call, matched result, output, and usage", () => {
	const entries = fixtureLines().slice(1);
	const turns = turnsFromEntries(entries);
	assert.equal(turns.length, 2);

	const first = turns[0];
	assert.equal(first.input.text, "[memory context]\n\nWhat is the weather?");
	assert.equal(first.toolCalls.length, 1);
	assert.deepEqual(first.toolCalls[0].arguments, { query: "weather" });
	assert.equal(first.toolCalls[0].result.text, "Sunny, 25C");
	assert.equal(first.toolCalls[0].result.isError, false);
	assert.equal(first.output.text, "It is sunny and 25C.");
	assert.equal(first.output.stopReason, "stop");
	assert.equal(first.model, "anthropic/claude-sonnet-5");
	assert.equal(first.usage.totalTokens, 240);
	assert.equal(first.usage.costUsd, 0.002);
	assert.equal(first.notes, undefined);
	assert.equal(first.output.thinking, undefined);

	const second = turns[1];
	assert.equal(second.input.text, "Thanks");
	assert.equal(second.input.images, 1);
	assert.equal(second.toolCalls.length, 0);
	assert.equal(second.output.text, "You are welcome.");
});

test("includes thinking only when requested", () => {
	const entries = fixtureLines().slice(1);
	const turns = turnsFromEntries(entries, { includeThinking: true });
	assert.equal(turns[0].output.thinking, "should call the tool");
});

test("records orphan tool results and compaction as notes", () => {
	const turns = turnsFromEntries([
		messageEntry({ role: "user", content: "hi", timestamp: 1 }, "e1"),
		{ type: "compaction", id: "e2", parentId: "e1", timestamp: "t", summary: "s", firstKeptEntryId: "e1", tokensBefore: 9000 },
		messageEntry({ role: "toolResult", toolCallId: "missing", toolName: "web_search", content: [{ type: "text", text: "x" }], isError: true, timestamp: 2 }, "e3"),
	]);
	assert.equal(turns.length, 1);
	assert.ok(turns[0].notes.some((note) => note.includes("compaction: 9000")));
	assert.ok(turns[0].notes.some((note) => note.includes("orphan tool result: web_search")));
});

test("captures custom context injections", () => {
	const turns = turnsFromEntries([
		messageEntry({ role: "user", content: "hi", timestamp: 1 }, "e1"),
		{ type: "custom_message", id: "e2", parentId: "e1", timestamp: "t", customType: "beemax", content: "injected context", display: false },
	]);
	assert.deepEqual(turns[0].contextInjections, ["injected context"]);
});

test("exports session files end to end and serializes deterministically", async () => {
	const dir = await mkdtemp(join(tmpdir(), "beemax-eval-harness-"));
	try {
		const nested = join(dir, "feishu");
		await writeFile(join(dir, "ignored.json"), "{}", "utf8");
		const sessionPath = join(nested, "session-a.jsonl");
		await import("node:fs/promises").then(({ mkdir }) => mkdir(nested, { recursive: true }));
		await writeFile(sessionPath, fixtureLines().map((line) => JSON.stringify(line)).join("\n") + "\nnot-json\n", "utf8");

		const files = collectSessionFiles(dir);
		assert.deepEqual(files, [sessionPath]);

		const { records, warnings } = exportSessions(files);
		assert.equal(records.length, 2);
		assert.equal(records[0].sessionId, "session-1");
		assert.equal(records[0].sessionFile, sessionPath);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /malformed lines 8/);

		const jsonl = serializeRecords(records, "jsonl");
		assert.equal(jsonl.trim().split("\n").length, 2);
		for (const line of jsonl.trim().split("\n")) JSON.parse(line);
		const json = JSON.parse(serializeRecords(records, "json"));
		assert.equal(json.length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("rejects unknown arguments and unsupported formats", () => {
	assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
	assert.throws(() => parseArgs(["--format", "csv"]), /Unsupported --format/);
	const options = parseArgs(["--profile", "personal", "--include-thinking"]);
	assert.equal(options.profile, "personal");
	assert.equal(options.includeThinking, true);
});

#!/usr/bin/env node
/**
 * Standalone eval-harness exporter.
 *
 * Reads Pi session transcripts (JSONL) from a BeeMax Profile and writes one
 * inspection record per conversation turn containing:
 *   - the assembled input prompt the model actually received,
 *   - every tool call with its full arguments and matched tool result,
 *   - the final assistant output plus aggregated usage (tokens/cost).
 *
 * Intentionally imports nothing from the workspace so it can run against any
 * Profile without building first.
 *
 * Usage:
 *   node evals/harness/export-session-records.mjs --profile personal
 *   node evals/harness/export-session-records.mjs --sessions <dir-or-file> --out records.jsonl
 *
 * Notes:
 *   - Entries are processed in file order. Pi sessions support branching via
 *     parentId, but BeeMax appends linearly; branch-aware replay is out of scope.
 *   - Records contain full prompt/tool/result content. Treat the output file as
 *     sensitive Profile data.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
	const options = { profile: undefined, sessions: undefined, out: undefined, includeThinking: false, format: "jsonl" };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const next = () => {
			const value = argv[++index];
			if (value === undefined) throw new Error(`Missing value for ${flag}`);
			return value;
		};
		if (flag === "--profile") options.profile = next();
		else if (flag === "--sessions") options.sessions = next();
		else if (flag === "--out") options.out = next();
		else if (flag === "--format") options.format = next();
		else if (flag === "--include-thinking") options.includeThinking = true;
		else if (flag === "--help" || flag === "-h") options.help = true;
		else throw new Error(`Unknown argument: ${flag}`);
	}
	if (options.format !== "jsonl" && options.format !== "json") throw new Error(`Unsupported --format: ${options.format}`);
	return options;
}

export function sessionsRootForProfile(profile, env = process.env) {
	const home = resolve(env.BEEMAX_HOME?.trim() || join(homedir(), ".beemax"));
	return join(home, "profiles", profile, "sessions");
}

/** A directory yields every *.jsonl under it (recursive, sorted); a file yields itself. */
export function collectSessionFiles(path) {
	const target = resolve(path);
	if (statSync(target).isFile()) return [target];
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const child = join(dir, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
		}
	};
	walk(target);
	return files;
}

function textAndImages(content) {
	if (typeof content === "string") return { text: content, images: 0 };
	if (!Array.isArray(content)) return { text: "", images: 0 };
	const text = content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
	const images = content.filter((block) => block?.type === "image").length;
	return { text, images };
}

function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
}

function addUsage(total, usage) {
	if (!usage) return total;
	total.input += usage.input ?? 0;
	total.output += usage.output ?? 0;
	total.cacheRead += usage.cacheRead ?? 0;
	total.cacheWrite += usage.cacheWrite ?? 0;
	total.totalTokens += usage.totalTokens ?? 0;
	total.costUsd += usage.cost?.total ?? 0;
	return total;
}

/** Group session entries into per-turn records: user input → tool calls → final output. */
export function turnsFromEntries(entries, { includeThinking = false } = {}) {
	const turns = [];
	let current;
	const finish = () => {
		if (!current) return;
		current.usage.costUsd = Number(current.usage.costUsd.toFixed(6));
		if (includeThinking && current.thinking.length && current.output) current.output.thinking = current.thinking.join("\n");
		delete current.thinking;
		if (!current.notes.length) delete current.notes;
		if (!current.contextInjections.length) delete current.contextInjections;
		turns.push(current);
		current = undefined;
	};
	const ensureTurn = (note) => {
		if (current) return current;
		current = newTurn({ text: "", images: 0 }, undefined);
		current.notes.push(note);
		return current;
	};
	const newTurn = (input, timestamp) => ({
		turn: turns.length + (current ? 2 : 1),
		startedAt: timestamp ? new Date(timestamp).toISOString() : undefined,
		input,
		contextInjections: [],
		toolCalls: [],
		output: undefined,
		model: undefined,
		usage: emptyUsage(),
		notes: [],
		thinking: [],
	});

	for (const entry of entries) {
		if (entry.type === "compaction") {
			ensureTurn("entries-before-first-user-message").notes.push(`compaction: ${entry.tokensBefore ?? "?"} tokens summarized`);
			continue;
		}
		if (entry.type === "custom_message") {
			const { text } = textAndImages(entry.content);
			if (text) ensureTurn("entries-before-first-user-message").contextInjections.push(text);
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") {
			finish();
			current = newTurn(textAndImages(message.content), message.timestamp);
			continue;
		}
		if (message.role === "assistant") {
			const turn = ensureTurn("assistant-message-without-user-input");
			const texts = [];
			for (const block of message.content ?? []) {
				if (block?.type === "text") texts.push(block.text ?? "");
				else if (block?.type === "thinking") turn.thinking.push(block.thinking ?? "");
				else if (block?.type === "toolCall") turn.toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments ?? {}, result: undefined });
			}
			turn.model = `${message.provider ?? "?"}/${message.model ?? "?"}`;
			addUsage(turn.usage, message.usage);
			const output = { text: texts.join("\n"), stopReason: message.stopReason };
			if (message.errorMessage) output.errorMessage = message.errorMessage;
			if (output.text || !turn.output) turn.output = output;
			continue;
		}
		if (message.role === "toolResult") {
			const turn = ensureTurn("tool-result-without-user-input");
			const call = [...turn.toolCalls].reverse().find((candidate) => candidate.id === message.toolCallId && candidate.result === undefined);
			const { text, images } = textAndImages(message.content);
			const result = { text, isError: message.isError === true, chars: text.length, ...(images ? { images } : {}) };
			if (call) call.result = result;
			else turn.notes.push(`orphan tool result: ${message.toolName} (${message.toolCallId})`);
			continue;
		}
		// Custom agent-message roles (extensions) participate in context; keep them inspectable.
		const { text } = textAndImages(message.content);
		if (text) ensureTurn("entries-before-first-user-message").contextInjections.push(text);
	}
	finish();
	return turns;
}

export function parseSessionFile(path) {
	const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
	let header;
	const entries = [];
	const malformed = [];
	for (const [index, line] of lines.entries()) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			malformed.push(index + 1);
			continue;
		}
		if (parsed?.type === "session") header = parsed;
		else entries.push(parsed);
	}
	return { header, entries, malformed };
}

export function exportSessions(files, options = {}) {
	const records = [];
	const warnings = [];
	for (const file of files) {
		const { header, entries, malformed } = parseSessionFile(file);
		if (malformed.length) warnings.push(`${file}: skipped malformed lines ${malformed.join(", ")}`);
		for (const turn of turnsFromEntries(entries, options)) {
			records.push({ sessionFile: file, sessionId: header?.id, ...turn });
		}
	}
	return { records, warnings };
}

export function serializeRecords(records, format) {
	if (format === "json") return `${JSON.stringify(records, null, "\t")}\n`;
	return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log("Usage: export-session-records.mjs [--profile <name> | --sessions <dir-or-file>] [--out <file>] [--format jsonl|json] [--include-thinking]");
		return;
	}
	const root = options.sessions ?? (options.profile ? sessionsRootForProfile(options.profile) : undefined);
	if (!root) throw new Error("Provide --profile <name> or --sessions <dir-or-file>");
	const files = collectSessionFiles(root);
	if (!files.length) throw new Error(`No session .jsonl files found under ${root}`);
	const { records, warnings } = exportSessions(files, { includeThinking: options.includeThinking });
	for (const warning of warnings) console.warn(`warning: ${warning}`);
	const out = resolve(options.out ?? join("evals", "harness", "out", "session-records.jsonl"));
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, serializeRecords(records, options.format), "utf8");
	console.log(`Exported ${records.length} turn(s) from ${files.length} session file(s) to ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

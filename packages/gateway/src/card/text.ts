/**
 * Stream text normalization + markdown block splitting.
 * Faithful TS port of the hermes-feishu-streaming-card rendering logic.
 */

const THINK_TAG_RE = /<\/?think>|<\/?thinking>/gi;
const THINK_TAGS = ["<think>", "</think>", "<thinking>", "</thinking>"];
const FENCE_RE = /^\s*```/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const LIST_BOUNDARY_RE = /\n(?:[-*]|\d+\.) /;

export const MAX_CARD_TABLES = 5;

/** Strip model thinking tags, keep user-readable content. */
export function normalizeStreamText(text: string): string {
	return THINK_TAG_RE.test(text) ? text.replace(THINK_TAG_RE, "") : text ?? "";
}

/**
 * Filter thinking tags that may be split across streaming chunks.
 * feed(delta) returns the safe (emit-able) portion and buffers the rest.
 */
export class StreamingTextNormalizer {
	private pending = "";

	feed(delta: string): string {
		const text = this.pending + (delta ?? "");
		const [safe, next] = splitSafeText(text);
		this.pending = next;
		return normalizeStreamText(safe);
	}
}

function splitSafeText(text: string): [string, string] {
	const lower = text.toLowerCase();
	let pendingLen = 0;
	for (const tag of THINK_TAGS) {
		for (let i = 1; i < tag.length; i++) {
			if (lower.endsWith(tag.slice(0, i))) {
				pendingLen = Math.max(pendingLen, i);
			}
		}
	}
	if (!pendingLen) return [text, ""];
	return [text.slice(0, -pendingLen), text.slice(-pendingLen)];
}

export function countMarkdownTables(text: string): number {
	const re = /^\|[-: ]+\|/gm;
	let count = 0;
	while (re.exec(text)) count++;
	return count;
}

/** Split markdown without cutting tables or fenced code blocks in half. */
export function splitMarkdownBlocks(text: string, maxBlockSize: number): string[] {
	if (!text) return [""];
	if (maxBlockSize <= 0 || text.length <= maxBlockSize) return [text];

	const blocks = markdownStructureBlocks(text);
	const chunks: string[] = [];
	let current = "";
	for (const block of blocks) {
		if (block.length > maxBlockSize && isFencedCodeBlock(block)) {
			if (current) { chunks.push(current); current = ""; }
			chunks.push(...splitFencedCodeBlock(block, maxBlockSize));
			continue;
		}
		if (block.length > maxBlockSize && isTableBlock(block)) {
			if (current) { chunks.push(current); current = ""; }
			chunks.push(...splitTableBlock(block, maxBlockSize));
			continue;
		}
		if (block.length > maxBlockSize && !isStructuredMarkdownBlock(block)) {
			if (current) { chunks.push(current); current = ""; }
			chunks.push(...splitPlainBlock(block, maxBlockSize));
			continue;
		}
		if (current && current.length + block.length > maxBlockSize) {
			chunks.push(current);
			current = block;
		} else {
			current += block;
		}
	}
	if (current) chunks.push(current);
	return chunks.length ? chunks : [""];
}

function markdownStructureBlocks(text: string): string[] {
	const lines = text.split(/(?<=\n)/);
	if (!lines.length) return [text];
	const blocks: string[] = [];
	let paragraph: string[] = [];
	let i = 0;
	const flush = () => { if (paragraph.length) { blocks.push(paragraph.join("")); paragraph = []; } };
	while (i < lines.length) {
		const line = lines[i];
		if (FENCE_RE.test(line)) {
			flush();
			const code = [line];
			i++;
			while (i < lines.length) {
				code.push(lines[i]);
				if (FENCE_RE.test(lines[i])) { i++; break; }
				i++;
			}
			blocks.push(code.join(""));
			continue;
		}
		if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
			flush();
			const table = [line, lines[i + 1]];
			i += 2;
			while (i < lines.length && TABLE_ROW_RE.test(lines[i])) { table.push(lines[i]); i++; }
			blocks.push(table.join(""));
			continue;
		}
		paragraph.push(line);
		i++;
		if (line.trim() === "") flush();
	}
	flush();
	return blocks;
}

function isStructuredMarkdownBlock(block: string): boolean {
	return block.includes("```") || TABLE_SEPARATOR_RE.test(block);
}
function isFencedCodeBlock(block: string): boolean {
	const lines = block.split(/(?<=\n)/);
	return lines.length > 0 && FENCE_RE.test(lines[0]);
}
function isTableBlock(block: string): boolean {
	const lines = block.split(/(?<=\n)/);
	return lines.length >= 2 && TABLE_ROW_RE.test(lines[0]) && TABLE_SEPARATOR_RE.test(lines[1]);
}

function splitFencedCodeBlock(block: string, max: number): string[] {
	const lines = block.split(/(?<=\n)/);
	if (lines.length < 2) return splitPlainBlock(block, max);
	const opening = lines[0];
	const closing = FENCE_RE.test(lines[lines.length - 1]) ? lines[lines.length - 1] : "```\n";
	const bodyLines = closing === lines[lines.length - 1] ? lines.slice(1, -1) : lines.slice(1);
	const overhead = opening.length + closing.length;
	if (overhead >= max) return splitPlainBlock(block, max);
	const bodyLimit = max - overhead;
	const chunks: string[] = [];
	let current = "";
	for (const line of bodyLines) {
		if (current && current.length + line.length > bodyLimit) {
			chunks.push(wrapCodeChunk(opening, current, closing));
			current = "";
		}
		if (line.length > bodyLimit) {
			for (const piece of splitPlainBlock(line, bodyLimit)) chunks.push(wrapCodeChunk(opening, piece, closing));
			continue;
		}
		current += line;
	}
	if (current || !chunks.length) chunks.push(wrapCodeChunk(opening, current, closing));
	return chunks;
}

function wrapCodeChunk(opening: string, body: string, closing: string): string {
	if (body && !body.endsWith("\n")) body += "\n";
	return opening + body + closing;
}

function splitTableBlock(block: string, max: number): string[] {
	const lines = block.split(/(?<=\n)/);
	if (lines.length < 3) return splitPlainBlock(block, max);
	const header = lines.slice(0, 2).join("");
	const rows = lines.slice(2);
	if (header.length >= max) return splitPlainBlock(block, max);
	const rowLimit = max - header.length;
	const chunks: string[] = [];
	let current = "";
	for (const row of rows) {
		if (current && current.length + row.length > rowLimit) {
			chunks.push(header + current);
			current = "";
		}
		if (row.length > rowLimit) {
			if (current) { chunks.push(header + current); current = ""; }
			for (const piece of splitPlainBlock(row, rowLimit)) chunks.push(header + piece);
			continue;
		}
		current += row;
	}
	if (current || !chunks.length) chunks.push(header + current);
	return chunks;
}

function splitPlainBlock(block: string, max: number): string[] {
	const chunks: string[] = [];
	let remaining = block;
	while (remaining.length > max) {
		const at = safePlainSplitIndex(remaining, max);
		chunks.push(remaining.slice(0, at));
		remaining = remaining.slice(at);
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

function safePlainSplitIndex(text: string, max: number): number {
	const window = text.slice(0, max + 1);
	const candidates = [
		[...window.matchAll(new RegExp(LIST_BOUNDARY_RE.source, "g"))].map((m) => m.index! + 1).sort((a, b) => b - a),
		[separatorSplitIndex(window, "\n")],
		[separatorSplitIndex(window, " ")],
	];
	for (const group of candidates) {
		for (const at of group) {
			if (at <= 0) continue;
			const safe = adjustSplitForInlineCode(window, at);
			if (safe > 0) return safe;
		}
	}
	return max;
}

function separatorSplitIndex(text: string, sep: string): number {
	const idx = text.lastIndexOf(sep);
	return idx <= 0 ? 0 : idx + sep.length;
}

function adjustSplitForInlineCode(text: string, at: number): number {
	const prefix = text.slice(0, at);
	if ((prefix.split("`").length - 1) % 2 === 0) return at;
	let searchSpace = prefix;
	let before = searchSpace.lastIndexOf("`");
	while (before > 0) {
		if ((searchSpace.slice(0, before).split("`").length - 1) % 2 === 0) return before;
		searchSpace = searchSpace.slice(0, before);
		before = searchSpace.lastIndexOf("`");
	}
	return 0;
}

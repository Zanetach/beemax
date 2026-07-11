/** Render the subset of Markdown commonly emitted by agents without leaking source markers. */
export function renderTerminalMarkdown(markdown: string, ansi = process.stdout.isTTY === true): string {
	return markdown.split("\n").map((line) => renderLine(line, ansi)).join("\n");
}

function renderLine(line: string, ansi: boolean): string {
	if (/^\s*```/.test(line)) return "";
	const heading = line.match(/^(#{1,6})\s+(.+)$/);
	if (heading) return style(heading[2], "\x1b[1m", ansi);
	let result = line.replace(/^\s*>\s?/, "│ ").replace(/^\s*[-*+]\s+/, "• ");
	result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
	result = result.replace(/\*\*(.+?)\*\*/g, (_match, value) => style(value, "\x1b[1m", ansi));
	result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)/g, (_match, a, b) => style(a ?? b, "\x1b[3m", ansi));
	result = result.replace(/`([^`]+)`/g, (_match, value) => style(value, "\x1b[36m", ansi));
	result = result.replace(/~~(.+?)~~/g, "$1");
	return result;
}

function style(value: string, code: string, ansi: boolean): string { return ansi ? `${code}${value}\x1b[0m` : value; }

/** Buffers partial stream lines so Markdown delimiters are rendered only once they are complete. */
export class StreamingTerminalMarkdown {
	private pending = "";
	write(delta: string, output: (text: string) => void): void {
		this.pending += delta;
		const lines = this.pending.split("\n");
		this.pending = lines.pop() ?? "";
		for (const line of lines) output(`${renderTerminalMarkdown(line)}\n`);
	}
	finish(output: (text: string) => void): void {
		if (this.pending) output(renderTerminalMarkdown(this.pending));
		this.pending = "";
	}
}

import assert from "node:assert/strict";
import test from "node:test";
import { renderTerminalMarkdown } from "../dist/terminal-markdown.js";

test("terminal markdown removes source markers in plain fallback output", () => {
	const output = renderTerminalMarkdown("## Tools\n\n**read** — read files\n- `bash`\n[Docs](https://example.test)\n```ts\nconst x = 1\n```\n> *note*", false);
	assert.doesNotMatch(output, /\*\*/);
	assert.doesNotMatch(output, /`/);
	assert.doesNotMatch(output, /\[Docs\]\(/);
	assert.doesNotMatch(output, /```/);
	assert.match(output, /Tools/);
	assert.match(output, /read/);
});

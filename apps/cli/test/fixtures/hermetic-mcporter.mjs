#!/usr/bin/env node

const args = process.argv.slice(2);
if (args.includes("list")) {
	process.stdout.write(`${JSON.stringify({ status: "ok", tools: [{ name: "web_search_exa" }] })}\n`);
} else if (args.includes("call")) {
	process.stdout.write([
		"Title: Hermetic Provider Source",
		"URL: https://example.com/hermetic-source-42",
		"Published: 2026-07-16",
		"Highlights: HERMETIC-SOURCE-42 proves the cold Profile executed the acquired Provider.",
	].join("\n"));
} else {
	process.stderr.write("unsupported hermetic mcporter invocation\n");
	process.exitCode = 2;
}

import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserTools } from "../dist/index.js";

test("browser capability exposes read and explicitly mutating operations separately", async () => {
	const tools = createBrowserTools({
		fetchImpl: async () => new Response(JSON.stringify([{ id: "page-1", type: "page", title: "Example", url: "https://example.com", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }]), { status: 200 }),
	});
	assert.deepEqual(tools.map((tool) => tool.name), ["browser_status", "browser_open", "browser_read", "browser_click", "browser_fill", "browser_cookies"]);
	const status = await tools[0].execute("call", {}, new AbortController().signal);
	assert.match(status.content[0].text, /Example/);
});

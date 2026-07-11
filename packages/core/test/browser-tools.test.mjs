import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserTools } from "../dist/index.js";

test("browser capability exposes read and explicitly mutating operations separately", async () => {
	const tools = createBrowserTools({
		fetchImpl: async () => new Response(JSON.stringify([{ id: "page-1", type: "page", title: "Example", url: "https://example.com", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }]), { status: 200 }),
	});
	assert.deepEqual(tools.map((tool) => tool.name), ["browser_status", "browser_open", "browser_read", "browser_click", "browser_fill", "browser_cookies"]);
	assert.equal(tools.find((tool) => tool.name === "browser_read").beemaxPolicy.approval, "never");
	assert.equal(tools.find((tool) => tool.name === "browser_click").beemaxPolicy.risk, "high");
	assert.equal(tools.find((tool) => tool.name === "browser_cookies").beemaxPolicy.sideEffect, "none");
	const status = await tools[0].execute("call", {}, new AbortController().signal);
	assert.match(status.content[0].text, /Example/);
});

test("browser credential fill injects a Vault Secret without returning it to the Agent", async () => {
	const original = globalThis.WebSocket;
	let expression = "";
	class FakeWebSocket extends EventTarget {
		constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
		send(raw) {
			const request = JSON.parse(raw); expression = request.params.expression;
			queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, result: { result: { value: { ok: true } } } }) })));
		}
		close() {}
	}
	globalThis.WebSocket = FakeWebSocket;
	try {
		const accesses = [];
		const tools = createBrowserTools({
			fetchImpl: async () => new Response(JSON.stringify([{ id: "page-1", type: "page", title: "Login", url: "https://example.com/login", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }]), { status: 200 }),
			credentials: { ownerKey: "profile:personal", vault: { async withSecret(ownerKey, ref, capability, consume) { accesses.push({ ownerKey, ref, capability }); return await consume("correct-horse-battery-staple"); } } },
		});
		const tool = tools.find((candidate) => candidate.name === "browser_fill_credential");
		assert.ok(tool);
		const result = await tool.execute("call", { selector: "#password", credentialRef: "cred_11111111-1111-1111-1111-111111111111" }, new AbortController().signal);
		assert.deepEqual(accesses, [{ ownerKey: "profile:personal", ref: "cred_11111111-1111-1111-1111-111111111111", capability: "browser.fill" }]);
		assert.match(expression, /correct-horse-battery-staple/);
		assert.match(result.content[0].text, /Filled #password using Credential Ref/);
		assert.doesNotMatch(JSON.stringify(result), /correct-horse-battery-staple/);
		assert.equal(tool.beemaxPolicy.risk, "high");
	} finally { globalThis.WebSocket = original; }
});

test("browser credential generation stores and fills a high-entropy Secret while returning only its Ref", async () => {
	const original = globalThis.WebSocket;
	let expression = "";
	class FakeWebSocket extends EventTarget {
		constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
		send(raw) {
			const request = JSON.parse(raw); expression = request.params.expression;
			queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, result: { result: { value: { ok: true } } } }) })));
		}
		close() {}
	}
	globalThis.WebSocket = FakeWebSocket;
	try {
		let stored;
		const vault = {
			put(input) { stored = input; return { ...input, ref: "cred_22222222-2222-2222-2222-222222222222", createdAt: 1, updatedAt: 1, secret: undefined }; },
			remove() { throw new Error("must not roll back a successful fill"); },
			async withSecret() { throw new Error("unused"); },
		};
		const tools = createBrowserTools({
			fetchImpl: async () => new Response(JSON.stringify([{ id: "page-1", type: "page", title: "Sign up", url: "https://example.com/signup", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }]), { status: 200 }),
			credentials: { ownerKey: "profile:personal", vault },
		});
		const tool = tools.find((candidate) => candidate.name === "browser_generate_credential");
		assert.ok(tool);
		const result = await tool.execute("call", { selector: "#password", label: "Example account", purpose: "example.com login", length: 24 }, new AbortController().signal);
		assert.equal(stored.ownerKey, "profile:personal");
		assert.equal(stored.secret.length, 24);
		assert.match(stored.secret, /^[A-Za-z0-9!@#$%^&*_-]+$/);
		assert.match(expression, new RegExp(stored.secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(result.content[0].text, /cred_22222222-2222-2222-2222-222222222222/);
		assert.doesNotMatch(JSON.stringify(result), new RegExp(stored.secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	} finally { globalThis.WebSocket = original; }
});

test("browser credential generation removes the new Credential when the field cannot be filled", async () => {
	const original = globalThis.WebSocket;
	class FakeWebSocket extends EventTarget {
		constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
		send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, result: { result: { value: { ok: false, reason: "not an input" } } } }) }))); }
		close() {}
	}
	globalThis.WebSocket = FakeWebSocket;
	try {
		const removed = [];
		const vault = {
			put(input) { return { ...input, ref: "cred_33333333-3333-3333-3333-333333333333", createdAt: 1, updatedAt: 1 }; },
			remove(ownerKey, ref) { removed.push({ ownerKey, ref }); return true; },
			async withSecret() { throw new Error("unused"); },
		};
		const tool = createBrowserTools({
			fetchImpl: async () => new Response(JSON.stringify([{ id: "page-1", type: "page", title: "Sign up", url: "https://example.com/signup", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }]), { status: 200 }),
			credentials: { ownerKey: "profile:personal", vault },
		}).find((candidate) => candidate.name === "browser_generate_credential");
		const result = await tool.execute("call", { selector: "#missing", label: "Example", purpose: "login" }, new AbortController().signal);
		assert.equal(result.isError, true);
		assert.deepEqual(removed, [{ ownerKey: "profile:personal", ref: "cred_33333333-3333-3333-3333-333333333333" }]);
		assert.doesNotMatch(JSON.stringify(result), /secret/i);
	} finally { globalThis.WebSocket = original; }
});

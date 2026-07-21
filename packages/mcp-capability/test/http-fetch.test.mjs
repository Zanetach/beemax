import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createMcpHttpFetch } from "../dist/index.js";

test("MCP public HTTPS fetch pins DNS again on redirect and preserves an SDK POST safely", async () => {
	const lookups = [];
	const requests = [];
	const fetch = createMcpHttpFetch({
		mode: "public-https",
		publicHttp: {
			lookup: async (hostname) => {
				lookups.push(hostname);
				return [{ address: hostname === "first.example.test" ? "93.184.216.34" : "1.1.1.1", family: 4 }];
			},
			request: async (url, options) => {
				requests.push({
					url: url.toString(),
					address: options.destination.address,
					method: options.method,
					authorization: options.headers?.authorization,
					xApiKey: options.headers?.["x-api-key"],
					body: options.body ? new TextDecoder().decode(options.body) : "",
				});
				return requests.length === 1
					? new Response(null, { status: 307, headers: { location: "https://second.example.test/mcp" } })
					: new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
			},
		},
	});

	const response = await fetch("https://first.example.test/mcp", {
		method: "POST",
		headers: { authorization: "Bearer profile-secret", "content-type": "application/json", "x-api-key": "profile-api-secret", "x-profile": "alpha" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(lookups, ["first.example.test", "second.example.test"]);
	assert.deepEqual(requests.map(({ url, address, method, authorization, xApiKey }) => ({ url, address, method, authorization, xApiKey })), [
		{ url: "https://first.example.test/mcp", address: "93.184.216.34", method: "POST", authorization: "Bearer profile-secret", xApiKey: "profile-api-secret" },
		{ url: "https://second.example.test/mcp", address: "1.1.1.1", method: "POST", authorization: undefined, xApiKey: undefined },
	]);
	assert.equal(requests[0].body, requests[1].body);
});

test("MCP public HTTPS fetch blocks same-host DNS rebinding between redirect hops", async () => {
	const lookups = [];
	let requestCount = 0;
	const fetch = createMcpHttpFetch({
		mode: "public-https",
		publicHttp: {
			lookup: async (hostname) => {
				lookups.push(hostname);
				return [{ address: lookups.length === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
			},
			request: async () => {
				requestCount += 1;
				return new Response(null, { status: 302, headers: { location: "/next" } });
			},
		},
	});
	await assert.rejects(fetch("https://rebind.example.test/mcp"), /destination validation or request failed/u);
	assert.deepEqual(lookups, ["rebind.example.test", "rebind.example.test"]);
	assert.equal(requestCount, 1);
});

test("MCP loopback HTTP fetch pins an explicitly local destination and cannot redirect out", async () => {
	const lookups = [];
	const requests = [];
	const fetch = createMcpHttpFetch({
		mode: "loopback-http",
		publicHttp: {
			lookup: async (hostname) => {
				lookups.push(hostname);
				return [{ address: "127.0.0.1", family: 4 }];
			},
			request: async (url, options) => {
				requests.push({ url: url.toString(), address: options.destination.address });
				return requests.length === 1
					? new Response(null, { status: 302, headers: { location: "https://public.example.test/mcp" } })
					: new Response("unreachable");
			},
		},
	});

	await assert.rejects(fetch("http://localhost:8123/mcp"), /loopback HTTP on every hop/u);
	assert.deepEqual(lookups, ["localhost"]);
	assert.deepEqual(requests, [{ url: "http://localhost:8123/mcp", address: "127.0.0.1" }]);

	await assert.rejects(fetch("http://service.example.test/mcp"), /explicit loopback/u);
});

test("MCP loopback fetch sends SDK POST headers and body through the pinned Node transport", async () => {
	let resolveRequest;
	const capturedRequest = new Promise((resolve) => { resolveRequest = resolve; });
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			resolveRequest({ method: request.method, profile: request.headers["x-profile"], body: Buffer.concat(chunks).toString("utf8") });
			response.writeHead(200, { "content-type": "application/json" });
			response.end('{"ok":true}');
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const fetch = createMcpHttpFetch({ mode: "loopback-http" });
		const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-profile": "alpha" },
			body: '{"jsonrpc":"2.0"}',
		});
		assert.deepEqual(await capturedRequest, { method: "POST", profile: "alpha", body: '{"jsonrpc":"2.0"}' });
		assert.deepEqual(await response.json(), { ok: true });
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("MCP HTTP fetch rejects an oversized Content-Length before reading the body", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		pull(controller) { controller.enqueue(new Uint8Array([1])); },
		cancel() { cancelled = true; },
	});
	const fetch = createMcpHttpFetch({
		mode: "public-https",
		maxResponseBytes: 8,
		publicHttp: {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			request: async () => new Response(body, { status: 200, headers: { "content-length": "9", "content-type": "application/json" } }),
		},
	});
	await assert.rejects(fetch("https://mcp.example.test/service"), /exceeds 8 bytes/u);
	assert.equal(cancelled, true);
});

for (const contentType of ["application/json", "text/event-stream"]) {
	test(`MCP HTTP fetch caps cumulative ${contentType} stream bytes`, async () => {
		let cancelled = false;
		let emitted = 0;
		const body = new ReadableStream({
			pull(controller) {
				emitted += 1;
				if (emitted <= 2) controller.enqueue(new Uint8Array(emitted === 1 ? 5 : 4));
			},
			cancel() { cancelled = true; },
		}, { highWaterMark: 0 });
		const fetch = createMcpHttpFetch({
			mode: "public-https",
			maxResponseBytes: 8,
			publicHttp: {
				lookup: async () => [{ address: "93.184.216.34", family: 4 }],
				request: async () => new Response(body, { status: 200, headers: { "content-type": contentType } }),
			},
		});
		const response = await fetch("https://mcp.example.test/service");
		await assert.rejects(response.arrayBuffer(), /exceeds 8 bytes/u);
		assert.equal(cancelled, true);
	});
}

test("MCP HTTP fetch never reflects request credentials or hostile error bodies in errors", async () => {
	const secret = "profile-secret-must-not-leak";
	const failingFetch = createMcpHttpFetch({
		mode: "public-https",
		publicHttp: {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			request: async () => { throw new Error(`connect failed for https://mcp.example.test/?token=${secret}`); },
		},
	});
	await assert.rejects(failingFetch(`https://mcp.example.test/?token=${secret}`, {
		headers: { authorization: `Bearer ${secret}` },
	}), (error) => {
		assert.doesNotMatch(error.message, new RegExp(secret, "u"));
		assert.equal(error.message, "MCP HTTP destination validation or request failed");
		return true;
	});

	let cancelled = false;
	const hostileBody = new ReadableStream({
		start(controller) { controller.enqueue(new TextEncoder().encode(`Bearer ${secret}`)); },
		cancel() { cancelled = true; },
	});
	const responseFetch = createMcpHttpFetch({
		mode: "public-https",
		publicHttp: {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			request: async () => new Response(hostileBody, { status: 500, statusText: secret }),
		},
	});
	const response = await responseFetch("https://mcp.example.test/service", {
		headers: { authorization: `Bearer ${secret}` },
	});
	assert.equal(response.status, 500);
	assert.equal(response.statusText, "");
	assert.equal(await response.text(), "");
	assert.equal(cancelled, true);
});

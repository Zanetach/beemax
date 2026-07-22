import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { profileBrowserProxyArguments, startProfileBrowserEgressProxy } from "../dist/profile-browser-egress.js";

test("Profile browser egress blocks hostnames resolving to private or mixed addresses", async () => {
	const lookups = [];
	const proxy = await startProfileBrowserEgressProxy({
		lookup: async (hostname) => {
			lookups.push(hostname);
			return [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }];
		},
	});
	try {
		const response = await proxyRequest(proxy.url, "http://rebind.example.test/latest/meta-data");
		assert.equal(response.statusCode, 403);
		assert.match(response.body, /Blocked by Thruvera/u);
		assert.deepEqual(lookups, ["rebind.example.test"]);
	} finally { await proxy.close(); }
});

test("Profile browser egress rejects private CONNECT tunnels before opening an upstream socket", async () => {
	const proxy = await startProfileBrowserEgressProxy({
		lookup: async () => [{ address: "10.0.0.8", family: 4 }],
	});
	try {
		const response = await proxyConnect(proxy.url, "metadata.internal:443");
		assert.match(response, /^HTTP\/1\.1 403 Forbidden/u);
	} finally { await proxy.close(); }
});

test("Profile browser egress rejects local-use IPv6 translation addresses over HTTP", async () => {
	const proxy = await startProfileBrowserEgressProxy({
		lookup: async () => [{ address: "64:ff9b:1::a00:1", family: 6 }],
	});
	try {
		const response = await proxyRequest(proxy.url, "http://local-nat64.example.test/latest/meta-data");
		assert.equal(response.statusCode, 403);
		assert.match(response.body, /Blocked by Thruvera/u);
	} finally { await proxy.close(); }
});

test("Profile browser egress rejects non-global IPv6 documentation addresses over HTTP", async () => {
	const proxy = await startProfileBrowserEgressProxy({
		lookup: async () => [{ address: "3fff::1", family: 6 }],
	});
	try {
		const response = await proxyRequest(proxy.url, "http://documentation.example.test/");
		assert.equal(response.statusCode, 403);
	} finally { await proxy.close(); }
});

test("Profile browser egress rejects deprecated site-local IPv6 CONNECT tunnels", async () => {
	const proxy = await startProfileBrowserEgressProxy({
		lookup: async () => [{ address: "fec0::1", family: 6 }],
	});
	try {
		const response = await proxyConnect(proxy.url, "site-local.example.test:443");
		assert.match(response, /^HTTP\/1\.1 403 Forbidden/u);
	} finally { await proxy.close(); }
});

test("Profile Chrome arguments force redirects, JavaScript requests, WebSockets and loopback names through the guarded proxy", () => {
	const args = profileBrowserProxyArguments("http://127.0.0.1:43123", "/profile/browser-data");
	assert.ok(args.includes("--proxy-server=http://127.0.0.1:43123"));
	assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
	assert.ok(args.includes("--disable-quic"));
	assert.ok(args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
	assert.ok(args.includes("--remote-debugging-port=0"));
});

function proxyRequest(proxyUrl, target) {
	const proxy = new URL(proxyUrl);
	return new Promise((resolve, reject) => {
		const pending = request({ host: proxy.hostname, port: proxy.port, method: "GET", path: target, headers: { host: new URL(target).host } }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.once("end", () => resolve({ statusCode: response.statusCode, body }));
		});
		pending.once("error", reject);
		pending.end();
	});
}

function proxyConnect(proxyUrl, target) {
	const endpoint = new URL(proxyUrl);
	return new Promise((resolve, reject) => {
		const socket = connect(Number(endpoint.port), endpoint.hostname);
		let text = "";
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
		socket.on("data", (chunk) => { text += chunk; });
		socket.once("end", () => resolve(text));
		socket.once("error", reject);
	});
}

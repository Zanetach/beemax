import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { isGloballyReachableIp } from "@beemax/core";

export interface ProfileBrowserEgressProxy {
	url: string;
	close(): Promise<void>;
}

export interface ProfileBrowserEgressOptions {
	lookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
}

/** Start a loopback forward proxy that pins every browser connection to a DNS result already proven public. */
export async function startProfileBrowserEgressProxy(options: ProfileBrowserEgressOptions = {}): Promise<ProfileBrowserEgressProxy> {
	const resolve = options.lookup ?? (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
	const server = createServer((request, response) => { void proxyHttpRequest(request, response, resolve); });
	server.on("connect", (request, socket, head) => { void proxyConnect(request, socket, head, resolve); });
	await listen(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Profile browser egress proxy did not publish a loopback port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
	};
}

/** Chrome flags that force HTTP(S), redirects, JS fetches and WebSockets through the guarded proxy. */
export function profileBrowserProxyArguments(proxyUrl: string, dataDir: string): string[] {
	const proxy = new URL(proxyUrl);
	if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" || !proxy.port) throw new Error("Profile browser proxy must be an assigned loopback HTTP endpoint");
	return [
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=0",
		`--user-data-dir=${dataDir}`,
		`--proxy-server=${proxy.origin}`,
		"--proxy-bypass-list=<-loopback>",
		"--disable-quic",
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		"--no-first-run",
		"--no-default-browser-check",
	];
}

async function proxyHttpRequest(incoming: IncomingMessage, response: ServerResponse, resolve: NonNullable<ProfileBrowserEgressOptions["lookup"]>): Promise<void> {
	try {
		const target = new URL(incoming.url ?? "");
		if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("unsupported proxy protocol");
		if (target.username || target.password) throw new Error("credentialed proxy targets are blocked");
		const destination = await resolvePublicDestination(target.hostname, resolve);
		const headers: Record<string, string | string[] | undefined> = { ...incoming.headers, host: target.host };
		delete headers["proxy-authorization"];
		delete headers["proxy-connection"];
		const request = (target.protocol === "https:" ? httpsRequest : httpRequest)({
			protocol: target.protocol,
			host: destination.address,
			family: destination.family,
			port: target.port || (target.protocol === "https:" ? 443 : 80),
			method: incoming.method,
			path: `${target.pathname}${target.search}`,
			headers,
			...(target.protocol === "https:" ? { servername: target.hostname } : {}),
		}, (upstream) => {
			response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, upstream.headers);
			upstream.pipe(response);
		});
		request.setTimeout(30_000, () => request.destroy(new Error("browser egress request timed out")));
		request.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
		incoming.on("aborted", () => request.destroy());
		incoming.pipe(request);
	} catch {
		response.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
		response.end("Blocked by BeeMax Profile browser egress policy.\n");
	}
}

async function proxyConnect(incoming: IncomingMessage, client: Duplex, head: Buffer, resolve: NonNullable<ProfileBrowserEgressOptions["lookup"]>): Promise<void> {
	try {
		const authority = new URL(`http://${incoming.url ?? ""}`);
		const port = Number(authority.port || 443);
		if (!authority.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CONNECT authority");
		const destination = await resolvePublicDestination(authority.hostname, resolve);
		const upstream = netConnect({ host: destination.address, family: destination.family, port });
		upstream.setTimeout(30_000, () => upstream.destroy(new Error("browser egress CONNECT timed out")));
		upstream.once("connect", () => {
			client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: BeeMax\r\n\r\n");
			if (head.length) upstream.write(head);
			client.pipe(upstream);
			upstream.pipe(client);
		});
		upstream.once("error", () => client.destroy());
		client.once("error", () => upstream.destroy());
	} catch {
		client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
	}
}

async function resolvePublicDestination(hostname: string, resolve: NonNullable<ProfileBrowserEgressOptions["lookup"]>): Promise<{ address: string; family: 4 | 6 }> {
	const literalFamily = isIP(hostname);
	const results = literalFamily ? [{ address: hostname, family: literalFamily }] : await resolve(hostname);
	if (!results.length) throw new Error("browser target did not resolve");
	const normalized = results.map(({ address, family }) => ({ address, family: family === 6 ? 6 as const : 4 as const }));
	if (normalized.some(({ address }) => !isGloballyReachableIp(address))) throw new Error("browser target resolves to a non-public address");
	return normalized[0]!;
}

function listen(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
	});
}

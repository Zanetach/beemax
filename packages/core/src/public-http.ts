import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isGloballyReachableIp, isLoopbackIp } from "./public-network.ts";

export interface PublicHttpDestination {
	address: string;
	family: 4 | 6;
}

export interface PinnedPublicHttpRequestOptions {
	destination: PublicHttpDestination;
	hostHeader: string;
	servername?: string;
	method?: string;
	headers?: Readonly<Record<string, string>>;
	body?: Uint8Array;
	signal?: AbortSignal;
}

export type PublicAddressLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;
export type PinnedPublicHttpRequest = (url: URL, options: PinnedPublicHttpRequestOptions) => Promise<Response>;

export interface PublicHttpDependencies {
	lookup?: PublicAddressLookup;
	request?: PinnedPublicHttpRequest;
}

export interface PublicHttpRequestOptions {
	method?: string;
	headers?: Readonly<Record<string, string>>;
	body?: Uint8Array;
	signal?: AbortSignal;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Resolve, validate, then connect to exactly one validated public address. */
export async function requestValidatedPublicUrl(
	url: URL,
	options: PublicHttpRequestOptions = {},
	dependencies: PublicHttpDependencies = {},
): Promise<Response> {
	const hostname = validatedHostname(url);
	const lookup = dependencies.lookup ?? (async (host) => dnsLookup(host, { all: true, verbatim: true }));
	const destination = await resolvePublicDestination(hostname, lookup);
	return (dependencies.request ?? requestPinnedPublicUrl)(url, {
		...options,
		destination,
		hostHeader: url.host,
		...(isIP(hostname) ? {} : { servername: hostname }),
	});
}

/** Resolve an explicitly local hostname and pin the connection to a loopback address. */
export async function requestValidatedLoopbackUrl(
	url: URL,
	options: PublicHttpRequestOptions = {},
	dependencies: PublicHttpDependencies = {},
): Promise<Response> {
	const hostname = validatedLoopbackHostname(url);
	const lookup = dependencies.lookup ?? (async (host) => dnsLookup(host, { all: true, verbatim: true }));
	const destination = await resolveLoopbackDestination(hostname, lookup);
	return (dependencies.request ?? requestPinnedPublicUrl)(url, {
		...options,
		destination,
		hostHeader: url.host,
	});
}

/** Follow redirects manually so every hop receives a fresh validation and a newly pinned connection. */
export async function requestValidatedPublicUrlFollowingRedirects(
	initialUrl: URL,
	options: PublicHttpRequestOptions = {},
	dependencies: PublicHttpDependencies = {},
	maxRedirects = 5,
): Promise<{ response: Response; finalUrl: URL }> {
	let url = new URL(initialUrl);
	for (let redirect = 0; redirect <= maxRedirects; redirect++) {
		const response = await requestValidatedPublicUrl(url, options, dependencies);
		if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: url };
		const location = response.headers.get("location");
		await response.body?.cancel().catch(() => undefined);
		if (!location) throw new Error(`Redirect ${response.status} missing Location header`);
		if (redirect === maxRedirects) throw new Error(`Too many redirects (>${maxRedirects})`);
		url = new URL(location, url);
	}
	throw new Error(`Too many redirects (>${maxRedirects})`);
}

function validatedHostname(url: URL): string {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http:// and https:// URLs are allowed");
	if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal") {
		throw new Error("Local or metadata host is not allowed");
	}
	return hostname;
}

function validatedLoopbackHostname(url: URL): string {
	if (url.protocol !== "http:") throw new Error("Loopback MCP transport only allows http:// URLs");
	if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (isLoopbackIp(hostname) || hostname === "localhost" || hostname.endsWith(".localhost")) return hostname;
	throw new Error("Loopback transport requires an explicit localhost or loopback IP hostname");
}

async function resolvePublicDestination(hostname: string, lookup: PublicAddressLookup): Promise<PublicHttpDestination> {
	const literalFamily = isIP(hostname);
	const answers = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname);
	if (!answers.length) throw new Error("Hostname did not resolve");
	const destinations = answers.map(({ address }) => {
		const family = isIP(address);
		if (family !== 4 && family !== 6) throw new Error(`DNS returned an invalid address: ${address}`);
		return { address, family } as PublicHttpDestination;
	});
	if (destinations.some(({ address }) => !isGloballyReachableIp(address))) throw new Error("Hostname resolves to a non-public address");
	return destinations[0]!;
}

async function resolveLoopbackDestination(hostname: string, lookup: PublicAddressLookup): Promise<PublicHttpDestination> {
	const literalFamily = isIP(hostname);
	const answers = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname);
	if (!answers.length) throw new Error("Loopback hostname did not resolve");
	const destinations = answers.map(({ address }) => {
		const family = isIP(address);
		if (family !== 4 && family !== 6) throw new Error("DNS returned an invalid loopback address");
		return { address, family } as PublicHttpDestination;
	});
	if (destinations.some(({ address }) => !isLoopbackIp(address))) throw new Error("Loopback hostname resolved outside loopback address space");
	return destinations[0]!;
}

function requestPinnedPublicUrl(url: URL, options: PinnedPublicHttpRequestOptions): Promise<Response> {
	return new Promise((resolve, reject) => {
		const headers = new Headers(options.headers);
		headers.set("host", options.hostHeader);
		const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
		const request = transport({
			protocol: url.protocol,
			host: options.destination.address,
			family: options.destination.family,
			port: url.port || (url.protocol === "https:" ? 443 : 80),
			method: options.method ?? "GET",
			path: `${url.pathname}${url.search}`,
			headers: Object.fromEntries(headers.entries()),
			signal: options.signal,
			...(url.protocol === "https:" && options.servername ? { servername: options.servername } : {}),
		}, (upstream) => {
			try {
				const responseHeaders = new Headers();
				for (const [name, value] of Object.entries(upstream.headers)) {
					if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
					else if (value !== undefined) responseHeaders.set(name, value);
				}
				const status = upstream.statusCode ?? 502;
				const hasBody = options.method !== "HEAD" && status !== 204 && status !== 205 && status !== 304;
				if (!hasBody) upstream.resume();
				resolve(new Response(hasBody ? Readable.toWeb(upstream) as ReadableStream<Uint8Array> : null, {
					status,
					statusText: upstream.statusMessage,
					headers: responseHeaders,
				}));
			} catch (error) {
				upstream.destroy();
				reject(error);
			}
		});
		request.once("error", reject);
		if (options.body?.byteLength) request.write(options.body);
		request.end();
	});
}

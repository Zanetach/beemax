import {
	isLoopbackIp,
	requestValidatedLoopbackUrl,
	requestValidatedPublicUrl,
	type PublicHttpDependencies,
	type PublicHttpRequestOptions,
} from "@beemax/core";

export const DEFAULT_MCP_HTTP_MAX_RESPONSE_BYTES = 16 * 1_024 * 1_024;

export interface McpHttpFetchOptions {
	mode: "public-https" | "loopback-http";
	publicHttp?: PublicHttpDependencies;
	maxRedirects?: number;
	maxResponseBytes?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Fetch implementation for the MCP SDK with manual, pinned redirect handling. */
export function createMcpHttpFetch(options: McpHttpFetchOptions): (url: string | URL, init?: RequestInit) => Promise<Response> {
	const maxRedirects = boundedInteger(options.maxRedirects ?? 5, 0, 10, "maxRedirects");
	const maxResponseBytes = boundedInteger(options.maxResponseBytes ?? DEFAULT_MCP_HTTP_MAX_RESPONSE_BYTES, 1, DEFAULT_MCP_HTTP_MAX_RESPONSE_BYTES, "maxResponseBytes");
	return async (input, init = {}) => {
		try {
			const initial = new Request(input, init);
			let url = new URL(initial.url);
			let method = initial.method;
			let headers = new Headers(initial.headers);
			let body = initial.body ? new Uint8Array(await initial.arrayBuffer()) : undefined;
			if (body && body.byteLength > DEFAULT_MCP_HTTP_MAX_RESPONSE_BYTES) throw new Error("MCP HTTP request body exceeds the safety limit");
			for (let redirect = 0; redirect <= maxRedirects; redirect++) {
				validateHopMode(url, options.mode);
				const requestOptions: PublicHttpRequestOptions = {
					method,
					headers: Object.fromEntries(headers.entries()),
					...(body ? { body } : {}),
					signal: initial.signal,
				};
				const response = options.mode === "public-https"
					? await requestValidatedPublicUrl(url, requestOptions, options.publicHttp)
					: await requestValidatedLoopbackUrl(url, requestOptions, options.publicHttp);
				if (!REDIRECT_STATUSES.has(response.status)) return await boundMcpResponse(response, maxResponseBytes);
				const location = response.headers.get("location");
				await response.body?.cancel().catch(() => undefined);
				if (!location) throw new Error("MCP HTTP redirect is missing a Location header");
				if (redirect === maxRedirects) throw new Error("MCP HTTP redirect limit exceeded");
				let target: URL;
				try { target = new URL(location, url); }
				catch { throw new Error("MCP HTTP redirect Location is invalid"); }
				validateHopMode(target, options.mode);
				if (target.origin !== url.origin) stripCrossOriginCredentials(headers);
				if (redirectChangesToGet(response.status, method)) {
					method = "GET";
					body = undefined;
					headers.delete("content-length");
					headers.delete("content-type");
				}
				url = target;
			}
			throw new Error("MCP HTTP redirect limit exceeded");
		} catch (error) {
			if (isSafeMcpHttpError(error)) throw error;
			throw new Error("MCP HTTP destination validation or request failed");
		}
	};
}

function validateHopMode(url: URL, mode: McpHttpFetchOptions["mode"]): void {
	if (url.username || url.password) throw new Error("MCP HTTP URLs must not embed credentials");
	if (mode === "public-https") {
		if (url.protocol !== "https:") throw new Error("MCP HTTP public transport requires HTTPS on every hop");
		return;
	}
	if (url.protocol !== "http:") throw new Error("MCP HTTP loopback transport requires loopback HTTP on every hop");
	const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
	if (!isLoopbackIp(hostname) && hostname !== "localhost" && !hostname.endsWith(".localhost")) {
		throw new Error("MCP HTTP loopback transport requires an explicit loopback host");
	}
}

function redirectChangesToGet(status: number, method: string): boolean {
	return status === 303 && method !== "HEAD" || (status === 301 || status === 302) && method === "POST";
}

function stripCrossOriginCredentials(headers: Headers): void {
	for (const name of [...headers.keys()]) {
		const normalized = name.toLowerCase().replace(/_/gu, "-");
		if (/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|mcp-session-id|last-event-id)$/u.test(normalized)
			|| /(?:^|-)(?:token|secret|password|passcode|credential|private-key)(?:$|-)/u.test(normalized)) headers.delete(name);
	}
}

async function boundMcpResponse(response: Response, maxBytes: number): Promise<Response> {
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		return new Response(null, { status: response.status, statusText: "", headers: response.headers });
	}
	const declared = response.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (!Number.isSafeInteger(length) || length < 0) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error("MCP HTTP response has an invalid Content-Length");
		}
		if (length > maxBytes) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`MCP HTTP response exceeds ${maxBytes} bytes`);
		}
	}
	if (!response.body) return response;
	return new Response(boundedResponseBody(response.body, maxBytes), {
		status: response.status,
		statusText: "",
		headers: response.headers,
	});
}

function boundedResponseBody(source: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let received = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const chunk = await reader.read();
				if (chunk.done) {
					controller.close();
					return;
				}
				received += chunk.value.byteLength;
				if (received > maxBytes) {
					await reader.cancel().catch(() => undefined);
					controller.error(new Error(`MCP HTTP response exceeds ${maxBytes} bytes`));
					return;
				}
				controller.enqueue(chunk.value);
			} catch (error) {
				controller.error(isSafeMcpHttpError(error) ? error : new Error("MCP HTTP response stream failed"));
			}
		},
		async cancel() { await reader.cancel().catch(() => undefined); },
	});
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`MCP HTTP ${name} must be an integer from ${min} to ${max}`);
	return value;
}

function isSafeMcpHttpError(error: unknown): error is Error {
	return error instanceof Error && /^MCP HTTP /u.test(error.message);
}

/**
 * Network research tools for Pi AgentSession.
 *
 * web_search provider priority:
 *   1. TAVILY_API_KEY
 *   2. BRAVE_SEARCH_API_KEY
 *   3. SEARXNG_URL
 *
 * web_extract fetches public HTTP(S) pages directly, validates every redirect,
 * blocks private/link-local/metadata addresses, caps response bytes, and turns
 * HTML into compact readable text.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { READ_ONLY_TOOL_POLICY, withToolPolicy } from "./tool-runtime.ts";

const SEARCH_TIMEOUT_MS = 15_000;
const EXTRACT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "BeeMax-Agent/0.1 (+https://pi.dev)";
const execFileAsync = promisify(execFile);

export interface WebToolsOptions {
	env?: NodeJS.ProcessEnv;
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	score?: number;
}

export function createWebTools(options: WebToolsOptions = {}): ToolDefinition[] {
	const env = options.env ?? process.env;

	const webSearch = Object.assign(defineTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the public web for current information. Returns ranked titles, URLs, and snippets. Use web_extract on relevant results for full page content.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			maxResults: Type.Optional(
				Type.Integer({ description: "Maximum number of results (1-10)", minimum: 1, maximum: 10 }),
			),
		}),
		execute: async (_toolCallId, params, signal) => {
			const query = params.query.trim();
			if (!query) return textResult("Search query cannot be empty", { provider: "none", resultCount: 0 }, true);
			const maxResults = clamp(params.maxResults ?? 5, 1, 10);
			try {
				const requestSignal = signal ?? new AbortController().signal;
				const { provider, results } = await searchWeb(query, maxResults, env, requestSignal);
				if (!results.length) return textResult(`No web results found for: ${query}`, { provider, resultCount: 0 });
				return textResult(formatSearchResults(query, provider, results), {
					provider,
					resultCount: results.length,
					results,
				});
			} catch (error) {
				return textResult(`Web search failed: ${errorMessage(error)}`, { provider: "unknown", resultCount: 0 }, true);
			}
		},
	}), {
		aliases: ["联网搜索", "网络搜索", "公开信息检索"],
		triggers: ["web_search", "搜索公开网页", "检索公开信息"],
		priority: 20,
		providers: [
			configuredWebProvider("tavily", "TAVILY_API_KEY", Boolean(env.TAVILY_API_KEY?.trim()), "Configure the Tavily API credential reference for this Profile."),
			configuredWebProvider("brave", "BRAVE_SEARCH_API_KEY", Boolean(env.BRAVE_SEARCH_API_KEY?.trim()), "Configure the Brave Search API credential reference for this Profile."),
			configuredWebProvider("searxng", "SEARXNG_URL", Boolean(env.SEARXNG_URL?.trim()), "Configure the public SearXNG endpoint URL for this Profile."),
		],
	});

	const webExtract = Object.assign(defineTool({
		name: "web_extract",
		label: "Web Extract",
		description:
			"Fetch a public HTTP(S) URL and extract readable page text. Use after web_search when snippets are insufficient. Private network addresses are blocked.",
		parameters: Type.Object({
			url: Type.String({ description: "Public HTTP(S) URL to fetch" }),
			maxChars: Type.Optional(
				Type.Integer({ description: "Maximum extracted characters (1000-30000)", minimum: 1000, maximum: 30000 }),
			),
		}),
		execute: async (_toolCallId, params, signal) => {
			const maxChars = clamp(params.maxChars ?? 12_000, 1_000, 30_000);
			try {
				const requestSignal = signal ?? new AbortController().signal;
				const page = await extractPublicUrl(params.url, maxChars, requestSignal);
				const body = [
					`# ${page.title || page.finalUrl}`,
					`Source: ${page.finalUrl}`,
					`Content-Type: ${page.contentType}`,
					"",
					page.text,
					page.truncated ? "\n[Content truncated]" : "",
				].join("\n");
				return textResult(body, page);
			} catch (error) {
				return textResult(`Web extraction failed: ${errorMessage(error)}`, { url: params.url }, true);
			}
		},
	}), {
		aliases: ["读取网页", "提取网页", "网页正文"],
		triggers: ["web_extract", "读取网页内容", "提取网页内容"],
		priority: 30,
	});
	const agentReachSearch = Object.assign(defineTool({
		name: "agent_reach_search",
		label: "Agent Reach Search",
		description: "Search the live web through Agent-Reach's configured Exa channel. Use for semantic/current web research; falls back with a clear setup message when Agent-Reach is unavailable.",
		parameters: Type.Object({ query: Type.String({ description: "Semantic web search query" }), maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
		execute: async (_id, params, signal) => {
			const query = params.query.trim();
			if (!query) return textResult("Search query cannot be empty", { provider: "agent-reach" }, true);
			try {
				const output = await agentReachSearchText(query, clamp(params.maxResults ?? 5, 1, 10), env, signal);
				return textResult(output, { provider: "agent-reach-exa" });
			} catch (error) {
				return textResult(`Agent-Reach search unavailable: ${errorMessage(error)}. Run 'agent-reach doctor' and configure the Exa channel.`, { provider: "agent-reach-exa" }, true);
			}
		},
	}), {
		aliases: ["Agent-Reach", "联网检索", "网络检索", "实时网络搜索"],
		triggers: ["agent-reach", "可验证的公开趋势", "真实可溯源来源", "检索公开趋势", "live web research"],
		priority: 10,
	});

	const publicResearchPolicy = {
		...READ_ONLY_TOOL_POLICY,
		impact: "Reads public web data without changing local or external state",
	};
	return [webSearch, agentReachSearch, webExtract].map((tool) => withToolPolicy(tool, publicResearchPolicy));
}

function configuredWebProvider(id: string, key: string, configured: boolean, instructions: string) {
	return Object.freeze({
		id,
		kind: "tool" as const,
		capabilities: Object.freeze(["web_search"]),
		installed: true,
		configuration: Object.freeze({ required: Object.freeze([key]), instructions }),
		health: async () => configured
			? { status: "ready" as const, evidenceRef: `configuration:${id}` }
			: { status: "configuration_required" as const, reason: `${key} is not configured`, missingConfiguration: Object.freeze([key]) },
	});
}

async function agentReachSearchText(query: string, maxResults: number, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
	const binary = env.BEEMAX_AGENT_REACH_MCPORTER?.trim() || join(homedir(), ".agent-reach", "mcporter", "node_modules", ".bin", "mcporter");
	const config = env.BEEMAX_AGENT_REACH_CONFIG?.trim() || join(homedir(), ".agent-reach", "mcporter.json");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		const { stdout } = await execFileAsync(binary, ["--config", config, "call", "exa.web_search_exa", `query=${query}`, `numResults=${maxResults}`], { signal: signal ?? controller.signal, timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_RESPONSE_BYTES });
		return stdout.trim() || "No Agent-Reach results found.";
	} finally { clearTimeout(timeout); }
}

async function searchWeb(
	query: string,
	maxResults: number,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal,
): Promise<{ provider: string; results: SearchResult[] }> {
	if (env.TAVILY_API_KEY?.trim()) {
		return { provider: "tavily", results: await searchTavily(query, maxResults, env.TAVILY_API_KEY.trim(), signal) };
	}
	if (env.BRAVE_SEARCH_API_KEY?.trim()) {
		return { provider: "brave", results: await searchBrave(query, maxResults, env.BRAVE_SEARCH_API_KEY.trim(), signal) };
	}
	if (env.SEARXNG_URL?.trim()) {
		return { provider: "searxng", results: await searchSearxng(query, maxResults, env.SEARXNG_URL.trim(), signal) };
	}
	throw new Error(
		"No search provider configured. Set TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, or SEARXNG_URL.",
	);
}

async function searchTavily(query: string, maxResults: number, apiKey: string, signal: AbortSignal): Promise<SearchResult[]> {
	const response = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": USER_AGENT },
		body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: maxResults, include_answer: false }),
		signal: combinedSignal(signal, SEARCH_TIMEOUT_MS),
	});
	await requireOk(response, "Tavily");
	const payload = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string; score?: number }> };
	return (payload.results ?? []).slice(0, maxResults).map((item) => ({
		title: item.title?.trim() || item.url || "Untitled",
		url: item.url ?? "",
		snippet: item.content?.trim() ?? "",
		score: item.score,
	})).filter((item) => item.url);
}

async function searchBrave(query: string, maxResults: number, apiKey: string, signal: AbortSignal): Promise<SearchResult[]> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(maxResults));
	url.searchParams.set("safesearch", "moderate");
	const response = await fetch(url, {
		headers: { accept: "application/json", "x-subscription-token": apiKey, "user-agent": USER_AGENT },
		signal: combinedSignal(signal, SEARCH_TIMEOUT_MS),
	});
	await requireOk(response, "Brave Search");
	const payload = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
	return (payload.web?.results ?? []).slice(0, maxResults).map((item) => ({
		title: stripHtml(item.title ?? item.url ?? "Untitled"),
		url: item.url ?? "",
		snippet: stripHtml(item.description ?? ""),
	})).filter((item) => item.url);
}

async function searchSearxng(query: string, maxResults: number, baseUrl: string, signal: AbortSignal): Promise<SearchResult[]> {
	const url = new URL("search", ensureTrailingSlash(baseUrl));
	await validatePublicUrl(url);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("categories", "general");
	const response = await fetch(url, {
		headers: { accept: "application/json", "user-agent": USER_AGENT },
		signal: combinedSignal(signal, SEARCH_TIMEOUT_MS),
	});
	await requireOk(response, "SearXNG");
	const payload = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string; score?: number }> };
	return (payload.results ?? []).slice(0, maxResults).map((item) => ({
		title: stripHtml(item.title ?? item.url ?? "Untitled"),
		url: item.url ?? "",
		snippet: stripHtml(item.content ?? ""),
		score: item.score,
	})).filter((item) => item.url);
}

async function extractPublicUrl(input: string, maxChars: number, signal: AbortSignal): Promise<{
	url: string;
	finalUrl: string;
	title: string;
	contentType: string;
	text: string;
	truncated: boolean;
}> {
	let url = new URL(input);
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
		await validatePublicUrl(url);
		const response = await fetch(url, {
			headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1", "user-agent": USER_AGENT },
			redirect: "manual",
			signal: combinedSignal(signal, EXTRACT_TIMEOUT_MS),
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error(`Redirect ${response.status} missing Location header`);
			url = new URL(location, url);
			continue;
		}
		await requireOk(response, "URL fetch");
		const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0].trim();
		if (!isTextContentType(contentType)) throw new Error(`Unsupported content type: ${contentType}`);
		const raw = await readLimitedBody(response, MAX_RESPONSE_BYTES);
		const title = contentType === "text/html" ? extractTitle(raw) : "";
		const extracted = contentType === "text/html" ? htmlToText(raw) : raw.trim();
		const truncated = extracted.length > maxChars;
		return { url: input, finalUrl: url.toString(), title, contentType, text: extracted.slice(0, maxChars), truncated };
	}
	throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

async function validatePublicUrl(url: URL): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http:// and https:// URLs are allowed");
	if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
		throw new Error("Local or metadata host is not allowed");
	}
	const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
	if (!addresses.length) throw new Error("Hostname did not resolve");
	for (const item of addresses) {
		if (isPrivateAddress(item.address)) throw new Error(`Private or reserved address is not allowed: ${item.address}`);
	}
}

function isPrivateAddress(address: string): boolean {
	if (address === "::1" || address === "::" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
	if (address.startsWith("::ffff:")) return isPrivateAddress(address.slice(7));
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
	const [a, b] = parts;
	return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
		(a === 192 && b === 0) || a >= 224;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let output = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel();
			throw new Error(`Response exceeds ${maxBytes} bytes`);
		}
		output += decoder.decode(value, { stream: true });
	}
	return output + decoder.decode();
}

function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<!--[^]*?-->/g, " ")
			.replace(/<(script|style|noscript|svg|canvas|template|form)[^>]*>[^]*?<\/\1>/gi, " ")
			.replace(/<(nav|footer|header|aside)[^>]*>[^]*?<\/\1>/gi, " ")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote)>/gi, "\n")
			.replace(/<li[^>]*>/gi, "- ")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[\t\r ]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function extractTitle(html: string): string {
	const match = /<title[^>]*>([^]*?)<\/title>/i.exec(html);
	return match ? decodeEntities(stripHtml(match[1])).trim().slice(0, 300) : "";
}

function stripHtml(value: string): string {
	return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
		if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
		if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
		return named[entity.toLowerCase()] ?? `&${entity};`;
	});
}

function formatSearchResults(query: string, provider: string, results: SearchResult[]): string {
	const lines = [`# Web search: ${query}`, `Provider: ${provider}`, ""];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		lines.push(`${i + 1}. ${result.title}`, `   ${result.url}`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
		lines.push("");
	}
	return lines.join("\n").trim();
}

function textResult(text: string, details: unknown, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

async function requireOk(response: Response, label: string): Promise<void> {
	if (response.ok) return;
	const body = (await response.text().catch(() => "")).slice(0, 300);
	throw new Error(`${label} returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

function isTextContentType(contentType: string): boolean {
	return contentType.startsWith("text/") || contentType === "application/json" || contentType.endsWith("+json") || contentType === "application/xml";
}

function combinedSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.name === "AbortError") return "request timed out or was cancelled";
	return error instanceof Error ? error.message : String(error);
}

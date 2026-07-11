import { isIP } from "node:net";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, withToolPolicy, type ToolPolicy } from "./tool-runtime.ts";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const MAX_TEXT_CHARS = 30_000;

export interface BrowserToolsOptions { cdpUrl?: string; fetchImpl?: typeof fetch; }

/**
 * First-class, Chrome DevTools Protocol browser capability. Read operations
 * are separate from mutating browser actions so approval policy can be exact.
 */
export function createBrowserTools(options: BrowserToolsOptions = {}): ToolDefinition[] {
	const cdpUrl = validateLocalCdpUrl(options.cdpUrl ?? DEFAULT_CDP_URL);
	const fetchImpl = options.fetchImpl ?? fetch;
	const tools = [
		defineTool({ name: "browser_status", label: "Browser Status", description: "List pages available in the local managed Chrome browser.", parameters: Type.Object({}), execute: async () => browserResult(async () => {
			const pages = await listPages(cdpUrl, fetchImpl);
			return { text: pages.length ? pages.map((page, index) => `${index + 1}. ${page.title || "Untitled"}\n${page.url}`).join("\n\n") : "No browser pages are open.", details: { pages } };
		}) }),
		defineTool({ name: "browser_open", label: "Open Browser Page", description: "Navigate the managed browser to an HTTP(S) URL. Requires approval; direct private-network URLs are rejected.", parameters: Type.Object({ url: Type.String({ minLength: 8, maxLength: 4096 }) }), execute: async (_id, params) => browserResult(async () => {
			const url = validatePublicBrowserUrl(params.url);
			const page = await activePage(cdpUrl, fetchImpl);
			await cdp(page.webSocketDebuggerUrl, "Page.navigate", { url });
			return { text: `Opened ${url}`, details: { url, pageId: page.id } };
		}) }),
		defineTool({ name: "browser_read", label: "Read Browser Page", description: "Read visible text from the active browser page or a CSS selector.", parameters: Type.Object({ selector: Type.Optional(Type.String({ maxLength: 512 })), maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: MAX_TEXT_CHARS })) }), execute: async (_id, params) => browserResult(async () => {
			const page = await activePage(cdpUrl, fetchImpl);
			const selector = params.selector?.trim() || "body";
			const expression = `(() => document.querySelector(${JSON.stringify(selector)})?.innerText?.slice(0, ${params.maxChars ?? 12_000}) ?? "")()`;
			const value = await evaluate(page.webSocketDebuggerUrl, expression, true);
			return { text: String(value) || `No readable content matched ${selector}.`, details: { selector, url: page.url } };
		}) }),
		defineTool({ name: "browser_click", label: "Click Browser Element", description: "Click a CSS-selected browser element. This can change external state and requires approval.", parameters: Type.Object({ selector: Type.String({ minLength: 1, maxLength: 512 }) }), execute: async (_id, params) => browserResult(async () => {
			const page = await activePage(cdpUrl, fetchImpl);
			const expression = `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) return { ok: false, reason: "not found" }; (el instanceof HTMLElement ? el : el).click(); return { ok: true }; })()`;
			const value = await evaluate(page.webSocketDebuggerUrl, expression, true) as { ok?: boolean; reason?: string };
			return { text: value?.ok ? `Clicked ${params.selector}` : `Could not click ${params.selector}: ${value?.reason ?? "unknown error"}`, details: { selector: params.selector, url: page.url, ...value }, isError: !value?.ok };
		}) }),
		defineTool({ name: "browser_fill", label: "Fill Browser Field", description: "Fill a CSS-selected browser input and dispatch input/change events. Requires approval.", parameters: Type.Object({ selector: Type.String({ minLength: 1, maxLength: 512 }), text: Type.String({ maxLength: 10_000 }) }), execute: async (_id, params) => browserResult(async () => {
			const page = await activePage(cdpUrl, fetchImpl);
			const expression = `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return { ok: false, reason: "not an input" }; el.value = ${JSON.stringify(params.text)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { ok: true }; })()`;
			const value = await evaluate(page.webSocketDebuggerUrl, expression, true) as { ok?: boolean; reason?: string };
			return { text: value?.ok ? `Filled ${params.selector}` : `Could not fill ${params.selector}: ${value?.reason ?? "unknown error"}`, details: { selector: params.selector, url: page.url, ...value }, isError: !value?.ok };
		}) }),
		defineTool({ name: "browser_cookies", label: "Read Browser Cookies", description: "Read browser cookies for diagnostics. Sensitive: requires approval.", parameters: Type.Object({}), execute: async () => browserResult(async () => {
			const page = await activePage(cdpUrl, fetchImpl);
			const result = await cdp(page.webSocketDebuggerUrl, "Network.getAllCookies") as { cookies?: Array<{ name: string; domain: string; httpOnly: boolean; secure: boolean }> };
			const cookies = (result.cookies ?? []).map(({ name, domain, httpOnly, secure }) => ({ name, domain, httpOnly, secure }));
			return { text: cookies.length ? cookies.map((cookie) => `${cookie.name} · ${cookie.domain}${cookie.httpOnly ? " · HttpOnly" : ""}${cookie.secure ? " · Secure" : ""}`).join("\n") : "No cookies found.", details: { cookies } };
		}) }),
	];
	const policies: Record<string, ToolPolicy> = {
		browser_status: { ...READ_ONLY_TOOL_POLICY },
		browser_read: { ...READ_ONLY_TOOL_POLICY },
		browser_open: { ...MUTATING_TOOL_POLICY, risk: "medium", reversible: true, impact: "Navigates the managed browser and may contact an external website" },
		browser_click: { ...MUTATING_TOOL_POLICY, impact: "Clicks a page element and may change external service state" },
		browser_fill: { ...MUTATING_TOOL_POLICY, impact: "Places user-provided data into an external web page" },
		browser_cookies: { ...MUTATING_TOOL_POLICY, sideEffect: "none", reversible: true, impact: "Reads sensitive browser cookie metadata" },
	};
	return tools.map((tool) => withToolPolicy(tool, policies[tool.name]!));
}

interface BrowserPage { id: string; title: string; url: string; type: string; webSocketDebuggerUrl: string; }

async function listPages(cdpUrl: string, fetchImpl: typeof fetch): Promise<BrowserPage[]> {
	const response = await fetchImpl(`${cdpUrl.replace(/\/$/, "")}/json`, { signal: AbortSignal.timeout(5_000) });
	if (!response.ok) throw new Error(`Managed browser is unavailable (${response.status}). Start it with the Pi browser-start.js script.`);
	return ((await response.json()) as BrowserPage[]).filter((page) => page.type === "page" && page.webSocketDebuggerUrl && isLocalDebuggerUrl(page.webSocketDebuggerUrl));
}

async function activePage(cdpUrl: string, fetchImpl: typeof fetch): Promise<BrowserPage> {
	const page = (await listPages(cdpUrl, fetchImpl))[0];
	if (!page) throw new Error("No managed browser page is open. Start Chrome and open a page first.");
	return page;
}

async function cdp(url: string, method: string, params?: unknown): Promise<unknown> {
	if (!isLocalDebuggerUrl(url)) throw new Error("Managed browser debugger endpoint must be local.");
	const socket = new WebSocket(url);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { socket.close(); reject(new Error(`Browser command ${method} timed out`)); }, 10_000);
		socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
		socket.addEventListener("message", (event) => {
			try {
				const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
				if (message.id !== 1) return;
				clearTimeout(timer); socket.close();
				if (message.error) reject(new Error(message.error.message ?? `Browser command ${method} failed`)); else resolve(message.result);
			} catch (error) { clearTimeout(timer); socket.close(); reject(error); }
		});
		socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to the managed browser.")); });
	});
}

async function evaluate(url: string, expression: string, returnByValue: boolean): Promise<unknown> {
	const result = await cdp(url, "Runtime.evaluate", { expression, returnByValue, awaitPromise: true }) as { result?: { value?: unknown } };
	return result.result?.value;
}

function validatePublicBrowserUrl(input: string): string {
	const url = new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Browser navigation only supports public HTTP(S) URLs.");
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || isIP(host) || host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.") || host.startsWith("100.") || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error("Browser navigation to local or private network addresses is blocked.");
	return url.toString();
}

function validateLocalCdpUrl(input: string): string {
	const url = new URL(input);
	if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password) throw new Error("Browser CDP must use a local unauthenticated HTTP endpoint.");
	return url.toString().replace(/\/$/, "");
}

function isLocalDebuggerUrl(input: string): boolean {
	try { const url = new URL(input); return (url.protocol === "ws:" || url.protocol === "wss:") && isLoopbackHost(url.hostname) && !url.username && !url.password; }
	catch { return false; }
}

function isLoopbackHost(host: string): boolean { return host === "127.0.0.1" || host === "::1" || host === "localhost"; }

async function browserResult(run: () => Promise<{ text: string; details: unknown; isError?: boolean }>) {
	try { const result = await run(); return { content: [{ type: "text" as const, text: result.text }], details: result.details, isError: result.isError }; }
	catch (error) { return { content: [{ type: "text" as const, text: `Browser access failed: ${error instanceof Error ? error.message : String(error)}` }], details: {}, isError: true }; }
}

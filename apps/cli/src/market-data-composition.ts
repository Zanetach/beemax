import { createHash } from "node:crypto";
import { createSourceReceipt, defineTool, READ_ONLY_TOOL_POLICY, withToolPolicy, type ToolDefinition } from "@beemax/core";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { Type } from "typebox";

const TWELVE_DATA_XAU_URL = "https://twelvedata.com/markets/300755/commodity/xau-usd/historical-data";
const NBP_BASE_URL = "https://api.nbp.pl/api";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TROY_OUNCE_GRAMS = 31.1034768;

type FetchPort = (input: string, init?: RequestInit) => Promise<Response>;
type HtmlNode = DefaultTreeAdapterMap["node"];

export interface StructuredMarketToolOptions {
	fetch?: FetchPort;
	now?: () => number;
}

interface MarketPoint { date: string; open: number; high: number; low: number; close: number; changePct: number; }
interface NbpReferencePoint { date: string; goldPlnPerGram: number; usdPlnMid: number; usdPerTroyOunce: number; table: string; }

/** Composes source-specific market adapters behind one content-addressed, auditable Tool receipt. */
export function createStructuredMarketTools(options: StructuredMarketToolOptions = {}): ToolDefinition[] {
	const fetchPort = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const tool = Object.assign(withToolPolicy(defineTool({
		name: "market_series",
		label: "Structured Market Series",
		description: "Fetch a source-timestamped structured market series and an independent cross-check. Currently supports XAU/USD spot only; unsupported instruments fail closed rather than being relabeled.",
		parameters: Type.Object({
			symbol: Type.String({ minLength: 3, maxLength: 32 }),
			startDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
			endDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
		}),
		execute: async (_toolCallId, params, callerSignal) => {
			const symbol = normalizeSupportedSymbol(params.symbol);
			const period = validDatePeriod(params.startDate, params.endDate, now());
			const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
			const goldUrl = `${NBP_BASE_URL}/cenyzlota/${period.startDate}/${period.endDate}/?format=json`;
			const usdUrl = `${NBP_BASE_URL}/exchangerates/rates/a/usd/${period.startDate}/${period.endDate}/?format=json`;
			const [marketHtml, goldJson, usdJson] = await Promise.all([
				fetchBounded(fetchPort, TWELVE_DATA_XAU_URL, "text/html", signal),
				fetchBounded(fetchPort, goldUrl, "application/json", signal),
				fetchBounded(fetchPort, usdUrl, "application/json", signal),
			]);
			const primary = parseTwelveDataXau(marketHtml, period);
			const reference = parseNbpReference(goldJson, usdJson, period);
			const observations = primary.points.flatMap((point) => {
				const comparison = reference.points.find((candidate) => candidate.date === point.date);
				if (!comparison) return [];
				const differencePct = round((point.close - comparison.usdPerTroyOunce) / comparison.usdPerTroyOunce * 100, 6);
				return [{ date: point.date, primaryClose: point.close, referenceValue: comparison.usdPerTroyOunce, differencePct }];
			});
			if (!observations.length) throw new Error("Structured market series has no overlapping independent cross-check observations");
			const maxAbsDifferencePct = round(Math.max(...observations.map((item) => Math.abs(item.differencePct))), 6);
			const crosscheckStatus = maxAbsDifferencePct <= 5 ? "accepted" as const : "diverged" as const;
			const retrievedAt = new Date(now()).toISOString();
			const statistics = marketStatistics(primary.points);
			const unsigned = {
				schemaVersion: "beemax.market-series.v1" as const,
				instrument: { symbol, baseAsset: "XAU", quoteCurrency: "USD", assetClass: "precious_metal_spot", unit: "USD/troy_oz" },
				interval: "daily" as const,
				timezone: "Australia/Sydney (AEST, UTC+10 as declared by the primary source)",
				tradingDayDefinition: "Daily provider observations keyed by published calendar date; callers choose the requested market-session window.",
				period,
				points: primary.points,
				statistics,
				sources: [
					{ providerId: "twelve-data-public-market-page", role: "primary" as const, url: TWELVE_DATA_XAU_URL, retrievedAt, sourceTimestamp: primary.sourceTimestamp, methodology: "Server-rendered Gold Spot / US Dollar daily OHLC table; values are read from the declared XAU/USD market page." },
					{ providerId: "nbp-official-gold-fx", role: "crosscheck" as const, urls: [goldUrl, usdUrl], retrievedAt, sourceTimestamp: reference.sourceTimestamp, methodology: "NBP-calculated price of 1 g fine gold in PLN divided by the official table-A USD/PLN mid rate, then multiplied by 31.1034768 g/troy oz. This is an independent daily reference, not an intraday close." },
				],
				crosscheck: { status: crosscheckStatus, tolerancePct: 5, maxAbsDifferencePct, observations },
				disclaimer: "Indicative public market research data; not a tradable quote, settlement benchmark, or investment advice.",
			};
			const receipt = { ...unsigned, id: `market-series:sha256:${sha256Json(unsigned)}` };
			const sourceReceipt = createSourceReceipt({
				capability: "market_series",
				subject: `${symbol} ${period.startDate}..${period.endDate}`,
				observedAt: Date.parse(retrievedAt),
				sourceRefs: [TWELVE_DATA_XAU_URL, goldUrl, usdUrl],
				payload: receipt,
			});
			const executionView = JSON.stringify(receipt);
			return {
				content: [{ type: "text" as const, text: `Fetched ${symbol} ${period.startDate}..${period.endDate}: ${primary.points.length} daily OHLC observations, two independent sources, cross-check ${crosscheckStatus} (max difference ${maxAbsDifferencePct.toFixed(2)}%). Structured receipt ${receipt.id}; source receipt ${sourceReceipt.id}.\n<market-series-json>${executionView}</market-series-json>` }],
				details: { marketSeries: receipt, sourceReceipt },
			};
		},
	}), READ_ONLY_TOOL_POLICY), {
		aliases: ["market_ohlc", "xau_usd_series", "structured_market_data"],
		triggers: ["XAU/USD", "黄金走势", "gold price", "OHLC", "market series", "行情数据"],
		beemaxToolSpec: { kind: "tool" as const, version: "1", configured: true, health: "ready" as const, ranking: { inputModalities: ["symbol", "date-range"], outputModalities: ["structured"], freshness: "current" as const, evidence: "verified" as const } },
	});
	return [tool];
}

function normalizeSupportedSymbol(value: string): "XAU/USD" {
	const normalized = value.trim().toLocaleUpperCase().replaceAll(" ", "");
	if (normalized !== "XAU/USD" && normalized !== "XAUUSD") throw new Error(`Structured market Provider received unsupported instrument ${value.trim() || "(empty)"}`);
	return "XAU/USD";
}

function validDatePeriod(startDate: string, endDate: string, now: number): { startDate: string; endDate: string } {
	const start = strictUtcDate(startDate); const end = strictUtcDate(endDate);
	if (start > end) throw new Error("Structured market startDate must not be after endDate");
	if ((end - start) / 86_400_000 > 31) throw new Error("Structured market date range may not exceed 31 calendar days");
	const currentDate = new Date(now).toISOString().slice(0, 10);
	if (endDate > currentDate) throw new Error("Structured market endDate may not be in the future");
	return { startDate, endDate };
}

function strictUtcDate(value: string): number {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Structured market date is invalid: ${value}`);
	const timestamp = Date.parse(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error(`Structured market date is invalid: ${value}`);
	return timestamp;
}

async function fetchBounded(fetchPort: FetchPort, url: string, expectedType: "text/html" | "application/json", signal: AbortSignal): Promise<string> {
	const response = await fetchPort(url, { method: "GET", headers: { accept: expectedType, "user-agent": "BeeMax/1.4 structured-market-provider" }, redirect: "error", signal });
	if (!response.ok) throw new Error(`Structured market source ${new URL(url).hostname} returned HTTP ${response.status}`);
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== expectedType) throw new Error(`Structured market source ${new URL(url).hostname} returned unexpected content type ${contentType || "missing"}`);
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new Error("Structured market source response exceeds the bounded size");
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (!bytes.length || bytes.length > MAX_RESPONSE_BYTES) throw new Error("Structured market source returned an empty or oversized response");
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseTwelveDataXau(source: string, period: { startDate: string; endDate: string }): { points: MarketPoint[]; sourceTimestamp: string } {
	const document = parse(source);
	const container = findElement(document, (element) => attribute(element, "class")?.split(/\s+/).includes("statistics-historical-prices-table") === true);
	if (!container) throw new Error("Twelve Data XAU/USD page did not contain its structured historical price table");
	const points = descendants(container)
		.filter((node): node is DefaultTreeAdapterMap["element"] => "tagName" in node && node.tagName === "tr")
		.flatMap((row): MarketPoint[] => {
			const cells = row.childNodes.filter((node): node is DefaultTreeAdapterMap["element"] => "tagName" in node && node.tagName === "td").map((cell) => nodeText(cell));
			if (cells.length !== 6) return [];
			const date = englishMarketDate(cells[0]!);
			if (date < period.startDate || date > period.endDate) return [];
			return [{ date, open: marketNumber(cells[1]!), high: marketNumber(cells[2]!), low: marketNumber(cells[3]!), close: marketNumber(cells[4]!), changePct: percentNumber(cells[5]!) }];
		})
		.sort((left, right) => left.date.localeCompare(right.date));
	if (!points.length) throw new Error("Twelve Data XAU/USD page contained no observations in the requested period");
	for (const point of points) if (!(point.low <= Math.min(point.open, point.close) && point.high >= Math.max(point.open, point.close) && point.low <= point.high)) throw new Error(`Twelve Data XAU/USD OHLC relationship is invalid on ${point.date}`);
	const update = nodeText(document).match(/Last update\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+AEST/i);
	if (!update) throw new Error("Twelve Data XAU/USD page did not publish a source timestamp");
	const latestYear = Number(points.at(-1)!.date.slice(0, 4));
	const month = monthNumber(update[1]!); const day = Number(update[2]); let hour = Number(update[3]) % 12; if (update[5]!.toUpperCase() === "PM") hour += 12;
	const sourceTimestamp = new Date(Date.UTC(latestYear, month - 1, day, hour - 10, Number(update[4]))).toISOString();
	return { points, sourceTimestamp };
}

function parseNbpReference(goldSource: string, usdSource: string, period: { startDate: string; endDate: string }): { points: NbpReferencePoint[]; sourceTimestamp: string } {
	const gold = JSON.parse(goldSource) as unknown; const usd = JSON.parse(usdSource) as unknown;
	if (!Array.isArray(gold) || !usd || typeof usd !== "object" || !Array.isArray((usd as { rates?: unknown }).rates)) throw new Error("NBP gold or USD response schema is invalid");
	const goldByDate = new Map(gold.flatMap((item): Array<[string, number]> => item && typeof item === "object" && typeof (item as { data?: unknown }).data === "string" && validPositiveNumber((item as { cena?: unknown }).cena) ? [[(item as { data: string }).data, Number((item as { cena: number }).cena)]] : []));
	const points = (usd as { rates: unknown[] }).rates.flatMap((item): NbpReferencePoint[] => {
		if (!item || typeof item !== "object") return [];
		const value = item as { effectiveDate?: unknown; mid?: unknown; no?: unknown };
		if (typeof value.effectiveDate !== "string" || !validPositiveNumber(value.mid) || typeof value.no !== "string") return [];
		const goldPlnPerGram = goldByDate.get(value.effectiveDate); if (!goldPlnPerGram || value.effectiveDate < period.startDate || value.effectiveDate > period.endDate) return [];
		const usdPlnMid = Number(value.mid);
		return [{ date: value.effectiveDate, goldPlnPerGram, usdPlnMid, usdPerTroyOunce: round(goldPlnPerGram / usdPlnMid * TROY_OUNCE_GRAMS, 4), table: value.no }];
	}).sort((left, right) => left.date.localeCompare(right.date));
	if (!points.length) throw new Error("NBP sources contained no overlapping gold and USD reference observations");
	return { points, sourceTimestamp: points.at(-1)!.date };
}

function marketStatistics(points: MarketPoint[]) {
	const first = points[0]!; const last = points.at(-1)!;
	return { firstOpen: first.open, firstClose: first.close, lastClose: last.close, periodHigh: Math.max(...points.map((point) => point.high)), periodLow: Math.min(...points.map((point) => point.low)), openToCloseChangePct: round((last.close - first.open) / first.open * 100, 6), closeToCloseChangePct: round((last.close - first.close) / first.close * 100, 6) };
}

function findElement(root: HtmlNode, predicate: (element: DefaultTreeAdapterMap["element"]) => boolean): DefaultTreeAdapterMap["element"] | undefined {
	return descendants(root).find((node): node is DefaultTreeAdapterMap["element"] => "tagName" in node && predicate(node));
}

function descendants(root: HtmlNode): HtmlNode[] {
	const result: HtmlNode[] = []; const queue: HtmlNode[] = [root];
	while (queue.length) { const node = queue.shift()!; result.push(node); if ("content" in node) queue.push(...node.content.childNodes); if ("childNodes" in node) queue.push(...node.childNodes); }
	return result;
}

function attribute(element: DefaultTreeAdapterMap["element"], name: string): string | undefined { return element.attrs.find((item) => item.name === name)?.value; }
function nodeText(node: HtmlNode): string { return normalizeText("value" in node ? node.value : "childNodes" in node ? node.childNodes.map((child) => nodeText(child)).join(" ") : ""); }
function normalizeText(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function englishMarketDate(value: string): string { const match = value.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})$/); if (!match) throw new Error(`Market observation date is invalid: ${value}`); return `${match[3]}-${String(monthNumber(match[1]!)).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`; }
function monthNumber(value: string): number { const index = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].findIndex((month) => month.toLowerCase() === value.toLowerCase()); if (index < 0) throw new Error(`Market month is invalid: ${value}`); return index + 1; }
function marketNumber(value: string): number { const match = value.replaceAll(",", "").match(/^(-?\d+(?:\.\d+)?)([KMB])?$/i); if (!match) throw new Error(`Market numeric value is invalid: ${value}`); const multiplier = match[2]?.toUpperCase() === "K" ? 1_000 : match[2]?.toUpperCase() === "M" ? 1_000_000 : match[2]?.toUpperCase() === "B" ? 1_000_000_000 : 1; const number = Number(match[1]) * multiplier; if (!validPositiveNumber(number)) throw new Error(`Market numeric value is invalid: ${value}`); return round(number, 6); }
function percentNumber(value: string): number { const number = Number(value.replace("%", "")); if (!Number.isFinite(number)) throw new Error(`Market percent value is invalid: ${value}`); return round(number, 6); }
function validPositiveNumber(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function round(value: number, decimals: number): number { const scale = 10 ** decimals; return Math.round((value + Number.EPSILON) * scale) / scale; }
function sha256Json(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

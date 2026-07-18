import assert from "node:assert/strict";
import test from "node:test";
import { createStructuredMarketTools } from "../dist/market-data-composition.js";

const twelveDataHtml = `<!doctype html><html><body>
<div class="statistics-historical-prices-table"><table><tbody>
<tr><td>Jul 17, 2026</td><td>3.9765K</td><td>4.0087K</td><td>3.9714K</td><td>3.9950K</td><td>0.4654%</td></tr>
<tr><td>Jul 16, 2026</td><td>4.0603K</td><td>4.0687K</td><td>3.9690K</td><td>3.9768K</td><td>-2.0581%</td></tr>
</tbody></table></div><div>Last update Jul 17, 7:50 PM AEST</div>
</body></html>`;

test("structured market Tool returns source-timestamped XAU/USD OHLC with an independent NBP cross-check", async () => {
	const requested = [];
	const fetch = async (input) => {
		const url = String(input); requested.push(url);
		if (url.includes("twelvedata.com")) return new Response(twelveDataHtml, { status: 200, headers: { "content-type": "text/html" } });
		if (url.includes("cenyzlota")) return Response.json([{ data: "2026-07-16", cena: 490.84 }, { data: "2026-07-17", cena: 489.41 }]);
		if (url.includes("exchangerates")) return Response.json({ table: "A", code: "USD", rates: [{ no: "136/A/NBP/2026", effectiveDate: "2026-07-16", mid: 3.7731 }, { no: "137/A/NBP/2026", effectiveDate: "2026-07-17", mid: 3.7951 }] });
		throw new Error(`unexpected URL ${url}`);
	};
	const [tool] = createStructuredMarketTools({ fetch, now: () => Date.parse("2026-07-17T10:00:00Z") });
	const result = await tool.execute("market:1", { symbol: "XAU/USD", startDate: "2026-07-16", endDate: "2026-07-17" }, new AbortController().signal);
	const receipt = result.details.marketSeries;
	assert.equal(receipt.schemaVersion, "beemax.market-series.v1");
	assert.match(receipt.id, /^market-series:sha256:[a-f0-9]{64}$/);
	assert.match(result.details.sourceReceipt.id, /^source-receipt:sha256:[a-f0-9]{64}$/);
	assert.equal(result.details.sourceReceipt.payload.id, receipt.id);
	assert.deepEqual(receipt.instrument, { symbol: "XAU/USD", baseAsset: "XAU", quoteCurrency: "USD", assetClass: "precious_metal_spot", unit: "USD/troy_oz" });
	assert.deepEqual(receipt.points.map(({ date, open, high, low, close }) => ({ date, open, high, low, close })), [
		{ date: "2026-07-16", open: 4060.3, high: 4068.7, low: 3969, close: 3976.8 },
		{ date: "2026-07-17", open: 3976.5, high: 4008.7, low: 3971.4, close: 3995 },
	]);
	assert.equal(receipt.sources[0].sourceTimestamp, "2026-07-17T09:50:00.000Z");
	assert.equal(receipt.sources[1].providerId, "nbp-official-gold-fx");
	assert.equal(receipt.crosscheck.observations.length, 2);
	assert.equal(receipt.crosscheck.status, "accepted");
	assert.equal(receipt.tradingDayDefinition, "Daily provider observations keyed by published calendar date; callers choose the requested market-session window.");
	assert.equal(requested.length, 3);
	assert.match(result.content[0].text, /two independent sources/i);
	assert.match(result.content[0].text, /"date":"2026-07-16","open":4060\.3,"high":4068\.7,"low":3969,"close":3976\.8/);
	assert.match(result.content[0].text, new RegExp(result.details.sourceReceipt.id));
	assert.match(result.content[0].text, /https:\/\/twelvedata\.com\/markets\/300755\/commodity\/xau-usd\/historical-data/);
});

test("structured market Tool rejects unsupported instruments instead of relabeling another market", async () => {
	const [tool] = createStructuredMarketTools({ fetch: async () => assert.fail("unsupported symbols must fail before network access") });
	await assert.rejects(() => tool.execute("market:unsupported", { symbol: "GC=F", startDate: "2026-07-16", endDate: "2026-07-17" }, new AbortController().signal), /unsupported.*GC=F/i);
});

test("structured market Tool rejects a source response with the wrong media type", async () => {
	const [tool] = createStructuredMarketTools({ fetch: async () => new Response("not html", { status: 200, headers: { "content-type": "text/plain" } }), now: () => Date.parse("2026-07-17T10:00:00Z") });
	await assert.rejects(() => tool.execute("market:content-type", { symbol: "XAU/USD", startDate: "2026-07-16", endDate: "2026-07-17" }, new AbortController().signal), /unexpected content type/i);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createLocalArtifactRuntime, discoverChromeExecutable, LocalArtifactVerifier } from "../dist/artifact-composition.js";

const chrome = discoverChromeExecutable();

test("Artifact composition fails closed on an explicitly invalid Chrome executable", () => {
	assert.equal(discoverChromeExecutable({ BEEMAX_CHROME_EXECUTABLE: "/definitely/not/chrome" }), undefined);
	const runtime = createLocalArtifactRuntime("/tmp", { chromeExecutable: "/definitely/not/chrome" });
	assert.equal(runtime.providers.length, 0);
});

test("local Artifact consistency rejects a non-HTML source before touching the output Artifact", async () => {
	const verifier = new LocalArtifactVerifier("/definitely/not/a/workspace");
	await assert.rejects(() => verifier.verify({
		locator: { kind: "workspace", uri: "workspace:missing.html" }, mediaType: "text/html", dimensions: ["consistency"],
		expectation: { consistentWith: { locator: { kind: "workspace", uri: "workspace:report.pdf" }, mediaType: "application/pdf" } },
	}), /consistency requires a text\/html source/i);
});

test("local Artifact composition rejects active or remotely loaded HTML before rendering", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "beemax-artifact-unsafe-html-"));
	const runtime = createLocalArtifactRuntime(cwd, { chromeExecutable: chrome });
	const unsafeDocuments = [
		["script.html", "<!doctype html><html><body><script>fetch('https://example.com/private')</script><p>Report</p></body></html>"],
		["remote-image.html", "<!doctype html><html><body><img src=\"https://example.com/pixel\"><p>Report</p></body></html>"],
		["css-import.html", "<!doctype html><html><head><style>@import 'https://example.com/style.css'</style></head><body><p>Report</p></body></html>"],
		["handler.html", "<!doctype html><html><body onload=\"location='https://example.com'\"><p>Report</p></body></html>"],
		["refresh.html", "<!doctype html><html><head><meta http-equiv=refresh content=\"0;url=https://example.com\"></head><body><p>Report</p></body></html>"],
	];
	for (const [name, source] of unsafeDocuments) {
		await writeFile(join(cwd, name), source);
		await assert.rejects(() => runtime.inspect(
			{ kind: "workspace", uri: `workspace:${name}` },
			"text/html",
			["integrity"],
		), /HTML.*(?:active content|external resource|event handler|navigation)/i, name);
	}
});

test("local Artifact composition permits inert citation links and inline data images", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "beemax-artifact-safe-html-"));
	await writeFile(join(cwd, "safe.html"), `<!doctype html><html><head><style>body{color:#123;background:#fff}</style></head><body>
		<p>Source: <a href="https://example.com/report" rel="noreferrer">market report</a></p>
		<img alt="one pixel" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
	</body></html>`);
	const runtime = createLocalArtifactRuntime(cwd, { chromeExecutable: chrome });
	const result = await runtime.inspect({ kind: "workspace", uri: "workspace:safe.html" }, "text/html", ["integrity"]);
	assert.equal(result.checks[0]?.status, "accepted");
});

test("local Artifact semantic verification counts unique external HTML citation URLs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "beemax-artifact-external-urls-"));
	await writeFile(join(cwd, "sources.html"), `<!doctype html><html><head><title>Sources</title></head><body>
		<h1>Verified sources</h1>
		<a href="https://example.com/report#summary">first</a>
		<a href="https://example.com/report#details">duplicate document</a>
		<a href="https://data.example.org/series">second</a>
	</body></html>`);
	const runtime = createLocalArtifactRuntime(cwd, { chromeExecutable: chrome });
	const accepted = await runtime.inspect(
		{ kind: "workspace", uri: "workspace:sources.html" },
		"text/html",
		["semantic"],
		{ minimumExternalUrls: 2, maximumExternalUrls: 2 },
	);
	assert.equal(accepted.checks[0]?.status, "accepted");
	assert.ok(accepted.checks[0]?.evidenceRefs.includes("semantic:external-urls:2"));
	assert.deepEqual(accepted.checks[0]?.evidenceRefs.filter((ref) => ref.startsWith("artifact:external-url:")), [
		"artifact:external-url:https://data.example.org/series",
		"artifact:external-url:https://example.com/report",
	]);
	await assert.rejects(() => runtime.inspect(
		{ kind: "workspace", uri: "workspace:sources.html" },
		"text/html",
		["semantic"],
		{ minimumExternalUrls: 3, maximumExternalUrls: 3 },
	), /Artifact verification semantic was rejected/i);
});

test("local Artifact semantic verification binds each raw source value to its visible formatted equivalent", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "beemax-artifact-source-assertions-"));
	await writeFile(join(cwd, "report.html"), `<!doctype html><html><head><title>Report</title></head><body>
		<p><span data-raw-open="4111.4">周开盘 4,111.40</span>；<span data-raw-last="4007.8">抓取时点最新价 4,007.80，而非最终结算价。</span></p>
	</body></html>`);
	const runtime = createLocalArtifactRuntime(cwd, { chromeExecutable: chrome });
	const accepted = await runtime.inspect(
		{ kind: "workspace", uri: "workspace:report.html" },
		"text/html",
		["semantic"],
		{
			requiredText: ["4,111.40", "抓取时点最新价"], requiredSourceText: ["4111.4", "4007.8"],
			requiredSourceVisiblePairs: [
				{ sourceText: "4111.4", visibleText: "4,111.40" },
				{ sourceText: "4007.8", visibleText: "4,007.80" },
			],
		},
	);
	assert.equal(accepted.checks[0]?.status, "accepted");
	await assert.rejects(() => runtime.inspect(
		{ kind: "workspace", uri: "workspace:report.html" },
		"text/html",
		["semantic"],
		{
			requiredText: ["4,111.40", "而非最终结算"], requiredSourceText: ["4111.4", "4007.8"],
			requiredSourceVisiblePairs: [{ sourceText: "4111.4", visibleText: "4,007.80" }],
		},
	), (error) => {
		assert.match(error.message, /4111\.4/u);
		assert.match(error.message, /4,007\.80/u);
		return true;
	});
});

test("local Artifact composition uses a real Chrome Provider and independent PDF renderer", { skip: chrome ? false : "Chrome/Chromium is not installed" }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "beemax-artifact-e2e-"));
	await writeFile(join(cwd, "gold-report.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Weekly Gold Market Report</title>
<style>body{font:16px system-ui;max-width:760px;margin:40px auto;color:#16261d}h1{color:#0a5c36}.metric{font-size:24px;font-weight:700}</style></head>
<body><h1>Weekly Gold Market Report</h1><p class="metric">Gold moved 2.4% over the observed period.</p>
<p>This reproducible fixture validates PDF text extraction, page rendering, and HTML to PDF consistency.</p>
<p><a href="https://example.com/market-report">Material market source</a></p></body></html>`);

	const runtime = createLocalArtifactRuntime(cwd, { chromeExecutable: chrome });
	const result = await runtime.produce({
		operation: "render",
		input: { kind: "workspace", uri: "workspace:gold-report.html" }, inputMediaType: "text/html",
		output: { kind: "workspace", uri: "workspace:gold-report.pdf" }, outputMediaType: "application/pdf",
		requiredDimensions: ["existence", "integrity", "semantic", "render", "consistency"],
		expectation: {
			requiredText: ["Weekly Gold Market Report", "Gold moved 2.4%", "PDF text extraction"],
			minimumTextChars: 120,
		},
	});

	const pdf = await readFile(join(cwd, "gold-report.pdf"));
	assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
	assert.ok(pdf.byteLength > 5_000);
	const document = await getDocument({ data: new Uint8Array(pdf) }).promise;
	try {
		const text = [];
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
			const content = await (await document.getPage(pageNumber)).getTextContent();
			text.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
		}
		assert.doesNotMatch(text.join("\n").replaceAll(/\s+/g, ""), /file:\/\//i, "PDF must not expose the temporary renderer path in browser headers or footers");
	} finally { await document.cleanup(); }
	assert.equal(result.manifest.byteLength, pdf.byteLength);
	assert.deepEqual(result.receipt.checks.map((check) => [check.dimension, check.status]), [
		["existence", "accepted"], ["integrity", "accepted"], ["semantic", "accepted"], ["render", "accepted"], ["consistency", "accepted"],
	]);
	assert.ok(result.receipt.checks.find((check) => check.dimension === "consistency")?.evidenceRefs.includes("consistency:source-external-urls:1"));
	assert.ok(result.receipt.checks.find((check) => check.dimension === "consistency")?.evidenceRefs.includes("consistency:output-external-urls:1"));
	assert.match(result.manifest.producer.providerVersion, /Chrome|Chromium/i);
	assert.notEqual(result.receipt.verifiers[0].id, result.manifest.producer.providerId);
});

test("local Artifact verification rejects a PDF whose required report content is absent", { skip: chrome ? false : "Chrome/Chromium is not installed" }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "beemax-artifact-negative-"));
	await writeFile(join(cwd, "empty.html"), "<!doctype html><html><body><h1>Different report</h1></body></html>");
	const runtime = createLocalArtifactRuntime(cwd, { chromeExecutable: chrome });
	await assert.rejects(() => runtime.produce({
		operation: "render",
		input: { kind: "workspace", uri: "workspace:empty.html" }, inputMediaType: "text/html",
		output: { kind: "workspace", uri: "workspace:empty.pdf" }, outputMediaType: "application/pdf",
		requiredDimensions: ["existence", "integrity", "semantic", "render", "consistency"],
		expectation: { requiredText: ["Weekly Gold Market Report", "Gold moved 2.4%"], minimumTextChars: 100 },
	}), /Artifact verification semantic was rejected/i);
});

test("HTML render verification covers the printable document instead of only the first viewport", { skip: chrome ? false : "Chrome/Chromium is not installed" }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "beemax-artifact-full-document-render-"));
	await writeFile(join(cwd, "long.html"), `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px system-ui}.page{min-height:900px}</style></head><body>${Array.from({ length: 4 }, (_, index) => `<section class="page"><h2>Section ${index + 1}</h2><p>${"Full document evidence. ".repeat(80)}</p></section>`).join("")}</body></html>`);
	const runtime = createLocalArtifactRuntime(cwd, { chromeExecutable: chrome });
	const result = await runtime.inspect({ kind: "workspace", uri: "workspace:long.html" }, "text/html", ["render"]);
	const render = result.checks[0];
	assert.equal(render.status, "accepted");
	assert.ok(render.evidenceRefs.some((ref) => ref.startsWith("render:pdf-pages:")));
	assert.ok(render.evidenceRefs.some((ref) => ref.startsWith("render:text-retained-ppm:")));
});

test("local Artifact consistency tolerates renderer whitespace inserted between CJK glyph runs", { skip: chrome ? false : "Chrome/Chromium is not installed" }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "beemax-artifact-cjk-"));
	const paragraph = "现货黄金在过去一周受美元走强与美债收益率上升影响出现回调，公开来源显示市场仍受到地缘风险和政策预期的共同驱动。";
	await writeFile(join(cwd, "cjk.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{font-family:system-ui;max-width:620px;margin:30px;font-size:18px;line-height:1.7}</style></head><body><h1>黄金周度报告</h1>${Array.from({ length: 12 }, (_, index) => `<p>${index + 1}、${paragraph}</p>`).join("")}</body></html>`);
	const runtime = createLocalArtifactRuntime(cwd, { chromeExecutable: chrome });
	const result = await runtime.produce({
		operation: "render", input: { kind: "workspace", uri: "workspace:cjk.html" }, inputMediaType: "text/html",
		output: { kind: "workspace", uri: "workspace:cjk.pdf" }, outputMediaType: "application/pdf",
		requiredDimensions: ["existence", "integrity", "semantic", "render", "consistency"],
		expectation: { requiredText: ["黄金周度报告", "现货黄金在过去一周", "地缘风险和政策预期"], minimumTextChars: 300 },
	});
	assert.deepEqual(result.receipt.checks.map((check) => [check.dimension, check.status]), [
		["existence", "accepted"], ["integrity", "accepted"], ["semantic", "accepted"], ["render", "accepted"], ["consistency", "accepted"],
	]);
});

test("PDF semantic verification tolerates renderer line breaks inside machine tokens and equivalent minus glyphs", { skip: chrome ? false : "Chrome/Chromium is not installed" }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "beemax-artifact-machine-token-wrap-"));
	const receipt = `market-series:sha256:${"a".repeat(64)}`;
	const source = "https://www.example.com/market/reports/2026/07/17/xau-usd-weekly-analysis";
	await writeFile(join(cwd, "wrapped.html"), `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px system-ui;width:220px;overflow-wrap:anywhere}</style></head><body><h1>黄金周报</h1><p>周度涨跌：−2.92%</p><p>${receipt}</p><p>${source}</p><p>${"可验证内容。".repeat(80)}</p></body></html>`);
	const runtime = createLocalArtifactRuntime(cwd, { chromeExecutable: chrome });
	const result = await runtime.produce({
		operation: "render", input: { kind: "workspace", uri: "workspace:wrapped.html" }, inputMediaType: "text/html",
		output: { kind: "workspace", uri: "workspace:wrapped.pdf" }, outputMediaType: "application/pdf",
		requiredDimensions: ["existence", "integrity", "semantic", "render", "consistency"],
		expectation: { requiredText: ["-2.92%", receipt, source], minimumTextChars: 300 },
	});
	assert.deepEqual(result.receipt.checks.map((check) => [check.dimension, check.status]), [
		["existence", "accepted"], ["integrity", "accepted"], ["semantic", "accepted"], ["render", "accepted"], ["consistency", "accepted"],
	]);
});

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
	ArtifactRuntime,
	type ArtifactLocator,
	type ArtifactProduceRequest,
	type ArtifactProviderPort,
	type ArtifactVerificationCheck,
	type ArtifactVerificationDimension,
	type ArtifactVerificationExpectation,
	type ArtifactVerifierPort,
} from "@beemax/core";

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MAX_RENDERED_PAGES = 20;
const BLOCKED_HTML_ELEMENTS = new Set([
	"applet", "audio", "base", "button", "embed", "fencedframe", "form", "frame", "frameset", "iframe", "input", "link",
	"object", "portal", "script", "select", "source", "textarea", "track", "video",
]);
const RESOURCE_ATTRIBUTES = new Set(["archive", "background", "codebase", "data", "formaction", "manifest", "ping", "poster", "srcdoc"]);
const INERT_DOCUMENT_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

export interface LocalArtifactRuntimeOptions {
	chromeExecutable?: string;
}

export function createLocalArtifactRuntime(cwd: string, options: LocalArtifactRuntimeOptions = {}): ArtifactRuntime {
	const chromeExecutable = options.chromeExecutable ?? discoverChromeExecutable();
	let provider: ChromePdfArtifactProvider | undefined;
	if (chromeExecutable) {
		try { provider = new ChromePdfArtifactProvider(cwd, chromeExecutable); } catch { /* Unhealthy renderers remain unavailable instead of breaking Profile startup. */ }
	}
	const verifier = new LocalArtifactVerifier(cwd, provider ? chromeExecutable : undefined);
	return new ArtifactRuntime({
		providers: provider ? [provider] : [],
		verifiers: [verifier],
	});
}

export function discoverChromeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const configured = env.BEEMAX_CHROME_EXECUTABLE?.trim();
	if (configured) {
		try { accessSync(configured, constants.X_OK); return configured; } catch { return undefined; }
	}
	const candidates = [
		...(process.platform === "darwin" ? [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		] : process.platform === "win32" ? [
			join(env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
			join(env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
		] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try the next declared executable. */ }
	}
	return undefined;
}

export class ChromePdfArtifactProvider implements ArtifactProviderPort {
	readonly descriptor;
	private readonly cwd: string;
	private readonly executable: string;
	constructor(cwd: string, executable: string) {
		this.cwd = cwd;
		this.executable = executable;
		const version = chromeVersion(executable);
		this.descriptor = Object.freeze({
			id: "beemax.chrome-pdf",
			version,
			operations: Object.freeze([{ operation: "render", inputMediaTypes: Object.freeze(["text/html"]), outputMediaTypes: Object.freeze(["application/pdf"]) }]),
		});
	}

	async produce(request: ArtifactProduceRequest): Promise<{ locator: ArtifactLocator; mediaType: string; sourceRefs: readonly string[] }> {
		if (request.operation !== "render" || request.inputMediaType !== "text/html" || request.outputMediaType !== "application/pdf") throw new Error("Chrome PDF Provider supports only text/html -> application/pdf rendering");
		const inputPath = await existingWorkspacePath(this.cwd, request.input, MAX_INPUT_BYTES);
		const outputPath = await writableWorkspacePath(this.cwd, request.output);
		const profileRoot = await mkdtemp(join(tmpdir(), "beemax-chrome-pdf-"));
		try {
			const input = inspectHtml(await readFile(inputPath, { signal: request.signal }));
			if (!input.valid || !input.inertSource) throw new Error(`Chrome PDF Provider rejected HTML: ${input.reason ?? "inert document preparation failed"}`);
			const inertInputPath = join(profileRoot, "input.html");
			await writeFile(inertInputPath, input.inertSource, { signal: request.signal });
			await rm(outputPath, { force: true });
			await runExecutable(this.executable, [
				...inertChromeArguments(join(profileRoot, "profile")), "--no-pdf-header-footer", "--print-to-pdf-no-header", `--print-to-pdf=${outputPath}`, pathToFileURL(inertInputPath).href,
			], outputPath, request.signal, 120_000);
			const output = await stat(outputPath);
			if (!output.isFile() || output.size <= 0 || output.size > MAX_ARTIFACT_BYTES) throw new Error("Chrome PDF Provider did not produce a bounded PDF file");
			return { locator: request.output, mediaType: "application/pdf", sourceRefs: [`workspace:${relative(await realpath(this.cwd), inputPath).replaceAll("\\", "/")}`] };
		} finally {
			await rm(profileRoot, { recursive: true, force: true });
		}
	}
}

export class LocalArtifactVerifier implements ArtifactVerifierPort {
	readonly descriptor = Object.freeze({
		id: "beemax.local-artifact-verifier",
		version: "1",
		mediaTypes: Object.freeze(["text/html", "application/pdf"]),
		dimensions: Object.freeze<ArtifactVerificationDimension[]>(["existence", "integrity", "semantic", "render", "consistency"]),
	});

	private readonly cwd: string;
	private readonly chromeExecutable?: string;
	constructor(cwd: string, chromeExecutable?: string) { this.cwd = cwd; this.chromeExecutable = chromeExecutable; }

	async verify(request: { locator: ArtifactLocator; mediaType: string; dimensions: readonly ArtifactVerificationDimension[]; expectation: Readonly<ArtifactVerificationExpectation>; signal?: AbortSignal }): Promise<{ observed: { locator: ArtifactLocator; mediaType: string; byteLength: number; sha256: string }; checks: readonly ArtifactVerificationCheck[] }> {
		throwIfAborted(request.signal);
		if (request.dimensions.includes("consistency") && request.expectation.consistentWith?.mediaType !== "text/html") throw new Error("Local Artifact consistency requires a text/html source; inspect the rendered Artifact as output and supply the HTML through consistentWith");
		const path = await existingWorkspacePath(this.cwd, request.locator, MAX_ARTIFACT_BYTES);
		const bytes = await readFile(path, { signal: request.signal });
		throwIfAborted(request.signal);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const media = request.mediaType === "application/pdf" ? await inspectPdf(bytes, request.signal) : request.mediaType === "text/html" ? inspectHtml(bytes) : undefined;
		if (!media) throw new Error(`Local Artifact Verifier does not support ${request.mediaType}`);
		const checks: ArtifactVerificationCheck[] = [];
		try {
			for (const dimension of request.dimensions) {
				if (dimension === "existence") checks.push(check(dimension, bytes.byteLength > 0 ? "accepted" : "rejected", [`artifact:bytes:${bytes.byteLength}`], bytes.byteLength > 0 ? undefined : "Artifact is empty"));
				else if (dimension === "integrity") checks.push(check(dimension, media.valid ? "accepted" : "rejected", [`artifact:sha256:${sha256}`], media.valid ? undefined : media.reason));
				else if (dimension === "semantic") checks.push(semanticCheck(media, request.expectation));
				else if (dimension === "render") checks.push(await this.renderCheck(path, request.mediaType, media, request.signal));
				else if (dimension === "consistency") checks.push(await consistencyCheck(this.cwd, media, request.expectation, request.signal));
				else checks.push(check(dimension, "unavailable", [], `Local Artifact Verifier does not implement ${dimension}`));
			}
			return { observed: { locator: request.locator, mediaType: request.mediaType, byteLength: bytes.byteLength, sha256 }, checks };
		} finally { await media.pdf?.cleanup(); }
	}

	private async renderCheck(path: string, mediaType: string, media: InspectedMedia, signal?: AbortSignal): Promise<ArtifactVerificationCheck> {
		if (!media.valid) return check("render", "rejected", [], media.reason ?? "Artifact structure is invalid");
		if (mediaType === "application/pdf") {
			if (!media.pdf) return check("render", "unavailable", [], "PDF renderer was unavailable");
			try {
				const rendered = await inspectRenderedPdf(media.pdf, signal);
				return check("render", rendered.accepted ? "accepted" : "rejected", rendered.evidenceRefs, rendered.accepted ? undefined : "A rendered PDF page is blank");
			} catch (error) {
				return check("render", "unavailable", [], `PDF rendering failed: ${errorMessage(error)}`);
			}
		}
		if (!this.chromeExecutable) return check("render", "unavailable", [], "HTML render verification requires configured Chrome/Chromium");
		const tempRoot = await mkdtemp(join(tmpdir(), "beemax-html-render-"));
		const printablePdfPath = join(tempRoot, "render.pdf");
		let printable: InspectedMedia | undefined;
		try {
			if (!media.inertSource) return check("render", "rejected", [], "HTML could not be prepared as an inert document");
			const inertInputPath = join(tempRoot, "input.html");
			await writeFile(inertInputPath, media.inertSource, { signal });
			await runExecutable(this.chromeExecutable, [...inertChromeArguments(join(tempRoot, "profile")), "--no-pdf-header-footer", "--print-to-pdf-no-header", `--print-to-pdf=${printablePdfPath}`, pathToFileURL(inertInputPath).href], printablePdfPath, signal, 60_000);
			printable = await inspectPdf(await readFile(printablePdfPath, { signal }), signal);
			if (!printable.valid || !printable.pdf) return check("render", "rejected", [], printable.reason ?? "HTML printable render is invalid");
			const inputTokens = tokens(media.text);
			const outputTokens = new Set(tokens(printable.text));
			const retained = inputTokens.filter((token) => outputTokens.has(token)).length;
			const retainedRatio = inputTokens.length ? retained / inputTokens.length : 0;
			const rendered = await inspectRenderedPdf(printable.pdf, signal);
			const accepted = rendered.accepted && retainedRatio >= 0.9;
			return check("render", accepted ? "accepted" : "rejected", [
				`render:pdf-pages:${printable.pdf.numPages}`,
				`render:text-retained-ppm:${Math.round(retainedRatio * 1_000_000)}`,
				...rendered.evidenceRefs,
			], accepted ? undefined : retainedRatio < 0.9 ? "Printable HTML render did not retain enough source text" : "A printable HTML page is blank");
		} catch (error) {
			return check("render", "unavailable", [], `HTML rendering failed: ${errorMessage(error)}`);
		} finally { await printable?.pdf?.cleanup(); await rm(tempRoot, { recursive: true, force: true }); }
	}
}

interface InspectedMedia { valid: boolean; reason?: string; text: string; sourceText?: string; externalUrls?: readonly string[]; inertSource?: string; htmlRoot?: HtmlNode; pdf?: Awaited<ReturnType<typeof loadPdf>>; }

function inspectHtml(bytes: Buffer): InspectedMedia {
	const source = bytes.toString("utf8");
	if (!/<!doctype\s+html/i.test(source) || !/<html(?:\s|>)/i.test(source) || !/<body(?:\s|>)/i.test(source) || !/<\/body>/i.test(source)) {
		return { valid: false, reason: "HTML document is missing doctype/html/body structure", text: visibleHtmlText(source), sourceText: source };
	}
	try {
		const document = parse(source, { sourceCodeLocationInfo: true });
		const externalUrls = uniqueExternalCitationUrls(document);
		const unsafe = unsafeHtmlReason(document);
		if (unsafe) return { valid: false, reason: unsafe, text: visibleHtmlText(source), sourceText: source, externalUrls, htmlRoot: document };
		const normalized = serialize(document);
		const inertSource = normalized.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${INERT_DOCUMENT_CSP}">`);
		if (inertSource === normalized) return { valid: false, reason: "HTML document has no serializable head for navigation confinement", text: visibleHtmlText(source), sourceText: source, externalUrls };
		return { valid: true, text: visibleHtmlText(source), sourceText: source, externalUrls, inertSource, htmlRoot: document };
	} catch (error) {
		return { valid: false, reason: `HTML parser rejected the document: ${errorMessage(error)}`, text: visibleHtmlText(source), sourceText: source };
	}
}

function uniqueExternalCitationUrls(root: HtmlNode): readonly string[] {
	const urls = new Set<string>();
	const queue: HtmlNode[] = [root];
	while (queue.length) {
		const node = queue.shift()!;
		if ("tagName" in node && node.tagName.toLocaleLowerCase() === "a") {
			const href = node.attrs.find((attribute) => attribute.name.toLocaleLowerCase() === "href")?.value.trim();
			if (href) {
				try {
					const url = new URL(href);
					if (url.protocol === "http:" || url.protocol === "https:") {
						url.hash = "";
						urls.add(url.href);
					}
				} catch { /* Invalid hrefs are rejected separately by HTML integrity checks. */ }
			}
			if ("content" in node) queue.push(...node.content.childNodes);
		}
		if ("childNodes" in node) queue.push(...node.childNodes);
	}
	return Object.freeze([...urls].sort());
}

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

function unsafeHtmlReason(root: HtmlNode): string | undefined {
	const queue: HtmlNode[] = [root];
	while (queue.length) {
		const node = queue.shift()!;
		if ("tagName" in node) {
			const reason = unsafeHtmlElementReason(node);
			if (reason) return reason;
			if ("content" in node) queue.push(...node.content.childNodes);
		}
		if ("childNodes" in node) queue.push(...node.childNodes);
	}
	return undefined;
}

function unsafeHtmlElementReason(element: HtmlElement): string | undefined {
	const tag = element.tagName.toLocaleLowerCase();
	if (BLOCKED_HTML_ELEMENTS.has(tag) || tag === "foreignobject") return `HTML active content element <${tag}> is not permitted`;
	const attributes = new Map(element.attrs.map((attribute) => [attribute.name.toLocaleLowerCase(), attribute.value]));
	if (tag === "meta" && attributes.has("http-equiv")) return "HTML navigation or policy meta directives are not permitted";
	for (const [name, rawValue] of attributes) {
		if (/^on/i.test(name)) return `HTML event handler attribute ${name} is not permitted`;
		if (RESOURCE_ATTRIBUTES.has(name)) return `HTML external resource attribute ${name} is not permitted`;
		if (name === "src" || name === "srcset") {
			if (tag === "img" && name === "src" && isSafeDataImage(rawValue)) continue;
			return `HTML external resource attribute ${name} on <${tag}> is not permitted`;
		}
		if (name === "href" || name === "xlink:href") {
			if (rawValue.trim().startsWith("#")) continue;
			if (tag === "a" && isSafeCitationLink(rawValue)) continue;
			return `HTML external resource or navigation attribute ${name} on <${tag}> is not permitted`;
		}
		if (name === "style" && hasActiveCss(rawValue)) return "HTML style attribute contains an external resource or active CSS construct";
	}
	if (tag === "style") {
		const css = element.childNodes.filter((node): node is DefaultTreeAdapterMap["textNode"] => node.nodeName === "#text").map((node) => node.value).join("");
		if (hasActiveCss(css)) return "HTML style block contains an external resource or active CSS construct";
	}
	return undefined;
}

function isSafeDataImage(value: string): boolean {
	return /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i.test(value.trim());
}

function isSafeCitationLink(value: string): boolean {
	try {
		const url = new URL(value.trim());
		return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
	} catch { return false; }
}

function hasActiveCss(value: string): boolean {
	const normalized = value.replace(/\/\*[\s\S]*?\*\//g, "").toLocaleLowerCase();
	return /@import\b|url\s*\(|expression\s*\(|behavior\s*:|-moz-binding\s*:/.test(normalized);
}

async function inspectPdf(bytes: Buffer, signal?: AbortSignal): Promise<InspectedMedia> {
	if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return { valid: false, reason: "PDF magic header is missing", text: "" };
	try {
		const pdf = await loadPdf(bytes, signal);
		if (pdf.numPages < 1 || pdf.numPages > MAX_PDF_PAGES) return { valid: false, reason: `PDF page count ${pdf.numPages} is outside the supported range`, text: "", pdf };
		const text: string[] = [];
		const externalUrls = new Set<string>();
		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			throwIfAborted(signal);
			const page = await pdf.getPage(pageNumber);
			const content = await page.getTextContent();
			text.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
			for (const annotation of await page.getAnnotations()) {
				if (typeof annotation.url !== "string") continue;
				try {
					const url = new URL(annotation.url);
					if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) continue;
					url.hash = "";
					externalUrls.add(url.href);
				} catch { /* Ignore malformed PDF annotation targets. */ }
			}
		}
		return { valid: true, text: normalizeText(text.join("\n")), externalUrls: Object.freeze([...externalUrls].sort()), pdf };
	} catch (error) {
		return { valid: false, reason: `PDF parser rejected the file: ${errorMessage(error)}`, text: "" };
	}
}

async function loadPdf(bytes: Buffer, signal?: AbortSignal) {
	throwIfAborted(signal);
	const task = getDocument({ data: new Uint8Array(bytes) });
	if (signal) signal.addEventListener("abort", () => { void task.destroy(); }, { once: true });
	return await task.promise;
}

function semanticCheck(media: InspectedMedia, expectation: Readonly<ArtifactVerificationExpectation>): ArtifactVerificationCheck {
	const required = expectation.requiredText ?? [];
	const requiredSource = expectation.requiredSourceText ?? [];
	const requiredPairs = expectation.requiredSourceVisiblePairs ?? [];
	const expectsExternalUrls = expectation.minimumExternalUrls !== undefined || expectation.maximumExternalUrls !== undefined;
	if (!required.length && !requiredSource.length && !requiredPairs.length && expectation.minimumTextChars === undefined && !expectsExternalUrls) return check("semantic", "unavailable", [], "No semantic expectations were supplied");
	const normalized = normalizeText(media.text);
	const normalizedLower = normalized.toLocaleLowerCase();
	const compactLower = compactMachineText(normalized).toLocaleLowerCase();
	const missing = required.filter((value) => {
		const assertion = normalizeText(value).toLocaleLowerCase();
		if (normalizedLower.includes(assertion)) return false;
		// PDF text maps may put layout whitespace inside an otherwise contiguous
		// URL, digest, identifier, or numeric token. Compact only assertions that
		// contain no semantic whitespace; ordinary prose still requires exact word
		// boundaries and cannot pass by concatenation.
		return /\s/u.test(assertion) || !compactLower.includes(compactMachineText(assertion).toLocaleLowerCase());
	});
	const missingSource = requiredSource.filter((value) => media.sourceText === undefined || !media.sourceText.includes(value));
	const missingPairs = requiredPairs.filter((pair) => !htmlSourceVisiblePairMatches(media, pair, requiredPairs));
	const minimum = expectation.minimumTextChars ?? 0;
	const externalUrlCount = media.externalUrls?.length;
	const minimumExternalUrls = expectation.minimumExternalUrls ?? 0;
	const maximumExternalUrls = expectation.maximumExternalUrls ?? Number.MAX_SAFE_INTEGER;
	const externalUrlsAccepted = !expectsExternalUrls || (externalUrlCount !== undefined && externalUrlCount >= minimumExternalUrls && externalUrlCount <= maximumExternalUrls);
	const accepted = !missing.length && !missingSource.length && !missingPairs.length && normalized.length >= minimum && externalUrlsAccepted;
	const evidence = [`semantic:text-chars:${normalized.length}`, `semantic:required:${required.length}`, `semantic:matched:${required.length - missing.length}`, `semantic:source-required:${requiredSource.length}`, `semantic:source-matched:${requiredSource.length - missingSource.length}`, `semantic:source-visible-required:${requiredPairs.length}`, `semantic:source-visible-matched:${requiredPairs.length - missingPairs.length}`];
	if (externalUrlCount !== undefined) {
		evidence.push(`semantic:external-urls:${externalUrlCount}`);
		for (const url of media.externalUrls!.slice(0, 24)) evidence.push(`artifact:external-url:${url}`);
	}
	const issues = [
		!externalUrlsAccepted ? externalUrlCount === undefined ? "Artifact media does not expose external HTML citation URLs" : `external URL count ${externalUrlCount}; expected ${minimumExternalUrls}..${maximumExternalUrls}` : "",
		missing.length ? `missing visible assertions ${JSON.stringify(missing.slice(0, 10))}` : "",
		missingSource.length ? `${media.sourceText === undefined ? "source assertions unsupported" : "missing source assertions"} ${JSON.stringify(missingSource.slice(0, 10))}` : "",
		missingPairs.length ? `${media.htmlRoot === undefined ? "source-visible pairs unsupported" : "missing bound source-visible pairs"} ${JSON.stringify(missingPairs.slice(0, 10).map((pair) => `${pair.sourceText} -> ${pair.visibleText}`))}` : "",
		normalized.length < minimum ? `visible text length ${normalized.length}; expected at least ${minimum}` : "",
	].filter(Boolean).join("; ");
	return check("semantic", accepted ? "accepted" : "rejected", evidence, accepted ? undefined : issues || "Artifact semantic expectations were not satisfied");
}

async function consistencyCheck(cwd: string, output: InspectedMedia, expectation: Readonly<ArtifactVerificationExpectation>, signal?: AbortSignal): Promise<ArtifactVerificationCheck> {
	const source = expectation.consistentWith;
	if (!source) return check("consistency", "unavailable", [], "No consistency source was supplied");
	if (source.mediaType !== "text/html") return check("consistency", "unavailable", [], `Consistency source ${source.mediaType} is unsupported`);
	try {
		const path = await existingWorkspacePath(cwd, source.locator, MAX_INPUT_BYTES);
		const input = inspectHtml(await readFile(path, { signal }));
		if (!input.valid) return check("consistency", "rejected", [], input.reason ?? "Consistency source HTML is invalid");
		const inputTokens = tokens(input.text);
		const outputTokens = new Set(tokens(output.text));
		const retained = inputTokens.filter((token) => outputTokens.has(token)).length;
		const ratio = inputTokens.length ? retained / inputTokens.length : 0;
		const inputUrls = input.externalUrls ?? [];
		const outputUrls = output.externalUrls ?? [];
		const urlsMatch = inputUrls.length === outputUrls.length && inputUrls.every((url, index) => url === outputUrls[index]);
		const accepted = ratio >= 0.7 && urlsMatch;
		return check("consistency", accepted ? "accepted" : "rejected", [
			`consistency:source-tokens:${inputTokens.length}`,
			`consistency:retained-ppm:${Math.round(ratio * 1_000_000)}`,
			`consistency:source-external-urls:${inputUrls.length}`,
			`consistency:output-external-urls:${outputUrls.length}`,
			...(urlsMatch ? ["consistency:external-urls:exact"] : []),
		], accepted ? undefined : ratio < 0.7 ? "Rendered Artifact did not retain enough source text" : "Rendered Artifact external citation URLs differ from the source HTML");
	} catch (error) {
		return check("consistency", "unavailable", [], `Consistency comparison failed: ${errorMessage(error)}`);
	}
}

function htmlSourceVisiblePairMatches(media: InspectedMedia, pair: Readonly<{ sourceText: string; visibleText: string }>, allPairs: ReadonlyArray<Readonly<{ sourceText: string; visibleText: string }>>): boolean {
	if (!media.htmlRoot || !media.sourceText) return false;
	const expectedVisible = normalizeText(pair.visibleText).toLocaleLowerCase();
	const queue: HtmlNode[] = [media.htmlRoot];
	while (queue.length) {
		const node = queue.shift()!;
		if ("tagName" in node) {
			const location = (node as HtmlElement & { sourceCodeLocation?: { startTag?: { startOffset: number; endOffset: number } } }).sourceCodeLocation?.startTag;
			if (location) {
				const openingTag = media.sourceText.slice(location.startOffset, location.endOffset);
				const sourcePairHits = new Set(allPairs.filter((candidate) => openingTag.includes(candidate.sourceText)).map((candidate) => candidate.sourceText));
				if (sourcePairHits.size === 1 && sourcePairHits.has(pair.sourceText) && normalizeText(htmlNodeVisibleText(node)).toLocaleLowerCase().includes(expectedVisible)) return true;
			}
			if ("content" in node) queue.push(...node.content.childNodes);
		}
		if ("childNodes" in node) queue.push(...node.childNodes);
	}
	return false;
}

function htmlNodeVisibleText(root: HtmlNode): string {
	const values: string[] = [];
	const queue: HtmlNode[] = [root];
	while (queue.length) {
		const node = queue.shift()!;
		if (node.nodeName === "#text" && "value" in node) values.push(node.value);
		if ("tagName" in node && "content" in node) queue.push(...node.content.childNodes);
		if ("childNodes" in node) queue.push(...node.childNodes);
	}
	return values.join(" ");
}

async function inspectRenderedPdf(pdf: Awaited<ReturnType<typeof loadPdf>>, signal?: AbortSignal): Promise<{ accepted: boolean; evidenceRefs: string[] }> {
	const samples = samplePageNumbers(pdf.numPages);
	let minimumInkRatio = 1;
	for (const pageNumber of samples) {
		throwIfAborted(signal);
		const page = await pdf.getPage(pageNumber);
		const viewport = page.getViewport({ scale: 0.65 });
		const width = Math.max(1, Math.ceil(viewport.width));
		const height = Math.max(1, Math.ceil(viewport.height));
		const canvas = createCanvas(width, height);
		const context = canvas.getContext("2d");
		context.fillStyle = "white"; context.fillRect(0, 0, width, height);
		await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
		minimumInkRatio = Math.min(minimumInkRatio, inkRatio(context.getImageData(0, 0, width, height).data));
	}
	return {
		accepted: minimumInkRatio >= 0.0005,
		evidenceRefs: [`pdf:pages:${pdf.numPages}`, `render:samples:${samples.length}`, `render:min-ink-ppm:${Math.round(minimumInkRatio * 1_000_000)}`],
	};
}

function check(dimension: ArtifactVerificationDimension, status: ArtifactVerificationCheck["status"], evidenceRefs: string[], message?: string): ArtifactVerificationCheck {
	return Object.freeze({ dimension, status, evidenceRefs: Object.freeze(evidenceRefs), ...(message ? { message: message.slice(0, 1000) } : {}) });
}

async function existingWorkspacePath(cwd: string, locator: ArtifactLocator, maxBytes: number): Promise<string> {
	const candidate = workspacePath(cwd, locator);
	const [root, path] = await Promise.all([realpath(cwd), realpath(candidate)]);
	assertWithinWorkspace(root, path);
	const metadata = await stat(path);
	if (!metadata.isFile() || metadata.size > maxBytes) throw new Error("Artifact is not a bounded regular workspace file");
	return path;
}

async function writableWorkspacePath(cwd: string, locator: ArtifactLocator): Promise<string> {
	const candidate = workspacePath(cwd, locator);
	const [root, parent] = await Promise.all([realpath(cwd), realpath(dirname(candidate))]);
	assertWithinWorkspace(root, parent);
	const output = join(parent, basename(candidate));
	if (existsSync(output)) assertWithinWorkspace(root, await realpath(output));
	return output;
}

function workspacePath(cwd: string, locator: ArtifactLocator): string {
	if (locator.kind !== "workspace" || !locator.uri.startsWith("workspace:")) throw new Error("Local Artifact capability requires a workspace locator");
	const path = resolve(cwd, locator.uri.slice("workspace:".length));
	const rel = relative(cwd, path);
	if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Artifact path is outside the configured workspace");
	return path;
}

function assertWithinWorkspace(root: string, path: string): void {
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Artifact path resolves outside the configured workspace");
}

function chromeVersion(executable: string): string {
	try {
		const version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 16_384 }).trim();
		if (!version || version.length > 128) throw new Error("invalid version output");
		return version;
	} catch (error) { throw new Error(`Configured Chrome/Chromium is unhealthy: ${errorMessage(error)}`); }
}

function inertChromeArguments(profileRoot: string): string[] {
	return [
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-javascript",
		`--user-data-dir=${profileRoot}`,
	];
}

async function runExecutable(executable: string, args: string[], completionPath: string, signal: AbortSignal | undefined, timeout: number): Promise<void> {
	throwIfAborted(signal);
	const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr?.on("data", (chunk) => { if (stderr.length < 16_384) stderr += String(chunk).slice(0, 16_384 - stderr.length); });
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => child.once("exit", (code, childSignal) => resolveExit({ code, signal: childSignal })));
	const abort = () => { terminateChild(child); };
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const deadline = Date.now() + timeout;
		let stableSize = -1;
		let stableSamples = 0;
		let cleanExitAt: number | undefined;
		while (Date.now() < deadline) {
			throwIfAborted(signal);
			const earlyExit = await Promise.race([exited.then((value) => ({ value })), delay(100).then(() => undefined)]);
			let published = false;
			try {
				const metadata = await stat(completionPath);
				if (metadata.isFile() && metadata.size > 0) {
					published = true;
					stableSamples = metadata.size === stableSize ? stableSamples + 1 : 0;
					stableSize = metadata.size;
					if (stableSamples >= 4) return;
				}
			} catch { /* Artifact is not published yet. */ }
			if (earlyExit?.value.code === 0 && published) return;
			if (earlyExit?.value.code === 0) {
				cleanExitAt ??= Date.now();
				if (Date.now() - cleanExitAt < 10_000) continue;
			}
			if (earlyExit) throw new Error(`${basename(executable)} exited before publishing the Artifact (${earlyExit.value.code ?? earlyExit.value.signal ?? "unknown"})${stderr ? `: ${stderr.slice(0, 1000)}` : ""}`);
		}
		throw new Error(`${basename(executable)} timed out before publishing the Artifact${stderr ? `: ${stderr.slice(0, 1000)}` : ""}`);
	} finally {
		signal?.removeEventListener("abort", abort);
		terminateChild(child);
		await Promise.race([exited, delay(2_000)]);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}

function terminateChild(child: ChildProcess): void { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function visibleHtmlText(source: string): string {
	return normalizeText(source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'"));
}

function normalizeText(value: string): string {
	return value.normalize("NFKC")
		// Chrome's PDF text map can expose simplified Han glyphs as characters
		// from CJK Radicals Supplement. They are visually equivalent extraction
		// artifacts, but unlike Kangxi radicals Unicode NFKC does not fold them.
		.replace(/[⻓⻚⻛⻩]/gu, (glyph) => CJK_PDF_GLYPH_EQUIVALENTS[glyph]!)
		// Visually equivalent minus and dash glyphs are frequently substituted by
		// PDF fonts; normalize them before checking signed market values.
		.replace(/[−﹣－‐‑‒–—―]/gu, "-")
		// PDF text extraction commonly inserts layout whitespace between adjacent
		// Han glyph runs. That is not a content difference, so remove only
		// Han-to-Han whitespace before ordinary whitespace normalization.
		.replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, "$1")
		.replace(/\s+/g, " ")
		.trim();
}
function compactMachineText(value: string): string { return normalizeText(value).replace(/[\s\u00ad\u200b-\u200d\u2060\ufeff]+/gu, ""); }
const CJK_PDF_GLYPH_EQUIVALENTS: Readonly<Record<string, string>> = Object.freeze({ "⻓": "长", "⻚": "页", "⻛": "风", "⻩": "黄" });
function tokens(value: string): string[] { return [...new Set(normalizeText(value).toLocaleLowerCase().match(/[\p{L}\p{N}%.+-]{2,}/gu) ?? [])]; }
function samplePageNumbers(count: number): number[] { if (count <= MAX_RENDERED_PAGES) return Array.from({ length: count }, (_, index) => index + 1); return Array.from({ length: MAX_RENDERED_PAGES }, (_, index) => 1 + Math.round(index * (count - 1) / (MAX_RENDERED_PAGES - 1))); }
function inkRatio(data: Uint8ClampedArray): number { let ink = 0; for (let index = 0; index < data.length; index += 4) if (data[index + 3]! > 8 && (data[index]! < 248 || data[index + 1]! < 248 || data[index + 2]! < 248)) ink++; return ink / Math.max(1, data.length / 4); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new Error("Artifact operation was cancelled"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

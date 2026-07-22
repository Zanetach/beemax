import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";

export function runSubprocess(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const startedAt = performance.now();
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...(options.env ?? {}) },
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let killTimer;
		const terminate = () => {
			try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* already exited */ }
			killTimer = setTimeout(() => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ } }, 2_000);
			killTimer.unref?.();
		};
		options.signal?.addEventListener("abort", terminate, { once: true });
		if (options.signal?.aborted) terminate();
		const stdout = [];
		const stderr = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const maxBytes = Math.max(1_024, Math.min(Number(options.maxBytes ?? 10_000_000), 100_000_000));
		const collect = (target, chunk, current) => {
			const buffer = Buffer.from(chunk);
			const remaining = Math.max(0, maxBytes - current);
			if (remaining) target.push(buffer.subarray(0, remaining));
			return current + buffer.length;
		};
		child.stdout.on("data", (chunk) => { stdoutBytes = collect(stdout, chunk, stdoutBytes); });
		child.stderr.on("data", (chunk) => { stderrBytes = collect(stderr, chunk, stderrBytes); });
		child.once("error", (error) => { if (error?.code !== "ABORT_ERR") reject(error); });
		child.once("close", (code, signal) => {
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", terminate);
			resolve({
			exitCode: code ?? (signal ? 1 : 0),
			signal,
			durationMs: Math.max(0, performance.now() - startedAt),
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
			truncated: stdoutBytes > maxBytes || stderrBytes > maxBytes,
			});
		});
	});
}

export async function startFixtureAuthorityServer({ serverPath, workspace, signal }) {
	if (signal?.aborted) throw signal.reason ?? new Error("Fixture MCP startup aborted");
	const [{ createAgentParityFixtureServer }, { StreamableHTTPServerTransport }, { createMcpExpressApp }] = await Promise.all([
		import(pathToFileURL(resolve(serverPath)).href),
		import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
		import("@modelcontextprotocol/sdk/server/express.js"),
	]);
	const server = createAgentParityFixtureServer({ root: workspace.authorityDir, workspace: workspace.cwd, receiptKey: workspace.receiptKey });
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
	await server.connect(transport);
	const app = createMcpExpressApp({ host: "127.0.0.1" });
	app.post("/mcp", (request, response) => transport.handleRequest(request, response, request.body));
	app.get("/mcp", (request, response) => transport.handleRequest(request, response));
	app.delete("/mcp", (request, response) => transport.handleRequest(request, response));
	const listener = await new Promise((resolvePromise, reject) => {
		const value = app.listen(0, "127.0.0.1", () => resolvePromise(value));
		value.once("error", reject);
	});
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("Fixture MCP did not bind a TCP port");
	let disposed = false;
	const dispose = async () => {
		if (disposed) return;
		disposed = true;
		await transport.close().catch(() => {});
		await new Promise((done) => listener.close(done));
	};
	const abort = () => { void dispose(); };
	signal?.addEventListener("abort", abort, { once: true });
	return { url: `http://127.0.0.1:${address.port}/mcp`, dispose: async () => { signal?.removeEventListener("abort", abort); await dispose(); } };
}

export function parityPrompt(scenario) {
	return [
		scenario.prompt,
		`Evaluation case identifier: ${scenario.id}`,
		"文件和变更操作仅限本次隔离评测目录与本地 fixture；禁止修改、投递或调用真实外部业务系统。任务需要公开来源时，可以使用已配置的只读网络 Provider。能力缺失时报告准确阻塞，不得降低目标。",
	].join("\n\n");
}

export async function isolatedEvaluationWorkspace(fixtureRoot, prefix) {
	const cwd = await mkdtemp(join(tmpdir(), prefix));
	const authorityDir = await mkdtemp(join(tmpdir(), `${prefix}authority-`));
	const receiptKey = randomBytes(32).toString("hex");
	if (fixtureRoot) await cp(resolve(fixtureRoot), cwd, { recursive: true });
	return { cwd, authorityDir, receiptKey, dispose: async () => { await rm(cwd, { recursive: true, force: true }); await rm(authorityDir, { recursive: true, force: true }); } };
}

export async function collectFixtureEvidence(root, authorityDir, receiptKey) {
	const refs = [];
	const kinds = new Set();
	const facts = {};
	for (const name of ["draft.md", "report.md"]) {
		try {
			const bytes = await readFile(resolve(root, name));
			const text = bytes.toString("utf8");
			if (name === "draft.md") facts.draftExists = text.trim().length > 0;
			if (name === "report.md") facts.reportContainsBothSources = text.includes("SOURCE-A-ROUTING") && text.includes("SOURCE-B-VERIFY");
			kinds.add("artifact"); kinds.add("filesystem");
			refs.push({ kind: "validated_artifact", name, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
		} catch (error) { if (error?.code !== "ENOENT") throw error; }
	}
	let authorityEvents = [];
	try { authorityEvents = (await readFile(resolve(authorityDir, "fixture-authority.jsonl"), "utf8")).split(/\r?\n/).flatMap((line) => {
		if (!line) return [];
		let event; try { event = JSON.parse(line); } catch { throw new Error("Fixture authority contains malformed JSON"); }
		if (!verifyFixtureAuthorityEvent(event, receiptKey)) throw new Error("Fixture authority contains an unauthenticated event");
		const { mac: _mac, ...payload } = event;
		return [payload];
	}); }
	catch (error) { if (error?.code !== "ENOENT") throw error; }
	for (const event of authorityEvents) {
		if (event.kind === "source_read") kinds.add("source");
		if (event.kind === "skill_activated") kinds.add("skill");
		if (event.kind === "scope_checked") kinds.add("scope");
		if (event.kind === "artifact_inspected") kinds.add("artifact");
		if (event.kind === "effect_committed" || event.kind === "effect_reconciled") kinds.add("effect");
		if (event.kind === "checkpoint_saved") kinds.add("checkpoint");
		if (event.kind === "delivery_committed") kinds.add("delivery");
		refs.push({ kind: "fixture_authority", id: event.id, eventKind: event.kind, sha256: `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}` });
	}
	const effectCommits = authorityEvents.filter((event) => event.kind === "effect_committed");
	const effectEvents = authorityEvents.filter((event) => ["effect_attempted", "effect_committed", "effect_reconciled"].includes(event.kind));
	const duplicateEffects = effectEvents.length ? effectCommits.length - new Set(effectCommits.map((event) => event.idempotencyKey)).size : null;
	facts.effectAttemptCount = authorityEvents.filter((event) => event.kind === "effect_attempted").length;
	facts.effectCommitCount = effectCommits.length;
	facts.effectReconcileCount = authorityEvents.filter((event) => event.kind === "effect_reconciled").length;
	if (authorityEvents.some((event) => event.kind === "scope_checked")) facts.profileIsolationVerified = authorityEvents.some((event) => event.kind === "scope_checked" && event.id === "PROFILE-TARGET-ISOLATED" && event.foreignRecordPresent === true && event.foreignRecordReturned === false);
	facts.authorityIds = authorityEvents.map((event) => event.id);
	return { kinds: [...kinds], refs, facts, duplicateEffects };
}

export function signFixtureAuthorityEvent(event, receiptKey) {
	if (typeof receiptKey !== "string" || receiptKey.length < 32) throw new Error("Fixture receipt key is missing");
	const payload = JSON.stringify(event);
	return { ...event, mac: createHmac("sha256", receiptKey).update(payload).digest("hex") };
}

function verifyFixtureAuthorityEvent(event, receiptKey) {
	if (!event || typeof event !== "object" || typeof event.mac !== "string") return false;
	const { mac, ...payload } = event;
	const expected = createHmac("sha256", receiptKey).update(JSON.stringify(payload)).digest();
	let observed; try { observed = Buffer.from(mac, "hex"); } catch { return false; }
	return observed.length === expected.length && timingSafeEqual(observed, expected);
}

export async function digestConfiguration(paths, identity = {}) {
	const hash = createHash("sha256");
	for (const path of [...paths].map((value) => resolve(value)).sort()) {
		hash.update(path.split("/").at(-1) ?? path); hash.update("\0");
		try { hash.update(await readFile(path)); }
		catch (error) { if (error?.code === "ENOENT") hash.update("<missing>"); else throw error; }
		hash.update("\0");
	}
	hash.update(JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([left], [right]) => left.localeCompare(right)))));
	return `sha256:${hash.digest("hex")}`;
}

export async function digestTree(root) {
	const hash = createHash("sha256");
	async function visit(directory, prefix = "") {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await visit(resolve(directory, entry.name), relative);
			else if (entry.isFile()) { hash.update(relative); hash.update("\0"); hash.update(await readFile(resolve(directory, entry.name))); hash.update("\0"); }
		}
	}
	await visit(resolve(root));
	return `sha256:${hash.digest("hex")}`;
}

export async function validatePublicSources(value, minimum, signal) {
	if (!minimum) return [];
	const candidates = publicUrls(value).filter((url) => isPublicHttpUrl(url)).slice(0, 12);
	const accepted = [];
	const domains = new Set();
	for (const url of candidates) {
		if (signal?.aborted) break;
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(new Error("Public source validation timed out")), 10_000);
		try {
			const { response, finalUrl } = await fetchValidatedPublicUrl(url, controller.signal);
			const domain = registrableDomain(new URL(finalUrl).hostname);
			if (response.ok && isPublicHttpUrl(finalUrl) && !domains.has(domain)) { accepted.push(normalizedPublicUrl(url)); domains.add(domain); }
			await response.body?.cancel().catch(() => {});
		} catch { /* inaccessible or non-public output is not source evidence */ }
		finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
		if (domains.size >= minimum) break;
	}
	return accepted;
}

async function fetchValidatedPublicUrl(initialUrl, signal) {
	let current = normalizedPublicUrl(initialUrl);
	for (let redirect = 0; redirect <= 5; redirect++) {
		if (!isPublicHttpUrl(current)) throw new Error("Public source URL is not allowed");
		const host = new URL(current).hostname;
		const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveValidatedPublicAddresses(host, { signal });
		if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) throw new Error("Public source resolves to a non-public address");
		const selected = addresses[0];
		const family = selected.family ?? isIP(selected.address);
		const dispatcher = new Agent({ connect: { lookup: (_hostname, lookupOptions, callback) => lookupOptions?.all ? callback(null, [{ address: selected.address, family }]) : callback(null, selected.address, family) } });
		let response;
		try {
			response = await undiciFetch(current, { dispatcher, redirect: "manual", signal, headers: { "user-agent": "Thruvera-Agent-Parity/1.0" } });
			await response.body?.cancel().catch(() => {});
		}
		finally { await dispatcher.close(); }
		if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current };
		const location = response.headers.get("location");
		if (!location || redirect === 5) throw new Error("Public source redirect chain is invalid");
		current = normalizedPublicUrl(new URL(location, current).toString());
	}
	throw new Error("Public source redirect chain is too long");
}

export async function resolveValidatedPublicAddresses(host, options = {}) {
	const systemLookup = options.lookup ?? lookup;
	const systemAddresses = await systemLookup(host, { all: true, verbatim: true });
	if (systemAddresses.length && systemAddresses.every(({ address }) => isPublicIpAddress(address))) return systemAddresses;

	const dohFetch = options.fetch ?? undiciFetch;
	const endpoint = new URL("https://cloudflare-dns.com/dns-query");
	endpoint.searchParams.set("name", host);
	endpoint.searchParams.set("type", "A");
	const response = await dohFetch(endpoint, {
		signal: options.signal,
		headers: { accept: "application/dns-json", "user-agent": "Thruvera-Agent-Parity/1.0" },
	});
	if (!response.ok) throw new Error(`Public DNS fallback failed with HTTP ${response.status}`);
	const payload = await response.json();
	if (payload?.Status !== 0) throw new Error("Public DNS fallback returned an unsuccessful status");
	const addresses = (Array.isArray(payload.Answer) ? payload.Answer : [])
		.filter((answer) => answer?.type === 1 && isIP(answer?.data) === 4)
		.map((answer) => ({ address: answer.data, family: 4 }));
	if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) throw new Error("Public source resolves to a non-public address");
	return addresses;
}

function registrableDomain(hostname) {
	const parts = String(hostname).toLocaleLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
	if (parts.length <= 2) return parts.join(".");
	const suffix = parts.slice(-2).join(".");
	const commonSecondLevelSuffixes = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.cn", "net.cn", "org.cn", "gov.cn", "com.au", "net.au", "org.au", "co.jp", "co.kr", "co.nz", "com.br", "com.sg", "com.hk"]);
	return parts.slice(commonSecondLevelSuffixes.has(suffix) ? -3 : -2).join(".");
}

function publicUrls(value) {
	const urls = new Set();
	for (const match of String(value ?? "").matchAll(/https?:\/\/[^\s<>"'\\]+/gi)) {
		try { urls.add(normalizedPublicUrl(match[0].replace(/[),.;]+$/, ""))); } catch { /* malformed */ }
	}
	return [...urls];
}

function normalizedPublicUrl(value) {
	const url = new URL(value); url.username = ""; url.password = ""; url.hash = ""; return url.toString();
}

function isPublicHttpUrl(value) {
	try {
		const url = new URL(value);
		if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
		const host = url.hostname.toLocaleLowerCase();
		if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
		if (!isIP(host)) return host.includes(".");
		return isPublicIpAddress(host);
	} catch { return false; }
}

function isPublicIpAddress(address) {
	const normalized = String(address).toLocaleLowerCase();
	if (!isIP(normalized)) return false;
	if (isIP(normalized) === 6) {
		if (normalized.startsWith("::ffff:")) return isPublicIpAddress(normalized.slice(7));
		return !(normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff") || normalized.startsWith("2001:db8:"));
	}
	const parts = normalized.split(".").map(Number);
	return !(parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && (parts[1] === 0 || parts[1] === 168)) || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) || parts[0] >= 224);
}

import qrcode from "qrcode-terminal";

const REGISTRATION_PATH = "/oauth/v1/app/registration";
const ACCOUNTS_URL = { feishu: "https://accounts.feishu.cn", lark: "https://accounts.larksuite.com" } as const;

export interface FeishuRegistrationResult {
	appId: string;
	appSecret: string;
	domain: "feishu" | "lark";
	openId?: string;
}

export interface FeishuRegistrationOptions {
	initialDomain?: "feishu" | "lark";
	timeoutMs?: number;
	fetch?: typeof fetch;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	showQr?: (url: string) => Promise<void> | void;
	log?: (message: string) => void;
}

/** Feishu/Lark device-code scan-to-create onboarding protocol. */
export async function registerFeishuBot(options: FeishuRegistrationOptions = {}): Promise<FeishuRegistrationResult | undefined> {
	const request = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const log = options.log ?? console.log;
	const initialDomain = options.initialDomain ?? "feishu";
	const post = (domain: "feishu" | "lark", body: Record<string, string>) => postRegistration(request, ACCOUNTS_URL[domain], body);
	const initialized = await post(initialDomain, { action: "init" });
	if (!stringArray(initialized.supported_auth_methods).includes("client_secret")) throw new Error("Feishu registration does not support client_secret authentication");
	const begun = await post(initialDomain, { action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id" });
	const deviceCode = stringValue(begun.device_code);
	const verificationUrl = stringValue(begun.verification_uri_complete);
	if (!deviceCode || !verificationUrl) throw new Error("Feishu registration did not return a device code and verification URL");
	const qrUrl = appendTracking(verificationUrl);
	if (options.showQr) await options.showQr(qrUrl); else await renderQr(qrUrl, log);
	let intervalMs = Math.max(1_000, numberValue(begun.interval, 5) * 1_000);
	const serverTimeoutMs = numberValue(begun.expire_in, 600) * 1_000;
	const deadline = now() + Math.min(options.timeoutMs ?? 600_000, serverTimeoutMs);
	let domain = initialDomain;
	let switched = false;
	let consecutiveFailures = 0;
	while (now() < deadline) {
		let response: Record<string, unknown>;
		try {
			response = await post(domain, { action: "poll", device_code: deviceCode, tp: "ob_app" });
			consecutiveFailures = 0;
		} catch (error) {
			consecutiveFailures++;
			if (error instanceof RegistrationHttpError && error.status === 429) intervalMs = Math.max(intervalMs + 5_000, error.retryAfterMs);
			const retryable = error instanceof TypeError || (error instanceof RegistrationHttpError && (error.status === 429 || error.status >= 500));
			if (consecutiveFailures >= 3 || !retryable) throw error;
			log(`WARN  Feishu registration poll failed; retrying (${consecutiveFailures}/3).`);
			await sleep(intervalMs);
			continue;
		}
		const user = recordValue(response.user_info);
		if (!switched && user.tenant_brand === "lark") { domain = "lark"; switched = true; }
		const appId = stringValue(response.client_id);
		const appSecret = stringValue(response.client_secret);
		if (appId && appSecret) return { appId, appSecret, domain, openId: stringValue(user.open_id) || undefined };
		if (response.error === "access_denied" || response.error === "expired_token") return undefined;
		if (response.error === "slow_down") intervalMs += 5_000;
		await sleep(intervalMs);
	}
	return undefined;
}

async function postRegistration(request: typeof fetch, baseUrl: string, body: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await request(`${baseUrl}${REGISTRATION_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
		signal: AbortSignal.timeout(10_000),
	});
	const responseText = await response.text();
	let parsed: unknown;
	try { parsed = JSON.parse(responseText); }
	catch {
		if (response.status >= 500) throw new RegistrationHttpError(response.status, 0);
		throw new Error("Feishu registration returned an invalid response");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Feishu registration returned an invalid response");
	const parsedBody = parsed as Record<string, unknown>;
	const expectedPollState = ["authorization_pending", "slow_down", "access_denied", "expired_token"].includes(stringValue(parsedBody.error));
	if (!response.ok && !expectedPollState) {
		const retryAfter = Number(response.headers.get("retry-after") ?? 0);
		throw new RegistrationHttpError(response.status, Number.isFinite(retryAfter) ? retryAfter * 1_000 : 0);
	}
	return parsedBody;
}

function renderQr(url: string, log: (message: string) => void): Promise<void> {
	return new Promise((resolve) => qrcode.generate(url, { small: true }, (value) => {
		log(`\n${value}\nScan this one-time QR code with Feishu/Lark. It expires shortly; do not share terminal output.\n`);
		resolve();
	}));
}

function appendTracking(url: string): string { return `${url}${url.includes("?") ? "&" : "?"}from=beemax&tp=beemax`; }
function recordValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function numberValue(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback; }

class RegistrationHttpError extends Error {
	readonly status: number;
	readonly retryAfterMs: number;
	constructor(status: number, retryAfterMs: number) {
		super(`Feishu registration HTTP ${status}`);
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

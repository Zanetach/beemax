const TRANSIENT_FEISHU_CODES = new Set([230020, 99991400, 99991401, 99991402]);

export interface FeishuRetryOptions {
	attempts?: number;
	baseDelayMs?: number;
	retryAllErrors?: boolean;
	onRetry?: () => void | Promise<void>;
	sleep?: (delayMs: number) => Promise<void>;
}

/** Retry a Feishu SDK operation without retrying permanent HTTP failures. */
export async function retryFeishuOperation<T>(
	operation: () => Promise<T>,
	options: FeishuRetryOptions = {},
): Promise<T> {
	const attempts = Math.max(1, Math.trunc(options.attempts ?? 3));
	const baseDelayMs = Math.max(0, options.baseDelayMs ?? 1_000);
	const sleep = options.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const response = await operation();
			if (!isTransientResponse(response) || attempt === attempts - 1) return response;
			await options.onRetry?.();
			await sleep(retryDelayMs(response, baseDelayMs, attempt));
		} catch (error) {
			if (attempt === attempts - 1 || isRetryCancelled(error) || (!options.retryAllErrors && !isTransientError(error))) throw error;
			await options.onRetry?.();
			await sleep(retryDelayMs(error, baseDelayMs, attempt));
		}
	}
	throw new Error("Feishu retry loop exhausted unexpectedly");
}

function isTransientResponse(response: unknown): boolean {
	if (!response || typeof response !== "object") return false;
	const code = (response as { code?: unknown }).code;
	return typeof code === "number" && TRANSIENT_FEISHU_CODES.has(code);
}

function isTransientError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const record = error as Record<string, unknown>;
	const response = record.response && typeof record.response === "object" ? record.response as Record<string, unknown> : undefined;
	const status = numberValue(response?.status ?? record.status ?? record.statusCode);
	if (status !== undefined) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
	const code = String(record.code ?? "");
	if (/^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_)/.test(code)) return true;
	const message = String(record.message ?? "");
	if (/socket hang up|network error|fetch failed|timed? ?out|connection (?:reset|closed)/i.test(message)) return true;
	return record.cause ? isTransientError(record.cause) : false;
}

function retryDelayMs(error: unknown, baseDelayMs: number, attempt: number): number {
	const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
	const response = record?.response && typeof record.response === "object" ? record.response as Record<string, unknown> : undefined;
	const headersValue = response?.headers ?? record?.headers;
	const headers = headersValue && typeof headersValue === "object" ? headersValue as Record<string, unknown> & { get?: (name: string) => unknown } : undefined;
	const retryAfter = headers?.get?.("retry-after") ?? headers?.["retry-after"] ?? headers?.["Retry-After"];
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000);
	if (typeof retryAfter === "string") {
		const date = Date.parse(retryAfter);
		if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
	}
	return Math.min(30_000, baseDelayMs * (2 ** attempt));
}

function isRetryCancelled(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "THRUVERA_CONNECTION_CANCELLED");
}

function numberValue(value: unknown): number | undefined {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

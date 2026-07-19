const CREDENTIAL_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
	/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i,
	/["']?(?:(?:[A-Z0-9]{1,32}_){0,4}(?:password|passcode|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|cookie))["']?\s*[:=]\s*["']?\S+/i,
	/(?:密码|口令|密钥|令牌|访问令牌|刷新令牌)\s*[:：=]\s*\S+/i,
	/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
	/https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

/** Detect secret-bearing material that must not enter durable Agent state. */
export function containsCredentialMaterial(value: string): boolean {
	return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

export function assertNoCredentialMaterial(value: string, destination: string): void {
	if (containsCredentialMaterial(value)) throw new Error(`${destination} contains credential-like sensitive material`);
}

export function redactCredentialMaterial(value: string, replacement = "[credential details redacted]"): string {
	return containsCredentialMaterial(value) ? replacement : value;
}

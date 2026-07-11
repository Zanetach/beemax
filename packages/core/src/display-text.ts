/** Bounds untrusted display text and removes terminal control sequences. */
export function sanitizeDisplayText(value: string, limit: number): string {
	const safe = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
	return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
}

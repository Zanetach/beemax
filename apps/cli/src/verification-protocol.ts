import { createHash } from "node:crypto";

export interface SuccessfulVerificationReceipt {
	callId: string;
	toolName: string;
	reference: string;
	argumentsSha256: string;
	resultSha256: string;
}

export interface VerificationSubmission {
	status?: unknown;
	reason?: unknown;
	assertions?: unknown;
}

const NON_EVIDENCE_TOOLS = new Set(["verification_submit", "capability_discover", "task_checkpoint_save"]);

/** Create a content-free durable identity only for a successful material evidence result. */
export function createSuccessfulVerificationReceipt(input: { executionId: string; callId: string; toolName: string; args: unknown; result: unknown }): SuccessfulVerificationReceipt | undefined {
	if (NON_EVIDENCE_TOOLS.has(input.toolName) || input.toolName.startsWith("skill_") || !hasMaterialResult(input.result)) return undefined;
	return {
		callId: input.callId,
		toolName: input.toolName,
		reference: `execution:${input.executionId}:tool-call:${input.callId}`,
		argumentsSha256: digest(input.args),
		resultSha256: digest(input.result),
	};
}

/** Resolve only an exact receipt id or an unambiguous exact Tool-name shorthand. */
export function normalizeVerifierEvidenceRefs(value: string, successfulReceipts: ReadonlyMap<string, SuccessfulVerificationReceipt>): string[] {
	const normalized = value.trim();
	if (normalized.startsWith("tool-call:") && successfulReceipts.has(normalized.slice("tool-call:".length))) return [normalized];
	const toolName = normalized.startsWith("tool:") ? normalized.slice("tool:".length) : normalized;
	return [...successfulReceipts.values()].filter((receipt) => receipt.toolName === toolName).map((receipt) => `tool-call:${receipt.callId}`);
}

export function parseVerifierSubmission(value: unknown): VerificationSubmission {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("verifier submitted an invalid structured verdict");
	return value as VerificationSubmission;
}

function hasMaterialResult(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const record = value as { content?: unknown; details?: unknown };
	if (Array.isArray(record.content) && record.content.some((item) => item && typeof item === "object" && (
		typeof (item as { text?: unknown }).text === "string" && Boolean((item as { text: string }).text.trim())
		|| typeof (item as { data?: unknown }).data === "string" && Boolean((item as { data: string }).data)
	))) return true;
	return Boolean(record.details && typeof record.details === "object" && Object.keys(record.details as object).length);
}

function digest(value: unknown): string {
	let serialized: string;
	try { serialized = JSON.stringify(value) ?? "undefined"; }
	catch { serialized = "[unserializable]"; }
	return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

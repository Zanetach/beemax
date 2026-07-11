import { sessionKeyForSource } from "./session-coordinator.ts";
import type { BeeMaxRuntimeSource } from "./runtime.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SENSITIVE_KEY_RE = /(token|secret|password|api[_-]?key|authorization|cookie|credential)/i;

export interface ToolApprovalRequest { source: BeeMaxRuntimeSource; toolName: string; args: unknown; }
export interface ToolApprovalDecision { allowed: boolean; reason?: string; }
export type ApprovalPromptSender = (source: BeeMaxRuntimeSource, text: string) => Promise<void>;
export type ApprovalAuditSink = (event: { source: BeeMaxRuntimeSource; toolName: string; allowed: boolean; reason?: string }) => void;
export type ToolApprovalEvent =
	| { type: "requested"; source: BeeMaxRuntimeSource; toolName: string }
	| { type: "resolved"; source: BeeMaxRuntimeSource; toolName: string; allowed: boolean; reason?: string };

interface PendingApproval {
	source: BeeMaxRuntimeSource;
	toolName: string;
	resolve: (decision: ToolApprovalDecision) => void;
	timer: ReturnType<typeof setTimeout>;
	abortCleanup?: () => void;
}

/** Core-owned approval policy; channels only deliver prompts and forward replies. */
export class ToolApprovalBroker {
	private readonly pending = new Map<string, PendingApproval>();
	private readonly sessionGrants = new Set<string>();
	private readonly sendPrompt: ApprovalPromptSender;
	private readonly timeoutMs: number;
	private readonly audit?: ApprovalAuditSink;
	private readonly listeners = new Set<(event: ToolApprovalEvent) => void>();

	constructor(sendPrompt: ApprovalPromptSender, timeoutMs = DEFAULT_TIMEOUT_MS, audit?: ApprovalAuditSink) {
		this.sendPrompt = sendPrompt;
		this.timeoutMs = timeoutMs;
		this.audit = audit;
	}

	async authorize(request: ToolApprovalRequest, signal?: AbortSignal): Promise<ToolApprovalDecision> {
		if (signal?.aborted) return { allowed: false, reason: "Tool approval cancelled" };
		const sourceKey = sessionKeyForSource(request.source);
		const grantKey = `${sourceKey}:${request.toolName}`;
		if (this.sessionGrants.has(grantKey)) {
			this.audit?.({ source: request.source, toolName: request.toolName, allowed: true, reason: "session grant" });
			return { allowed: true };
		}
		if (this.pending.has(sourceKey)) return { allowed: false, reason: "Another tool approval is already pending for this conversation" };

		let settle!: (decision: ToolApprovalDecision) => void;
		const decision = new Promise<ToolApprovalDecision>((resolve) => { settle = resolve; });
		const timer = setTimeout(() => this.finish(sourceKey, { allowed: false, reason: "Tool approval timed out" }), this.timeoutMs);
		const pending: PendingApproval = { source: request.source, toolName: request.toolName, resolve: settle, timer };
		if (signal) {
			const abort = () => this.finish(sourceKey, { allowed: false, reason: "Tool approval cancelled" });
			signal.addEventListener("abort", abort, { once: true });
			pending.abortCleanup = () => signal.removeEventListener("abort", abort);
		}
		this.pending.set(sourceKey, pending);
		this.emit({ type: "requested", source: request.source, toolName: request.toolName });
		try { await this.sendPrompt(request.source, renderApprovalPrompt(request)); }
		catch (error) { this.finish(sourceKey, { allowed: false, reason: `Could not deliver approval request: ${error instanceof Error ? error.message : String(error)}` }); }
		return decision;
	}

	/** Subscribe to lifecycle notifications without giving a presenter policy control. */
	subscribe(listener: (event: ToolApprovalEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Returns true when text belongs to a pending approval for this conversation. */
	async handleReply(source: BeeMaxRuntimeSource, text: string): Promise<boolean> {
		const sourceKey = sessionKeyForSource(source);
		const pending = this.pending.get(sourceKey);
		if (!pending) return false;
		const choice = parseChoice(text);
		if (!choice) {
			await this.sendPrompt(source, "存在待审批工具调用。请回复：1（允许一次）、2（本会话允许）或 3（拒绝）。");
			return true;
		}
		if (choice === "session") {
			this.sessionGrants.add(`${sourceKey}:${pending.toolName}`);
			this.finish(sourceKey, { allowed: true });
			await this.sendPrompt(source, `已允许本会话继续使用工具 \`${pending.toolName}\`。`);
		} else if (choice === "once") {
			this.finish(sourceKey, { allowed: true });
			await this.sendPrompt(source, `已允许本次工具调用 \`${pending.toolName}\`。`);
		} else {
			this.finish(sourceKey, { allowed: false, reason: "User denied the tool call" });
			await this.sendPrompt(source, `已拒绝工具调用 \`${pending.toolName}\`。`);
		}
		return true;
	}

	/** Cancel a pending approval when its owning interaction is cancelled. */
	cancel(source: BeeMaxRuntimeSource, reason = "Tool approval cancelled"): boolean {
		const key = sessionKeyForSource(source);
		if (!this.pending.has(key)) return false;
		this.finish(key, { allowed: false, reason });
		return true;
	}

	dispose(reason = "Approval broker is shutting down"): void {
		for (const key of [...this.pending.keys()]) this.finish(key, { allowed: false, reason });
		this.sessionGrants.clear();
	}

	private finish(sourceKey: string, decision: ToolApprovalDecision): void {
		const pending = this.pending.get(sourceKey);
		if (!pending) return;
		this.pending.delete(sourceKey);
		clearTimeout(pending.timer);
		pending.abortCleanup?.();
		pending.resolve(decision);
		this.audit?.({ source: pending.source, toolName: pending.toolName, ...decision });
		this.emit({ type: "resolved", source: pending.source, toolName: pending.toolName, ...decision });
	}

	private emit(event: ToolApprovalEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

function parseChoice(text: string): "once" | "session" | "deny" | undefined {
	const choice = text.trim().toLowerCase();
	if (["1", "允许", "允许一次", "allow", "allow once", "yes", "y"].includes(choice)) return "once";
	if (["2", "本会话允许", "会话允许", "allow session", "always this session"].includes(choice)) return "session";
	if (["3", "拒绝", "deny", "no", "n"].includes(choice)) return "deny";
	return undefined;
}

function renderApprovalPrompt(request: ToolApprovalRequest): string {
	return ["⚠️ 工具调用需要审批", `工具：\`${request.toolName}\``, "参数：", "```json", formatArgs(request.args), "```", "请回复：", "1 — 允许一次", "2 — 本会话允许此工具", "3 — 拒绝"].join("\n");
}

function formatArgs(args: unknown): string {
	let rendered: string;
	try { rendered = JSON.stringify(redact(args), null, 2); } catch { rendered = String(args); }
	return rendered.length > 1600 ? `${rendered.slice(0, 1600)}\n…[truncated]` : rendered;
}

function redact(value: unknown, key = ""): unknown {
	if (SENSITIVE_KEY_RE.test(key)) return "[REDACTED]";
	if (Array.isArray(value)) return value.map((item) => redact(item));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
	return value;
}

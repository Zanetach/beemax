import { sessionKeyForSource } from "./session-coordinator.ts";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { MUTATING_TOOL_POLICY, type ToolPolicy } from "./tool-runtime.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SENSITIVE_KEY_RE = /(token|secret|password|api[_-]?key|authorization|cookie|credential)/i;

export interface ToolApprovalRequest { source: BeeMaxRuntimeSource; toolName: string; args: unknown; policy?: ToolPolicy; }
/** Redacted, presenter-safe context for an approval card or overlay. */
export interface ToolApprovalDetails {
	target: string;
	risk: "低" | "中" | "高";
	impact: string;
	reversibility: string;
	argsSummary: string;
}
export interface ToolApprovalDecision { allowed: boolean; reason?: string; }
export type ToolApprovalChoice = "once" | "task" | "session" | "deny";
export interface TaskExecutionGrantSnapshot {
	taskId: string;
	allowedCapabilities: string[];
	status: "active";
}
export type ApprovalPromptSender = (source: BeeMaxRuntimeSource, text: string) => Promise<void>;
export type ApprovalAuditSink = (event: { source: BeeMaxRuntimeSource; toolName: string; allowed: boolean; reason?: string }) => void;
export type ToolApprovalEvent =
	| { type: "requested"; source: BeeMaxRuntimeSource; toolName: string; details: ToolApprovalDetails }
	| { type: "resolved"; source: BeeMaxRuntimeSource; toolName: string; allowed: boolean; reason?: string };

interface PendingApproval {
	source: BeeMaxRuntimeSource;
	toolName: string;
	resolve: (decision: ToolApprovalDecision) => void;
	timer: ReturnType<typeof setTimeout>;
	abortCleanup?: () => void;
}

interface TaskExecutionGrant {
	taskId: string;
	allowedCapabilities: Set<string>;
}

/** Core-owned approval policy; channels only deliver prompts and forward replies. */
export class ToolApprovalBroker {
	private readonly pending = new Map<string, PendingApproval>();
	private readonly taskGrants = new Map<string, TaskExecutionGrant>();
	private readonly sendPrompt: ApprovalPromptSender;
	private readonly timeoutMs: number;
	private readonly audit?: ApprovalAuditSink;
	private readonly listeners = new Set<(event: ToolApprovalEvent) => void>();

	constructor(sendPrompt: ApprovalPromptSender, timeoutMs = DEFAULT_TIMEOUT_MS, audit?: ApprovalAuditSink) {
		this.sendPrompt = sendPrompt;
		this.timeoutMs = timeoutMs;
		this.audit = audit;
	}

	/** Start a fresh, turn-bounded execution grant. A new task never inherits approvals from the previous task. */
	beginTask(source: BeeMaxRuntimeSource, taskId: string): void {
		const sourceKey = sessionKeyForSource(source);
		const current = this.taskGrants.get(sourceKey);
		if (current?.taskId === taskId) return;
		this.taskGrants.set(sourceKey, { taskId, allowedCapabilities: new Set() });
	}

	/** End only the matching task so a stale completion cannot revoke a newer turn's grant. */
	endTask(source: BeeMaxRuntimeSource, taskId: string): boolean {
		const sourceKey = sessionKeyForSource(source);
		if (this.taskGrants.get(sourceKey)?.taskId !== taskId) return false;
		this.taskGrants.delete(sourceKey);
		return true;
	}

	executionGrant(source: BeeMaxRuntimeSource): TaskExecutionGrantSnapshot | undefined {
		const grant = this.taskGrants.get(sessionKeyForSource(source));
		return grant ? { taskId: grant.taskId, allowedCapabilities: [...grant.allowedCapabilities].sort(), status: "active" } : undefined;
	}

	async authorize(request: ToolApprovalRequest, signal?: AbortSignal): Promise<ToolApprovalDecision> {
		if (signal?.aborted) return { allowed: false, reason: "Tool approval cancelled" };
		const sourceKey = sessionKeyForSource(request.source);
		if (this.taskGrants.get(sourceKey)?.allowedCapabilities.has(request.toolName)) {
			this.audit?.({ source: request.source, toolName: request.toolName, allowed: true, reason: "task execution grant" });
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
		this.emit({ type: "requested", source: request.source, toolName: request.toolName, details: approvalDetails(request) });
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
		const choice = parseChoice(text);
		if (!choice) {
			if (!this.pending.has(sessionKeyForSource(source))) return false;
			await this.sendPrompt(source, "存在待审批工具调用。请回复：1（允许一次）、2（本任务允许）或 3（拒绝）。");
			return true;
		}
		return this.decide(source, choice);
	}

	/** Semantic approval action for cards, TUI buttons, and Web controls. */
	async decide(source: BeeMaxRuntimeSource, choice: ToolApprovalChoice): Promise<boolean> {
		const sourceKey = sessionKeyForSource(source);
		const pending = this.pending.get(sourceKey);
		if (!pending) return false;
		if (choice === "task" || choice === "session") {
			this.taskGrants.get(sourceKey)?.allowedCapabilities.add(pending.toolName);
			this.finish(sourceKey, { allowed: true });
			await this.sendPrompt(source, this.taskGrants.has(sourceKey) ? `已允许本任务继续使用工具 \`${pending.toolName}\`。` : `当前没有活动任务，已允许本次工具调用 \`${pending.toolName}\`。`);
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
		this.taskGrants.clear();
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

function parseChoice(text: string): ToolApprovalChoice | undefined {
	const choice = text.trim().toLowerCase();
	if (["1", "允许", "允许一次", "allow", "allow once", "yes", "y"].includes(choice)) return "once";
	if (["2", "本任务允许", "任务允许", "本会话允许", "会话允许", "allow task", "allow session", "always this session"].includes(choice)) return "task";
	if (["3", "拒绝", "deny", "no", "n"].includes(choice)) return "deny";
	return undefined;
}

function renderApprovalPrompt(request: ToolApprovalRequest): string {
	const assessment = approvalDetails(request);
	return [
		"⚠️ 工具调用需要审批",
		`工具：\`${request.toolName}\``,
		`目标：${assessment.target}`,
		`风险：${assessment.risk}`,
		`影响：${assessment.impact}`,
		`可逆性：${assessment.reversibility}`,
		"参数：", "```json", assessment.argsSummary, "```",
		"请回复：", "1 — 允许一次", "2 — 本任务允许此工具", "3 — 拒绝",
	].join("\n");
}

export function approvalDetails(request: ToolApprovalRequest): ToolApprovalDetails {
	const args = request.args && typeof request.args === "object" ? request.args as Record<string, unknown> : {};
	const target = approvalTarget(args);
	const argsSummary = formatArgs(request.args);
	const policy = request.policy ?? { ...MUTATING_TOOL_POLICY, risk: "medium" as const, impact: "未注册工具按保守策略处理" };
	return {
		target,
		risk: policy.risk === "high" ? "高" : policy.risk === "medium" ? "中" : "低",
		impact: policy.impact,
		reversibility: policy.reversible === true ? "可逆或只读" : policy.reversible === false ? "不可逆" : "可逆性未知，请确认恢复方式",
		argsSummary,
	};
}

function formatArgs(args: unknown): string {
	let rendered: string;
	try { rendered = JSON.stringify(redact(args), null, 2); } catch { rendered = String(args); }
	return rendered.length > 1600 ? `${rendered.slice(0, 1600)}\n…[truncated]` : rendered;
}

function redact(value: unknown, key = ""): unknown {
	if (SENSITIVE_KEY_RE.test(key)) return "[REDACTED]";
	if (key === "url" && typeof value === "string") return redactUrl(value);
	if (Array.isArray(value)) return value.map((item) => redact(item));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
	return value;
}

function approvalTarget(args: Record<string, unknown>): string {
	if (typeof args.path === "string" && args.path.trim()) return args.path;
	if (typeof args.url === "string" && args.url.trim()) return redactUrl(args.url);
	if (typeof args.selector === "string" && args.selector.trim()) return args.selector;
	// Commands often embed credentials; the complete redacted command remains in
	// the parameter summary, while the card header never repeats it verbatim.
	if (typeof args.command === "string" && args.command.trim()) return "shell command";
	return "由工具参数决定";
}

function redactUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.username) url.username = "[REDACTED]";
		if (url.password) url.password = "[REDACTED]";
		for (const key of [...url.searchParams.keys()]) if (SENSITIVE_KEY_RE.test(key)) url.searchParams.set(key, "[REDACTED]");
		return url.toString();
	} catch { return value.replace(/([?&](?:token|secret|password|api[_-]?key|authorization|cookie|credential)=)[^&\s]+/gi, "$1[REDACTED]"); }
}

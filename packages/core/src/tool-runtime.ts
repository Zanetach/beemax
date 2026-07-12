import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BeeMaxRuntimeSource } from "./runtime.ts";

export type ToolRisk = "low" | "medium" | "high";
export type ToolSideEffect = "none" | "local" | "external";
export type ToolApprovalMode = "never" | "always";

export interface ToolPolicy {
	risk: ToolRisk;
	sideEffect: ToolSideEffect;
	approval: ToolApprovalMode;
	reversible: boolean | "unknown";
	timeoutMs: number;
	maxAttempts: number;
	maxResultBytes: number;
	impact: string;
}

export interface ToolCapabilityGrant {
	name: string;
	enabled: boolean;
	policy: ToolPolicy;
}

export type GovernedToolDefinition = ToolDefinition & { beemaxPolicy?: ToolPolicy };
export type ToolRuntimeAuditEvent = {
	phase: "requested" | "allowed" | "blocked" | "started" | "completed" | "failed";
	source: BeeMaxRuntimeSource;
	toolName: string;
	policy: ToolPolicy;
	at: number;
	attempt?: number;
	durationMs?: number;
	reason?: string;
};
export type ToolRuntimeAuditSink = (event: ToolRuntimeAuditEvent) => void;

export const READ_ONLY_TOOL_POLICY: Readonly<ToolPolicy> = Object.freeze({
	risk: "low", sideEffect: "none", approval: "never", reversible: true,
	timeoutMs: 60_000, maxAttempts: 2, maxResultBytes: 128 * 1024,
	impact: "Reads data without changing local or external state",
});

export const MUTATING_TOOL_POLICY: Readonly<ToolPolicy> = Object.freeze({
	risk: "high", sideEffect: "external", approval: "always", reversible: "unknown",
	timeoutMs: 3 * 60_000, maxAttempts: 1, maxResultBytes: 128 * 1024,
	impact: "May change local files, Profile state, or an external service",
});

const BUILTIN_POLICIES = new Map<string, ToolPolicy>([
	...["read", "grep", "find", "ls", "web_search", "web_extract"].map((name) => [name, { ...READ_ONLY_TOOL_POLICY }] as const),
	...["bash", "edit", "write"].map((name) => [name, { ...MUTATING_TOOL_POLICY, sideEffect: "local" as const }] as const),
]);

/** Core-owned policy catalog used by execution, approval, audit, and future health reporting. */
export class ToolPolicyRegistry {
	private readonly policies = new Map<string, ToolPolicy>();
	private readonly enabledTools = new Set<string>();

	constructor(tools: Iterable<ToolDefinition> = []) {
		for (const [name, policy] of BUILTIN_POLICIES) this.policies.set(name, policy);
		for (const tool of tools) {
			const explicit = (tool as GovernedToolDefinition).beemaxPolicy;
			this.policies.set(tool.name, normalizeToolPolicy(explicit ?? {
				...MUTATING_TOOL_POLICY,
				risk: "medium",
				impact: "Tool capability has no first-class policy; treat it conservatively",
			}));
		}
	}

	get(name: string): ToolPolicy {
		return this.policies.get(name) ?? { ...MUTATING_TOOL_POLICY, risk: "medium", impact: "Tool capability is not yet registered; treat it conservatively" };
	}

	enable(names: Iterable<string>): void {
		for (const name of names) this.enabledTools.add(name);
	}

	disable(names: Iterable<string>): void {
		for (const name of names) this.enabledTools.delete(name);
	}

	grant(name: string): ToolCapabilityGrant {
		return { name, enabled: this.enabledTools.has(name), policy: { ...this.get(name) } };
	}

	enabledNames(): string[] {
		return [...this.enabledTools].sort((a, b) => a.localeCompare(b));
	}

	list(): Array<{ name: string; policy: ToolPolicy }> {
		return [...this.policies].map(([name, policy]) => ({ name, policy: { ...policy } })).sort((a, b) => a.name.localeCompare(b.name));
	}
}

export function withToolPolicy<T extends ToolDefinition>(tool: T, policy: ToolPolicy): T & GovernedToolDefinition {
	return Object.assign(tool, { beemaxPolicy: normalizeToolPolicy(policy) });
}

/** Apply the policy execution contract to a custom first-class Tool. */
export function governToolDefinition<T extends ToolDefinition>(tool: T, policy: ToolPolicy, source: BeeMaxRuntimeSource, audit?: ToolRuntimeAuditSink): T & GovernedToolDefinition {
	const normalized = normalizeToolPolicy(policy);
	const execute = tool.execute.bind(tool);
	return Object.assign({ ...tool, async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) {
		const startedAt = Date.now();
		for (let attempt = 1; attempt <= normalized.maxAttempts; attempt++) {
			audit?.({ phase: "started", source, toolName: tool.name, policy: normalized, at: Date.now(), attempt });
			const timeoutController = new AbortController();
			const timer = setTimeout(() => timeoutController.abort(new Error(`Tool ${tool.name} timed out after ${normalized.timeoutMs}ms`)), normalized.timeoutMs);
			const effectiveSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
			try {
				const result = await abortable(execute(toolCallId, params as never, effectiveSignal, onUpdate as never, ctx as never), effectiveSignal, tool.name);
				const bounded = boundToolResult(result, normalized.maxResultBytes);
				if ((bounded as { isError?: boolean }).isError === true) {
					const errorBlock = bounded.content.find((block) => block.type === "text" && "text" in block && typeof block.text === "string");
					const message = errorBlock && "text" in errorBlock && typeof errorBlock.text === "string" ? errorBlock.text.slice(0, 500) : "Tool returned an error result";
					throw new Error(`Tool ${tool.name} failed: ${message}`);
				}
				audit?.({ phase: "completed", source, toolName: tool.name, policy: normalized, at: Date.now(), attempt, durationMs: Date.now() - startedAt });
				return bounded;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				audit?.({ phase: "failed", source, toolName: tool.name, policy: normalized, at: Date.now(), attempt, durationMs: Date.now() - startedAt, reason: reason.slice(0, 500) });
				const retry = normalized.sideEffect === "none" && attempt < normalized.maxAttempts && !signal?.aborted && !timeoutController.signal.aborted;
				if (!retry) {
					throw error;
				}
			} finally {
				clearTimeout(timer);
			}
		}
		throw new Error(`Tool ${tool.name} exhausted its retry policy`);
	} }, { beemaxPolicy: normalized }) as T & GovernedToolDefinition;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal, toolName: string): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(`Tool ${toolName} was cancelled`));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(`Tool ${toolName} was cancelled`));
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function normalizeToolPolicy(policy: ToolPolicy): ToolPolicy {
	return {
		...policy,
		timeoutMs: Math.max(100, Math.min(policy.timeoutMs, 60 * 60_000)),
		maxAttempts: Math.max(1, Math.min(Math.trunc(policy.maxAttempts), 5)),
		maxResultBytes: Math.max(1_024, Math.min(policy.maxResultBytes, 10 * 1024 * 1024)),
	};
}

function boundToolResult<T extends { content: Array<{ type: string; text?: string }>; details: unknown }>(result: T, maxBytes: number): T {
	let remaining = maxBytes;
	let truncated = false;
	const content = result.content.flatMap((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return [block];
		const bytes = Buffer.byteLength(block.text);
		if (bytes <= remaining) { remaining -= bytes; return [block]; }
		if (remaining <= 0) { truncated = true; return []; }
		truncated = true;
		const text = Buffer.from(block.text).subarray(0, remaining).toString("utf8");
		remaining = 0;
		return [{ ...block, text }];
	});
	if (truncated) content.push({ type: "text", text: "\n[Tool result truncated by BeeMax Tool Runtime]" });
	return { ...result, content };
}

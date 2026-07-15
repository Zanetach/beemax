import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import type { CapabilityKind, CapabilityOperationalSignals } from "./capability-runtime.ts";
import type { CapabilityProviderHealthStatus } from "./capability-provider.ts";

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
	/** Provider whose structured Effect proof this runtime-owned Tool adapter may attest. */
	effectProofProvider?: string;
}

export interface ToolCapabilityGrant {
	name: string;
	enabled: boolean;
	policy: ToolPolicy;
}

export interface ToolResultBudget {
	/** Conservative text-token estimate shared by first-class Tool and MCP results. */
	maxEstimatedTokens: number;
}

export function normalizeToolResultBudget(budget: ToolResultBudget): ToolResultBudget {
	const value = Number.isFinite(budget.maxEstimatedTokens) ? Math.trunc(budget.maxEstimatedTokens) : 12_000;
	return { maxEstimatedTokens: Math.max(64, Math.min(value, 1_000_000)) };
}

/** Trusted composition metadata consumed by the turn-scoped Tool Spec Planner. False/unhealthy facts only restrict exposure. */
export interface ToolSpecAvailabilityMetadata {
	kind?: CapabilityKind;
	version?: string;
	configured?: boolean;
	health?: CapabilityProviderHealthStatus;
	authorized?: boolean;
	/** Optional generic selection facts. These influence ranking but never grant authority. */
	ranking?: CapabilityOperationalSignals;
}
export type GovernedToolDefinition = ToolDefinition & { beemaxPolicy?: ToolPolicy; beemaxToolSpec?: ToolSpecAvailabilityMetadata };
export type ToolRuntimeAuditEvent = {
	phase: "requested" | "allowed" | "blocked" | "started" | "completed" | "failed";
	source: BeeMaxRuntimeSource;
	toolName: string;
	policy: ToolPolicy;
	at: number;
	attempt?: number;
	durationMs?: number;
	resultBytes?: number;
	resultEstimatedTokens?: number;
	resultTruncated?: boolean;
	reason?: string;
	enterprisePolicy?: {
		decisionId: string;
		publisherId: string;
		version: string;
		disposition: "allow" | "deny" | "require_approval" | "constrain" | "missing_evidence";
		effectiveScopeId: string;
		effectiveFrom: number;
		effectiveUntil?: number;
		evaluatedAt: number;
		evidenceRefs: string[];
	};
	governance?: {
		decisionId: string;
		outcome: "allow" | "deny" | "require_approval" | "missing_evidence";
		reasonCode: string;
		factors: string[];
		policyDecisionId?: string;
		executionGrantId?: string;
	};
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
			if (!explicit && this.policies.has(tool.name)) throw new Error(`Tool ${tool.name} duplicates a built-in capability without declaring beemaxPolicy`);
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
export function governToolDefinition<T extends ToolDefinition>(tool: T, policy: ToolPolicy, source: BeeMaxRuntimeSource, audit?: ToolRuntimeAuditSink, resultBudget?: ToolResultBudget, options: { deferResultProjection?: boolean } = {}): T & GovernedToolDefinition {
	const normalized = normalizeToolPolicy(policy);
	const maxEstimatedTokens = resultBudget ? normalizeToolResultBudget(resultBudget).maxEstimatedTokens : Number.POSITIVE_INFINITY;
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
				const bounded = options.deferResultProjection ? measureToolResult(result) : boundToolResult(result, normalized.maxResultBytes, maxEstimatedTokens);
				if ((bounded.result as { isError?: boolean }).isError === true) {
					const errorBlock = bounded.result.content.find((block) => block.type === "text" && "text" in block && typeof block.text === "string");
					const message = errorBlock && "text" in errorBlock && typeof errorBlock.text === "string" ? errorBlock.text.slice(0, 500) : "Tool returned an error result";
					throw new Error(`Tool ${tool.name} failed: ${message}`);
				}
				audit?.({ phase: "completed", source, toolName: tool.name, policy: normalized, at: Date.now(), attempt, durationMs: Date.now() - startedAt, resultBytes: bounded.bytes, resultEstimatedTokens: bounded.estimatedTokens, resultTruncated: bounded.truncated });
				return bounded.result;
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

function measureToolResult<T extends { content: Array<{ type: string; text?: string; data?: string }>; details: unknown }>(result: T): { result: T; bytes: number; estimatedTokens: number; truncated: false } {
	let bytes = 0; let tokenUnits = 0;
	for (const block of result.content) {
		if (block.type === "text" && typeof block.text === "string") { bytes += Buffer.byteLength(block.text); tokenUnits += estimatedTokenUnits(block.text); }
		else if (block.type === "image" && typeof block.data === "string") { bytes += estimatedBase64PayloadBytes(block.data); tokenUnits += 4_800; }
		else tokenUnits += 256;
	}
	return { result, bytes, estimatedTokens: Math.ceil(tokenUnits / 4), truncated: false };
}

function estimatedBase64PayloadBytes(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return Math.floor((value.length - padding) * 3 / 4);
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
	const effectProofProvider = typeof policy.effectProofProvider === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(policy.effectProofProvider) ? policy.effectProofProvider : undefined;
	const { effectProofProvider: _untrustedProvider, ...base } = policy;
	return {
		...base,
		...(effectProofProvider ? { effectProofProvider } : {}),
		timeoutMs: Math.max(100, Math.min(policy.timeoutMs, 60 * 60_000)),
		maxAttempts: Math.max(1, Math.min(Math.trunc(policy.maxAttempts), 5)),
		maxResultBytes: Math.max(1_024, Math.min(policy.maxResultBytes, 10 * 1024 * 1024)),
	};
}

function boundToolResult<T extends { content: Array<{ type: string; text?: string }>; details: unknown }>(result: T, maxBytes: number, maxEstimatedTokens: number): { result: T; bytes: number; estimatedTokens: number; truncated: boolean } {
	const bounded = boundToolResultContent(result.content, { maxBytes, maxEstimatedTokens });
	return { result: { ...result, content: bounded.content }, bytes: bounded.bytes, estimatedTokens: bounded.estimatedTokens, truncated: bounded.truncated };
}

/** Apply one context budget to text blocks from built-in Tools, custom Tools, and MCP. */
export function boundToolResultContent<T extends { type: string; text?: string }>(content: readonly T[], budget: { maxBytes: number; maxEstimatedTokens: number }): { content: Array<T | { type: "text"; text: string }>; bytes: number; estimatedTokens: number; truncated: boolean } {
	const maxTokenUnits = Number.isFinite(budget.maxEstimatedTokens) ? budget.maxEstimatedTokens * 4 : Number.POSITIVE_INFINITY;
	const initial = sliceToolResultContent(content, budget.maxBytes, maxTokenUnits);
	if (!initial.truncated) return { content: initial.content, bytes: initial.bytes, estimatedTokens: Math.ceil(initial.tokenUnits / 4), truncated: false };
	const marker = "\n[Tool result truncated by BeeMax Tool Runtime]";
	const markerBytes = Buffer.byteLength(marker);
	const markerUnits = estimatedTokenUnits(marker);
	const bounded = sliceToolResultContent(content, Math.max(0, budget.maxBytes - markerBytes), Math.max(0, maxTokenUnits - markerUnits));
	return { content: [...bounded.content, { type: "text", text: marker }], bytes: bounded.bytes + markerBytes, estimatedTokens: Math.ceil((bounded.tokenUnits + markerUnits) / 4), truncated: true };
}

function sliceToolResultContent<T extends { type: string; text?: string }>(content: readonly T[], maxBytes: number, maxTokenUnits: number): { content: Array<T | { type: "text"; text: string }>; bytes: number; tokenUnits: number; truncated: boolean } {
	let remaining = maxBytes;
	let remainingTokenUnits = maxTokenUnits;
	let bytesUsed = 0;
	let tokenUnitsUsed = 0;
	let truncated = false;
	const boundedContent: Array<T | { type: "text"; text: string }> = [];
	for (const block of content) {
		if (block.type !== "text" || typeof block.text !== "string") {
			const blockUnits = block.type === "image" ? 4_800 : 256;
			if (blockUnits <= remainingTokenUnits) { boundedContent.push(block); remainingTokenUnits -= blockUnits; tokenUnitsUsed += blockUnits; }
			else truncated = true;
			continue;
		}
		const bytes = Buffer.byteLength(block.text);
		const tokenUnits = estimatedTokenUnits(block.text);
		if (bytes <= remaining && tokenUnits <= remainingTokenUnits) { remaining -= bytes; remainingTokenUnits -= tokenUnits; bytesUsed += bytes; tokenUnitsUsed += tokenUnits; boundedContent.push(block); continue; }
		if (remaining <= 0 || remainingTokenUnits <= 0) { truncated = true; continue; }
		truncated = true;
		const text = truncateTextToBudget(block.text, remaining, remainingTokenUnits);
		const textBytes = Buffer.byteLength(text);
		const textUnits = estimatedTokenUnits(text);
		remaining -= textBytes;
		remainingTokenUnits -= textUnits;
		bytesUsed += textBytes;
		tokenUnitsUsed += textUnits;
		boundedContent.push({ ...block, text });
	}
	return { content: boundedContent, bytes: bytesUsed, tokenUnits: tokenUnitsUsed, truncated };
}

function estimatedTokenUnits(value: string): number {
	let units = 0;
	for (const character of value) units += character.codePointAt(0)! <= 0x7f ? 1 : 4;
	return units;
}

function truncateTextToBudget(value: string, maxBytes: number, maxTokenUnits: number): string {
	let bytes = 0;
	let tokenUnits = 0;
	let output = "";
	for (const character of value) {
		const nextBytes = Buffer.byteLength(character);
		const nextTokenUnits = character.codePointAt(0)! <= 0x7f ? 1 : 4;
		if (bytes + nextBytes > maxBytes || tokenUnits + nextTokenUnits > maxTokenUnits) break;
		output += character;
		bytes += nextBytes;
		tokenUnits += nextTokenUnits;
	}
	return output;
}

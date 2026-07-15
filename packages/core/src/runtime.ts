import { existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { curatedMemoryPrompt } from "./curated-memory.ts";
import {
	type AgentSession,
	type Skill,
	type ToolDefinition,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { boundToolResultContent, governToolDefinition, normalizeToolResultBudget, ToolPolicyRegistry, type ToolPolicy, type ToolResultBudget, type ToolRuntimeAuditSink } from "./tool-runtime.ts";
import type { AgentScope } from "./agent-scope.ts";
import { ToolEffectConflictError, type ToolEffectSink } from "./tool-effect.ts";
import type { ExecutionEnvelope } from "./execution-envelope.ts";
import { EnterprisePolicyRuntime, type EnterprisePolicyDecision, type EnterprisePolicyProvider } from "./enterprise-policy.ts";
import { ActionGovernance, type ActionGovernanceDecision, type MeasuredActionReliability } from "./action-governance.ts";
import { evaluateCompactionQuality, planContextCompaction, recoverCompactionPreservation, taskIdsFromCompactionPreservation } from "./context-compaction.ts";

export type BeeMaxRuntimeSource = AgentScope;

export interface BeeMaxRuntimeAuthorization<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	(source: Source, toolName: string, args: unknown, policy: ToolPolicy, signal?: AbortSignal): Promise<{ allowed: boolean; reason?: string }>;
}

export interface ProactiveMutationAuthority<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	(input: { source: Source; executionEnvelope: Readonly<ExecutionEnvelope>; toolName: string; policy: ToolPolicy; enterprisePolicy: EnterprisePolicyDecision }): Promise<{ allowed: boolean; reason?: string }> | { allowed: boolean; reason?: string };
}

export type ContextCompactionAuditEvent<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> = {
	phase: "started" | "completed" | "failed";
	source: Source;
	reason: "manual" | "threshold" | "overflow";
	at: number;
	willRetry: boolean;
	tokensBefore?: number;
	reserveTokens: number;
	keepRecentTokens: number;
	summaryChars?: number;
	expectedTaskCount: number;
	missingTaskCount?: number;
	recoveryInjected?: boolean;
	qualityStatus?: "good" | "degraded" | "critical";
	identityCoverage?: number;
	semanticCoverage?: number;
	semanticAnchorCount?: number;
	missingSemanticAnchorCount?: number;
	error?: string;
};

export interface BeeMaxRuntimeFactoryOptions<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	provider: string;
	model: string;
	baseUrl?: string;
	customProtocol?: "openai-completions" | "openai-responses" | "anthropic-messages";
	/** Required model capabilities when a custom provider is not present in the built-in catalog. */
	modelLimits?: { contextWindow?: number; maxTokens?: number };
	cwd: string;
	agentDir: string;
	getApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Providers used by configured runtime fallbacks; their Profile credentials are loaded into Pi before a retry. */
	additionalModelProviders?: readonly string[];
	systemPrompt: string | (() => string);
	skillToolset: "safe" | "standard";
	tools?: string[];
	createTools: (source: Source, onResourcesChanged: () => void, getRuntimeApiKey: (provider: string) => Promise<string | undefined>, activateTools: (names: string[]) => void) => ToolDefinition[];
	authorizeTool?: BeeMaxRuntimeAuthorization<Source>;
	enterprisePolicy?: EnterprisePolicyProvider;
	actionReliability?: (toolName: string) => MeasuredActionReliability;
	executionGrant?: (source: Source) => { taskId: string; allowedCapabilities: string[]; status: "active" } | undefined;
	proactiveMutationAuthority?: ProactiveMutationAuthority<Source>;
	toolAudit?: ToolRuntimeAuditSink;
	/** One Profile-wide context budget applied after every custom Tool/MCP result. */
	toolResultBudget?: ToolResultBudget;
	toolEffects?: ToolEffectSink;
	currentTaskId?: (source: Source) => string | undefined;
	/** Durable preservation instructions injected into Pi manual and automatic compaction. */
	compactionInstructions?: (source: Source) => string | undefined;
	/** Optional Profile overrides; omitted values scale from the selected model context window. */
	compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
	/** Host-owned transient Provider retry policy; the Execution Envelope still owns the total deadline. */
	providerRetry?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
	/** Content-free compaction lifecycle and durable-preservation quality observations. */
	compactionAudit?: (event: ContextCompactionAuditEvent<Source>) => void;
}

const reloadPending = new WeakSet<AgentSession>();

export function markRuntimeResourcesChanged(session: AgentSession | undefined): void {
	if (session) reloadPending.add(session);
}

export async function reloadRuntimeResourcesIfNeeded(session: AgentSession): Promise<boolean> {
	if (!reloadPending.has(session)) return false;
	reloadPending.delete(session);
	await session.reload();
	return true;
}

/** Build the BeeMax-owned persistent Agent Runtime; Pi is an internal implementation detail. */
export function buildBeeMaxRuntimeFactory<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource>(opts: BeeMaxRuntimeFactoryOptions<Source>) {
	const cwd = resolve(opts.cwd);
	const agentDir = resolve(opts.agentDir);
	const sessionDir = join(agentDir, "sessions", "feishu");
	mkdirSync(sessionDir, { recursive: true });
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const resolvedModel = resolveRuntimeModel(opts.provider, opts.model, opts.baseUrl, opts.customProtocol, opts.modelLimits);
	const model = opts.baseUrl ? { ...resolvedModel, baseUrl: opts.baseUrl } : resolvedModel;
	return async (sessionId: string, source: Source, executionEnvelope?: Readonly<ExecutionEnvelope>, legacySessionIds: string[] = []): Promise<AgentSession> => {
		const credentialProviders = [...new Set([opts.provider, ...(opts.additionalModelProviders ?? [])])].sort();
		for (const provider of credentialProviders) {
			const apiKey = await opts.getApiKey(provider);
			if (apiKey) authStorage.setRuntimeApiKey(provider === opts.provider ? model.provider : provider, apiKey);
		}
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const compaction = planContextCompaction({ contextWindow: model.contextWindow || 128_000, ...opts.compaction });
		const toolResultBudget = opts.toolResultBudget ? normalizeToolResultBudget(opts.toolResultBudget) : undefined;
		settingsManager.setRuntimeCompactionSettings({ enabled: compaction.enabled, reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens });
		settingsManager.setRuntimeProviderRetrySettings(normalizeProviderRetry(opts.providerRetry));
		const configuredPrompt = typeof opts.systemPrompt === "function" ? opts.systemPrompt() : opts.systemPrompt;
		const channelPrompt = [configuredPrompt, curatedMemoryPrompt(agentDir, source), channelContextFor(source)].filter(Boolean).join("\n\n");
		let pendingCompaction: { preservation?: string; taskIds: string[]; tokensBefore?: number } | undefined;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			appendSystemPromptOverride: (base) => [...base, channelPrompt],
			// Discovery is owned by capability_discover. Keep Skills registered for
			// explicit /skill:name compatibility without injecting the full catalog.
			skillsOverride: (base) => ({ ...base, skills: filterEligibleSkills(base.skills, opts.skillToolset).map((skill) => ({ ...skill, disableModelInvocation: true })) }),
			extensionFactories: opts.compactionInstructions || opts.compactionAudit || toolResultBudget ? [{ name: "beemax-context-governance", factory: (pi) => {
				if (toolResultBudget) pi.on("tool_result", (event) => {
					const bounded = boundToolResultContent(event.content, { maxBytes: 10 * 1024 * 1024, maxEstimatedTokens: toolResultBudget.maxEstimatedTokens });
					return bounded.truncated ? { content: bounded.content as typeof event.content } : undefined;
				});
				if (opts.compactionInstructions || opts.compactionAudit) {
				pi.on("session_before_compact", (event) => {
					let preservation: string | undefined;
					try {
						preservation = opts.compactionInstructions?.(source);
					} catch {
						opts.compactionAudit?.({ phase: "failed", source, reason: event.reason, at: Date.now(), willRetry: event.willRetry, tokensBefore: event.preparation.tokensBefore, reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens, expectedTaskCount: 0, error: "task_preservation_assembly_failed" });
						// Compaction must not destroy the only durable recovery context merely
						// because preservation assembly failed.
						return { cancel: true };
					}
					const taskIds = preservation ? taskIdsFromCompactionPreservation(preservation) : [];
					pendingCompaction = { preservation, taskIds, tokensBefore: event.preparation.tokensBefore };
					opts.compactionAudit?.({ phase: "started", source, reason: event.reason, at: Date.now(), willRetry: event.willRetry, tokensBefore: event.preparation.tokensBefore, reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens, expectedTaskCount: taskIds.length });
					if (!preservation) return;
					if (event.customInstructions?.includes(preservation)) return { customInstructions: event.customInstructions };
					return { customInstructions: [event.customInstructions, preservation].filter(Boolean).join("\n\n") };
				});
				pi.on("session_compact", (event) => {
					const pending = pendingCompaction ?? { taskIds: [] };
					const quality = pending.preservation ? evaluateCompactionQuality({ summary: event.compactionEntry.summary, preservation: pending.preservation }) : undefined;
					const recovery = pending.preservation
						? recoverCompactionPreservation({ summary: event.compactionEntry.summary, preservation: pending.preservation, expectedTaskIds: pending.taskIds })
						: { complete: true, missingTaskIds: [] };
					if (recovery.recoveryContext) {
						pi.sendMessage({ customType: "beemax-task-preservation-recovery", content: recovery.recoveryContext, display: false, details: { missingTaskIds: recovery.missingTaskIds } }, { triggerTurn: false, deliverAs: "context" });
					}
					opts.compactionAudit?.({ phase: "completed", source, reason: event.reason, at: Date.now(), willRetry: event.willRetry, tokensBefore: event.compactionEntry.tokensBefore, reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens, summaryChars: event.compactionEntry.summary.length, expectedTaskCount: pending.taskIds.length, missingTaskCount: recovery.missingTaskIds.length, recoveryInjected: Boolean(recovery.recoveryContext), qualityStatus: quality?.status, identityCoverage: quality?.identityCoverage, semanticCoverage: quality?.semanticCoverage, semanticAnchorCount: quality?.semanticAnchorCount, missingSemanticAnchorCount: quality?.missingSemanticAnchors.length });
					pendingCompaction = undefined;
				});
				}
			} }] : [],
		});
		await resourceLoader.reload();
		const sessionManager = await restoreOrCreateSession(cwd, sessionDir, sessionId, legacySessionIds);
		let sessionRef: AgentSession | undefined;
		const customTools = opts.createTools(
			source,
			() => markRuntimeResourcesChanged(sessionRef),
			(provider) => authStorage.getApiKey(provider, { includeFallback: false }),
			(names) => sessionRef?.setActiveToolsByName([...new Set([...sessionRef.getActiveToolNames(), "capability_discover", ...names])]),
		);
		const turnResetters = customTools.flatMap((tool) => typeof (tool as ToolDefinition & { beemaxTurnReset?: () => void }).beemaxTurnReset === "function" ? [(tool as ToolDefinition & { beemaxTurnReset: () => void }).beemaxTurnReset] : []);
		const policies = new ToolPolicyRegistry(customTools);
		policies.enable(opts.tools ?? [
			"read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_extract",
			...customTools.map((tool) => tool.name),
		]);
		const governedTools = customTools.map((tool) => governToolDefinition(tool, policies.get(tool.name), source, opts.toolAudit, toolResultBudget));
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd, agentDir, model,
			tools: policies.enabledNames(),
			customTools: governedTools, authStorage, modelRegistry, settingsManager, resourceLoader, sessionManager,
		});
		if (opts.compactionAudit) session.subscribe((event) => {
			if (event.type !== "compaction_end" || event.result || !pendingCompaction) return;
			opts.compactionAudit?.({
				phase: "failed",
				source,
				reason: event.reason,
				at: Date.now(),
				willRetry: event.willRetry,
				tokensBefore: pendingCompaction.tokensBefore,
				reserveTokens: compaction.reserveTokens,
				keepRecentTokens: compaction.keepRecentTokens,
				expectedTaskCount: pendingCompaction.taskIds.length,
				error: event.aborted ? "compaction_aborted" : "compaction_failed",
			});
			pendingCompaction = undefined;
		});
		sessionRef = session;
		(session as AgentSession & { beemaxExecutionEnvelope?: Readonly<ExecutionEnvelope> }).beemaxExecutionEnvelope = executionEnvelope;
		(session as AgentSession & { beemaxResetTurnResources?: () => void }).beemaxResetTurnResources = () => {
			for (const reset of turnResetters) reset();
			const taskId = currentExecutionEnvelope(session)?.taskId ?? opts.currentTaskId?.(source) ?? source.delegatedTask?.id;
			if (taskId) opts.toolEffects?.interruptTask?.(taskId);
		};
		if (modelFallbackMessage) console.warn(`[beemax] ${modelFallbackMessage}`);
		installSecurityHook(session, cwd, source, opts.authorizeTool, policies, opts.enterprisePolicy, opts.actionReliability, opts.executionGrant, opts.proactiveMutationAuthority, opts.toolAudit, opts.toolEffects, opts.currentTaskId);
		return session;
	};
}

export function filterEligibleSkills(skills: Skill[], toolset: "safe" | "standard"): Skill[] {
	return skills.filter((skill) => {
		const metadata = asRecord(skill.metadata);
		const beemax = asRecord(metadata.beemax);
		if (beemax.toolset === "standard" && toolset === "safe") return false;
		const env = arrayOfStrings(beemax.env);
		if (env.some((key) => !process.env[key]?.trim())) return false;
		return arrayOfStrings(beemax.bins).every((bin) => (process.env.PATH ?? "").split(":").some((directory) => existsSync(join(directory, bin))));
	});
}

async function restoreOrCreateSession(cwd: string, sessionDir: string, sessionId: string, legacySessionIds: string[] = []): Promise<SessionManager> {
	const suffixes = [sessionId, ...legacySessionIds].map((id) => `_${id}.jsonl`);
	let matchingFiles: string[] = [];
	try {
		const names = await readdir(sessionDir);
		for (const suffix of suffixes) {
			matchingFiles = names.filter((name) => name.endsWith(suffix)).sort().reverse();
			if (matchingFiles.length) break;
		}
	} catch { /* SessionManager recreates a removed directory. */ }
	return matchingFiles[0] ? SessionManager.open(join(sessionDir, matchingFiles[0]), sessionDir, cwd) : SessionManager.create(cwd, sessionDir, { id: sessionId });
}

function installSecurityHook<Source extends BeeMaxRuntimeSource>(session: AgentSession, cwd: string, source: Source, authorizeTool: BeeMaxRuntimeAuthorization<Source> | undefined, policies: ToolPolicyRegistry, enterprisePolicy: EnterprisePolicyProvider | undefined, actionReliability: ((toolName: string) => MeasuredActionReliability) | undefined, executionGrant: ((source: Source) => { taskId: string; allowedCapabilities: string[]; status: "active" } | undefined) | undefined, proactiveMutationAuthority: ProactiveMutationAuthority<Source> | undefined, audit?: ToolRuntimeAuditSink, effects?: ToolEffectSink, currentTaskId?: (source: Source) => string | undefined): void {
	const enterprisePolicies = new EnterprisePolicyRuntime(enterprisePolicy);
	const governance = new ActionGovernance();
	let budgetExecutionId: string | undefined;
	let dispatchedToolCalls = 0;
	const previous = session.agent.beforeToolCall;
	session.agent.beforeToolCall = async (context, signal) => {
		const priorResult = await previous?.(context, signal);
		if (priorResult?.block) return priorResult;
		const policy = policies.get(context.toolCall.name);
		if (!session.getActiveToolNames().includes(context.toolCall.name)) {
			const reason = `Tool ${context.toolCall.name} is not active for the current Pi turn`;
			audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason });
			return { block: true, reason };
		}
		const activeEnvelope = currentExecutionEnvelope(session);
		if (budgetExecutionId !== activeEnvelope?.executionId) { budgetExecutionId = activeEnvelope?.executionId; dispatchedToolCalls = 0; }
		const maxToolCalls = activeEnvelope?.budget?.maxToolCalls;
		if (maxToolCalls !== undefined && dispatchedToolCalls >= maxToolCalls) {
			const reason = `Agent tool-call budget exceeded (${maxToolCalls})`;
			audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason });
			return { block: true, reason };
		}
		dispatchedToolCalls++;
		const hardBlock = hardBlockReason(context.toolCall.name, context.args, cwd);
		if (hardBlock) { audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason: hardBlock }); return { block: true, reason: hardBlock }; }
		let enterpriseDecision: EnterprisePolicyDecision | undefined;
		try {
			enterpriseDecision = await enterprisePolicies.evaluate({ source, toolName: context.toolCall.name, args: context.args, toolPolicy: policy, accessScopeRef: currentExecutionEnvelope(session)?.accessScopeRef, at: Date.now() });
		} catch (error) {
			const reason = `Enterprise Policy evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
			audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason });
			return { block: true, reason };
		}
		const enterprisePolicyAudit = enterpriseDecision ? policyAuditMetadata(enterpriseDecision) : undefined;
		const executionEnvelope = currentExecutionEnvelope(session);
		if (policy.sideEffect !== "none" && executionEnvelope?.proactiveAction) {
			const authority = executionEnvelope.proactiveAction;
			if (context.toolCall.name !== authority.capability) {
				const reason = "Proactive mutation Tool does not match its admitted capability";
				audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason, ...(enterprisePolicyAudit ? { enterprisePolicy: enterprisePolicyAudit } : {}) });
				return { block: true, reason };
			}
			if (!enterpriseDecision || enterpriseDecision.id !== authority.policyDecisionId) {
				const reason = "Proactive mutation requires the current referenced Enterprise Policy decision";
				audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason, ...(enterprisePolicyAudit ? { enterprisePolicy: enterprisePolicyAudit } : {}) });
				return { block: true, reason };
			}
			if (!proactiveMutationAuthority) {
				const reason = "Proactive mutation control authority is unavailable";
				audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason, enterprisePolicy: enterprisePolicyAudit! });
				return { block: true, reason };
			}
			const control = await proactiveMutationAuthority({ source, executionEnvelope, toolName: context.toolCall.name, policy, enterprisePolicy: enterpriseDecision });
			if (!control.allowed) {
				const reason = control.reason ?? "Proactive mutation is paused by its control authority";
				audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason, enterprisePolicy: enterprisePolicyAudit! });
				return { block: true, reason };
			}
		}
		const grant = executionGrant?.(source);
		const governanceInput = { actionId: context.toolCall.id, toolName: context.toolCall.name, toolPolicy: policy, effectStatus: "none" as const, reliability: actionReliability?.(context.toolCall.name) ?? "unknown" as const, ...(enterpriseDecision ? { enterprisePolicy: enterpriseDecision } : {}), ...(grant ? { executionGrant: { id: `task:${grant.taskId}`, ...grant } } : {}) };
		let governanceDecision = governance.decide({ ...governanceInput, at: Date.now() });
		let governanceAudit = governanceAuditMetadata(governanceDecision);
		if (governanceDecision.outcome === "deny" || governanceDecision.outcome === "missing_evidence") {
			audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason: governanceDecision.explanation, ...(enterprisePolicyAudit ? { enterprisePolicy: enterprisePolicyAudit } : {}), governance: governanceAudit });
			return { block: true, reason: governanceDecision.explanation };
		}
		if (governanceDecision.outcome === "allow") {
			audit?.({ phase: "allowed", source, toolName: context.toolCall.name, policy, at: Date.now(), reason: governanceDecision.explanation, ...(enterprisePolicyAudit ? { enterprisePolicy: enterprisePolicyAudit } : {}), governance: governanceAudit });
			const effectBlock = beginToolEffect(effects, { source, executionEnvelope: currentExecutionEnvelope(session), taskId: currentExecutionEnvelope(session)?.taskId ?? currentTaskId?.(source) ?? source.delegatedTask?.id, toolCallId: context.toolCall.id, toolName: context.toolCall.name, policy, args: context.args });
			if (effectBlock) { audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason: effectBlock, ...(enterprisePolicyAudit ? { enterprisePolicy: enterprisePolicyAudit } : {}), governance: governanceAudit }); return { block: true, reason: effectBlock }; }
			return priorResult;
		}
		audit?.({ phase: "requested", source, toolName: context.toolCall.name, policy, at: Date.now(), ...(enterprisePolicyAudit ? { enterprisePolicy: enterprisePolicyAudit } : {}), governance: governanceAudit });
		if (!authorizeTool) { const reason = "This tool requires an approval handler in the current channel"; audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason, ...(enterprisePolicyAudit ? { enterprisePolicy: enterprisePolicyAudit } : {}), governance: governanceAudit }); return { block: true, reason }; }
		const decision = await authorizeTool(source, context.toolCall.name, context.args, policy, signal);
		governanceDecision = governance.decide({ ...governanceInput, approval: decision.allowed ? "approved" as const : "denied" as const, at: Date.now() });
		governanceAudit = governanceAuditMetadata(governanceDecision);
		audit?.({ phase: governanceDecision.outcome === "allow" ? "allowed" : "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason: decision.reason ?? governanceDecision.explanation, ...(enterprisePolicyAudit ? { enterprisePolicy: enterprisePolicyAudit } : {}), governance: governanceAudit });
		if (governanceDecision.outcome !== "allow") return { block: true, reason: decision.reason ?? governanceDecision.explanation };
		const effectBlock = beginToolEffect(effects, { source, executionEnvelope: currentExecutionEnvelope(session), taskId: currentExecutionEnvelope(session)?.taskId ?? currentTaskId?.(source) ?? source.delegatedTask?.id, toolCallId: context.toolCall.id, toolName: context.toolCall.name, policy, args: context.args });
		if (effectBlock) { audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason: effectBlock }); return { block: true, reason: effectBlock }; }
		return priorResult;
	};
	const previousAfter = session.agent.afterToolCall;
	session.agent.afterToolCall = async (context, signal) => {
		const policy = policies.get(context.toolCall.name);
		try {
			const result = await previousAfter?.(context, signal);
			effects?.finish({ source, executionEnvelope: currentExecutionEnvelope(session), toolCallId: context.toolCall.id, toolName: context.toolCall.name, policy, isError: result?.isError ?? context.isError, details: result?.details ?? context.result.details });
			return result;
		} catch (error) {
			effects?.finish({ source, executionEnvelope: currentExecutionEnvelope(session), toolCallId: context.toolCall.id, toolName: context.toolCall.name, policy, isError: true });
			throw error;
		}
	};
}

function governanceAuditMetadata(decision: ActionGovernanceDecision): NonNullable<Parameters<ToolRuntimeAuditSink>[0]["governance"]> {
	return { decisionId: decision.id, outcome: decision.outcome, reasonCode: decision.reasonCode, factors: [...decision.factors], ...(decision.policyDecisionId ? { policyDecisionId: decision.policyDecisionId } : {}), ...(decision.executionGrantId ? { executionGrantId: decision.executionGrantId } : {}) };
}

function policyAuditMetadata(decision: EnterprisePolicyDecision): NonNullable<Parameters<ToolRuntimeAuditSink>[0]["enterprisePolicy"]> {
	return {
		decisionId: decision.id, publisherId: decision.publisher.id, version: decision.version, disposition: decision.disposition,
		effectiveScopeId: decision.effectiveScope.id, effectiveFrom: decision.effectiveFrom,
		...(decision.effectiveUntil === undefined ? {} : { effectiveUntil: decision.effectiveUntil }), evaluatedAt: decision.evaluatedAt,
		evidenceRefs: [...decision.evidenceRefs],
	};
}

function currentExecutionEnvelope(session: AgentSession): Readonly<ExecutionEnvelope> | undefined {
	return (session as AgentSession & { beemaxExecutionEnvelope?: Readonly<ExecutionEnvelope> }).beemaxExecutionEnvelope;
}

function beginToolEffect(effects: ToolEffectSink | undefined, input: Parameters<ToolEffectSink["begin"]>[0]): string | undefined {
	try { effects?.begin(input); return undefined; }
	catch (error) { if (error instanceof ToolEffectConflictError) return error.message; throw error; }
}

function hardBlockReason(toolName: string, args: unknown, cwd: string): string | undefined {
	const input = asRecord(args);
	if (new Set(["read", "edit", "write", "grep", "find", "ls"]).has(toolName) && typeof input.path === "string") {
		const candidate = resolve(cwd, input.path);
		const rel = relative(cwd, candidate);
		if (rel === ".." || rel.startsWith(`..${sep}`) || (isAbsolute(rel) && candidate !== cwd)) return `Tool path is outside the configured workspace: ${input.path}`;
		const normalized = candidate.replaceAll("\\", "/").toLowerCase();
		const name = basename(normalized);
		if (name === "skill.md" || normalized.includes("/.agents/skills/") || normalized.includes("/.codex/skills/") || normalized.startsWith(`${resolve(cwd, "skills").replaceAll("\\", "/").toLowerCase()}/`)) return "Skill resources must be accessed through capability_discover and the Skill Runtime lifecycle";
		if (/^\.env(?:\.(?!example$|sample$).+)?$/.test(name) || normalized.includes("/.ssh/") || normalized.includes("/.aws/credentials") || normalized.includes("/.config/gcloud/") || name === "auth.json" || name === "credentials.json") return `Access to sensitive credential file is blocked: ${input.path}`;
	}
	if (toolName === "bash" && typeof input.command === "string") {
		if (/(?:^|[\s'"`])(?:\.\/)?skills\/|\/skills\/|\bSKILL\.md\b/i.test(input.command)) return "Skill resources cannot be accessed through shell commands; use the Skill Runtime lifecycle";
		for (const rule of [/\brm\s+[^\n]*(?:-rf|-fr)[^\n]*\s\/(?:\s|$)/i, /\b(?:mkfs|fdisk|parted)\b/i, /\bdd\b[^\n]*\bof=\/dev\//i, /\b(?:shutdown|reboot|poweroff|halt)\b/i, /:\(\)\s*\{\s*:\|:&\s*;\s*\}\s*;/]) if (rule.test(input.command)) return "Refusing a destructive host command";
	}
	return undefined;
}

export function resolveRuntimeModel(provider: string, modelId: string, baseUrl?: string, customProtocol: "openai-completions" | "openai-responses" | "anthropic-messages" = "openai-completions", limits?: { contextWindow?: number; maxTokens?: number }): Model<Api> {
	if (provider === "custom") {
		if (!baseUrl) throw new Error("Custom OpenAI-compatible models require a Base URL");
		const contextWindow = boundedModelLimit(limits?.contextWindow, 128_000, 8_000, 10_000_000);
		const maxTokens = Math.min(contextWindow, boundedModelLimit(limits?.maxTokens, 8_192, 256, 1_000_000));
		return {
			id: modelId,
			name: modelId,
			api: customProtocol,
			provider: customProtocol === "anthropic-messages" ? "anthropic" : "openai",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
		};
	}
	const get = getBuiltinModel as <P extends string, M extends string>(p: P, m: M) => Model<Api>;
	const model = get(provider, modelId);
	if (!model) throw new Error(`Could not resolve model ${provider}/${modelId} from the BeeMax runtime catalog`);
	return model;
}

function boundedModelLimit(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) throw new Error("Custom model limits must be finite numbers");
	return Math.max(min, Math.min(Math.trunc(value), max));
}

function normalizeProviderRetry(value: BeeMaxRuntimeFactoryOptions["providerRetry"]): { timeoutMs: number; maxRetries: number; maxRetryDelayMs: number } {
	return {
		timeoutMs: boundedRuntimeInteger(value?.timeoutMs, 60_000, 1_000, 300_000, "Provider timeout"),
		maxRetries: boundedRuntimeInteger(value?.maxRetries, 2, 0, 5, "Provider retry count"),
		maxRetryDelayMs: boundedRuntimeInteger(value?.maxRetryDelayMs, 5_000, 0, 60_000, "Provider retry delay"),
	};
}

function boundedRuntimeInteger(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
	return resolved;
}

function channelContextFor(source: BeeMaxRuntimeSource): string {
	const parts = ["# Channel context", `platform: ${source.platform}`];
	parts.push(source.chatType === "dm" ? `chat: direct message with ${source.userName ?? source.userIdAlt ?? source.userId ?? "user"}` : `chat: ${source.chatType} ${source.chatName ?? source.chatId}`);
	if (source.isBot) parts.push("sender: bot");
	return parts.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function arrayOfStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []; }

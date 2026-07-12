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
import { governToolDefinition, ToolPolicyRegistry, type ToolPolicy, type ToolRuntimeAuditSink } from "./tool-runtime.ts";
import type { AgentScope } from "./agent-scope.ts";

export type BeeMaxRuntimeSource = AgentScope;

export interface BeeMaxRuntimeAuthorization<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	(source: Source, toolName: string, args: unknown, policy: ToolPolicy, signal?: AbortSignal): Promise<{ allowed: boolean; reason?: string }>;
}

export interface BeeMaxRuntimeFactoryOptions<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	provider: string;
	model: string;
	baseUrl?: string;
	customProtocol?: "openai-completions" | "openai-responses" | "anthropic-messages";
	cwd: string;
	agentDir: string;
	getApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
	systemPrompt: string | (() => string);
	skillToolset: "safe" | "standard";
	tools?: string[];
	createTools: (source: Source, onResourcesChanged: () => void, getRuntimeApiKey: (provider: string) => Promise<string | undefined>, activateTools: (names: string[]) => void) => ToolDefinition[];
	authorizeTool?: BeeMaxRuntimeAuthorization<Source>;
	toolAudit?: ToolRuntimeAuditSink;
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
	const resolvedModel = resolveModel(opts.provider, opts.model, opts.baseUrl, opts.customProtocol);
	const model = opts.baseUrl ? { ...resolvedModel, baseUrl: opts.baseUrl } : resolvedModel;
	return async (sessionId: string, source: Source): Promise<AgentSession> => {
		const apiKey = await opts.getApiKey(opts.provider);
		if (apiKey) authStorage.setRuntimeApiKey(model.provider, apiKey);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const configuredPrompt = typeof opts.systemPrompt === "function" ? opts.systemPrompt() : opts.systemPrompt;
		const channelPrompt = [configuredPrompt, curatedMemoryPrompt(agentDir, source), channelContextFor(source)].filter(Boolean).join("\n\n");
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			appendSystemPromptOverride: (base) => [...base, channelPrompt],
			skillsOverride: (base) => ({ ...base, skills: filterEligibleSkills(base.skills, opts.skillToolset) }),
		});
		await resourceLoader.reload();
		const sessionManager = await restoreOrCreateSession(cwd, sessionDir, sessionId);
		let sessionRef: AgentSession | undefined;
		const customTools = opts.createTools(
			source,
			() => markRuntimeResourcesChanged(sessionRef),
			(provider) => authStorage.getApiKey(provider, { includeFallback: false }),
			(names) => sessionRef?.setActiveToolsByName([...new Set([...sessionRef.getActiveToolNames(), "capability_discover", ...names])]),
		);
		const policies = new ToolPolicyRegistry(customTools);
		policies.enable(opts.tools ?? [
			"read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_extract",
			...customTools.map((tool) => tool.name),
		]);
		const governedTools = customTools.map((tool) => governToolDefinition(tool, policies.get(tool.name), source, opts.toolAudit));
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd, agentDir, model,
			tools: policies.enabledNames(),
			customTools: governedTools, authStorage, modelRegistry, settingsManager, resourceLoader, sessionManager,
		});
		sessionRef = session;
		if (modelFallbackMessage) console.warn(`[beemax] ${modelFallbackMessage}`);
		installSecurityHook(session, cwd, source, opts.authorizeTool, policies, opts.toolAudit);
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

async function restoreOrCreateSession(cwd: string, sessionDir: string, sessionId: string): Promise<SessionManager> {
	const suffix = `_${sessionId}.jsonl`;
	let matchingFiles: string[] = [];
	try { matchingFiles = (await readdir(sessionDir)).filter((name) => name.endsWith(suffix)).sort().reverse(); } catch { /* SessionManager recreates a removed directory. */ }
	return matchingFiles[0] ? SessionManager.open(join(sessionDir, matchingFiles[0]), sessionDir, cwd) : SessionManager.create(cwd, sessionDir, { id: sessionId });
}

function installSecurityHook<Source extends BeeMaxRuntimeSource>(session: AgentSession, cwd: string, source: Source, authorizeTool: BeeMaxRuntimeAuthorization<Source> | undefined, policies: ToolPolicyRegistry, audit?: ToolRuntimeAuditSink): void {
	const previous = session.agent.beforeToolCall;
	session.agent.beforeToolCall = async (context, signal) => {
		const priorResult = await previous?.(context, signal);
		if (priorResult?.block) return priorResult;
		const hardBlock = hardBlockReason(context.toolCall.name, context.args, cwd);
		const policy = policies.get(context.toolCall.name);
		if (hardBlock) { audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason: hardBlock }); return { block: true, reason: hardBlock }; }
		if (policy.approval === "never") return priorResult;
		audit?.({ phase: "requested", source, toolName: context.toolCall.name, policy, at: Date.now() });
		if (!authorizeTool) { const reason = "This mutating tool requires an approval handler in the current channel"; audit?.({ phase: "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason }); return { block: true, reason }; }
		const decision = await authorizeTool(source, context.toolCall.name, context.args, policy, signal);
		audit?.({ phase: decision.allowed ? "allowed" : "blocked", source, toolName: context.toolCall.name, policy, at: Date.now(), reason: decision.reason });
		return decision.allowed ? priorResult : { block: true, reason: decision.reason ?? "Tool call was not approved" };
	};
}

function hardBlockReason(toolName: string, args: unknown, cwd: string): string | undefined {
	const input = asRecord(args);
	if (new Set(["read", "edit", "write", "grep", "find", "ls"]).has(toolName) && typeof input.path === "string") {
		const candidate = resolve(cwd, input.path);
		const rel = relative(cwd, candidate);
		if (rel === ".." || rel.startsWith(`..${sep}`) || (isAbsolute(rel) && candidate !== cwd)) return `Tool path is outside the configured workspace: ${input.path}`;
		const normalized = candidate.replaceAll("\\", "/").toLowerCase();
		const name = basename(normalized);
		if (/^\.env(?:\.(?!example$|sample$).+)?$/.test(name) || normalized.includes("/.ssh/") || normalized.includes("/.aws/credentials") || normalized.includes("/.config/gcloud/") || name === "auth.json" || name === "credentials.json") return `Access to sensitive credential file is blocked: ${input.path}`;
	}
	if (toolName === "bash" && typeof input.command === "string") {
		for (const rule of [/\brm\s+[^\n]*(?:-rf|-fr)[^\n]*\s\/(?:\s|$)/i, /\b(?:mkfs|fdisk|parted)\b/i, /\bdd\b[^\n]*\bof=\/dev\//i, /\b(?:shutdown|reboot|poweroff|halt)\b/i, /:\(\)\s*\{\s*:\|:&\s*;\s*\}\s*;/]) if (rule.test(input.command)) return "Refusing a destructive host command";
	}
	return undefined;
}

function resolveModel(provider: string, modelId: string, baseUrl?: string, customProtocol: "openai-completions" | "openai-responses" | "anthropic-messages" = "openai-completions"): Model<Api> {
	if (provider === "custom") {
		if (!baseUrl) throw new Error("Custom OpenAI-compatible models require a Base URL");
		return {
			id: modelId,
			name: modelId,
			api: customProtocol,
			provider: customProtocol === "anthropic-messages" ? "anthropic" : "openai",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		};
	}
	const get = getBuiltinModel as <P extends string, M extends string>(p: P, m: M) => Model<Api>;
	const model = get(provider, modelId);
	if (!model) throw new Error(`Could not resolve model ${provider}/${modelId} from the BeeMax runtime catalog`);
	return model;
}

function channelContextFor(source: BeeMaxRuntimeSource): string {
	const parts = ["# Channel context", `platform: ${source.platform}`];
	parts.push(source.chatType === "dm" ? `chat: direct message with ${source.userName ?? source.userIdAlt ?? source.userId ?? "user"}` : `chat: ${source.chatType} ${source.chatName ?? source.chatId}`);
	if (source.isBot) parts.push("sender: bot");
	return parts.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function arrayOfStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []; }

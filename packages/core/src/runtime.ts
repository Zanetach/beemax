import { existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
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

export interface BeeMaxRuntimeSource {
	platform: "feishu" | "cli";
	chatId: string;
	chatType: "dm" | "group" | "channel" | "thread";
	chatName?: string;
	userId?: string;
	userIdAlt?: string;
	userName?: string;
	threadId?: string;
	isBot?: boolean;
}

export interface BeeMaxRuntimeAuthorization {
	(source: BeeMaxRuntimeSource, toolName: string, args: unknown, signal?: AbortSignal): Promise<{ allowed: boolean; reason?: string }>;
}

export interface BeeMaxRuntimeFactoryOptions {
	provider: string;
	model: string;
	baseUrl?: string;
	cwd: string;
	agentDir: string;
	getApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
	systemPrompt: string | (() => string);
	skillToolset: "safe" | "standard";
	tools?: string[];
	createTools: (source: BeeMaxRuntimeSource, onResourcesChanged: () => void, getRuntimeApiKey: (provider: string) => Promise<string | undefined>) => ToolDefinition[];
	authorizeTool?: BeeMaxRuntimeAuthorization;
	approvalTools?: Iterable<string>;
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
export function buildBeeMaxRuntimeFactory(opts: BeeMaxRuntimeFactoryOptions) {
	const cwd = resolve(opts.cwd);
	const agentDir = resolve(opts.agentDir);
	const sessionDir = join(agentDir, "sessions", "feishu");
	mkdirSync(sessionDir, { recursive: true });
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const resolvedModel = resolveModel(opts.provider, opts.model, opts.baseUrl);
	const model = opts.baseUrl ? { ...resolvedModel, baseUrl: opts.baseUrl } : resolvedModel;
	const approvalTools = new Set(["bash", "edit", "write", ...(opts.approvalTools ?? [])]);

	return async (sessionId: string, source: BeeMaxRuntimeSource): Promise<AgentSession> => {
		const apiKey = await opts.getApiKey(opts.provider);
		if (apiKey) authStorage.setRuntimeApiKey(model.provider, apiKey);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const configuredPrompt = typeof opts.systemPrompt === "function" ? opts.systemPrompt() : opts.systemPrompt;
		const channelPrompt = [configuredPrompt, channelContextFor(source)].filter(Boolean).join("\n\n");
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
		);
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd, agentDir, model,
			tools: opts.tools ?? [
				"read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_extract",
				...customTools.map((tool) => tool.name),
			],
			customTools, authStorage, modelRegistry, settingsManager, resourceLoader, sessionManager,
		});
		sessionRef = session;
		if (modelFallbackMessage) console.warn(`[beemax] ${modelFallbackMessage}`);
		installSecurityHook(session, cwd, source, opts.authorizeTool, approvalTools);
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

function installSecurityHook(session: AgentSession, cwd: string, source: BeeMaxRuntimeSource, authorizeTool: BeeMaxRuntimeAuthorization | undefined, approvalTools: ReadonlySet<string>): void {
	const previous = session.agent.beforeToolCall;
	session.agent.beforeToolCall = async (context, signal) => {
		const priorResult = await previous?.(context, signal);
		if (priorResult?.block) return priorResult;
		const hardBlock = hardBlockReason(context.toolCall.name, context.args, cwd);
		if (hardBlock) return { block: true, reason: hardBlock };
		if (!approvalTools.has(context.toolCall.name)) return priorResult;
		if (!authorizeTool) return { block: true, reason: "This mutating tool requires an approval handler in the current channel" };
		const decision = await authorizeTool(source, context.toolCall.name, context.args, signal);
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

function resolveModel(provider: string, modelId: string, baseUrl?: string): Model<Api> {
	if (provider === "custom") {
		if (!baseUrl) throw new Error("Custom OpenAI-compatible models require a Base URL");
		return {
			id: modelId,
			name: modelId,
			api: "openai-completions",
			provider: "openai",
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

/**
 * BeeMax config. Loads from config/beemax.yaml + env overrides.
 *
 * Profile-owned model, runtime, and registry-based channel configuration.
 * Channel Secrets are resolved from protected Profile sources, never YAML.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { readEnvFileSync } from "./env-file.ts";
import { beemaxRoot, resolveProfileLocation, validateProfileName } from "./profile-home.ts";
import { resolveSoul } from "./soul.ts";
import { providerApiKeyEnv } from "./provider-resolver.ts";
import type { MemoryMembership } from "./memory-membership.ts";

export { beemaxHome, beemaxRoot, validateProfileName } from "./profile-home.ts";

export interface FeishuConfig {
	appId: string;
	appSecret: string;
	domain: "feishu" | "lark";
	requireMention: boolean;
	allowedUsers: string[];
	allowedChats: string[];
	allowAllUsers: boolean;
	groupPolicy: "open" | "allowlist" | "disabled";
	groupRules: Record<string, { policy?: "open" | "allowlist" | "blacklist" | "admin_only" | "disabled"; allowlist?: string[]; blacklist?: string[]; requireMention?: boolean }>;
	admins: string[];
	homeChatId?: string;
	homeUserId?: string;
	homeChatType?: "dm" | "group";
	connectionMode: "websocket" | "webhook";
	webhookHost: string;
	webhookPort: number;
	webhookPath: string;
	webhookVerificationToken?: string;
	webhookEncryptKey?: string;
	textBatchDelayMs: number;
	textBatchSplitDelayMs: number;
	textBatchMaxMessages: number;
	textBatchMaxChars: number;
	mediaBatchDelayMs: number;
	retryBaseDelayMs: number;
}
export interface TelegramConfig {
	botToken: string;
	allowedUsers: string[];
	allowedChats: string[];
	allowAllUsers: boolean;
	pollingTimeoutSeconds: number;
	retryBaseDelayMs: number;
}

/** Non-secret, registry-routed channel declaration. Adapter secrets stay in the Profile secret environment or Vault. */
export interface GatewayChannelConfig {
	id: string;
	adapter: string;
	enabled: boolean;
	credentialRef?: string;
	settings: Record<string, unknown>;
}
export type CustomProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface KnowledgeSpaceConfig {
	id: string;
	name: string;
	knowledgeBaseId: string;
}

export interface BeeMaxConfig {
	profile: string;
	agent: {
		systemPrompt?: string;
		reasoningDisplay: "off" | "summary" | "raw";
		toolset: "safe" | "standard";
		maxSessions: number;
		sessionIdleMs: number;
	};
	model: {
		provider: string;
		model: string;
		apiKey?: string;
		apiKeys: Record<string, string>;
		baseUrl?: string;
		customProtocol?: CustomProtocol;
		contextWindow?: number;
		maxTokens?: number;
	};
	models: Array<{ provider: string; model: string; baseUrl?: string; customProtocol?: CustomProtocol; contextWindow?: number; maxTokens?: number }>;
	/** Profile-owned channel configuration. A Profile may run its own Gateway. */
	gateway: { channels: GatewayChannelConfig[]; feishu: FeishuConfig; telegram: TelegramConfig };
	memory: {
		dbPath: string;
		memberships: MemoryMembership[];
	};
	credentials: { vaultPath: string; keyPath: string; key?: string };
	mcp: {
		configPath: string;
	};
	knowledge: {
		enabled: boolean;
		provider: "weknora";
		baseUrl: string;
		apiKey?: string;
		spaces: KnowledgeSpaceConfig[];
	};
	imageGeneration: {
		enabled: boolean;
		provider: "openai-codex";
		quality: "low" | "medium" | "high";
		outputDir: string;
	};
	mediaUnderstanding: {
		localOcr: {
			enabled: boolean;
			command?: string;
			languages?: string;
			timeoutMs: number;
		};
		auxiliaryVisionEnabled: boolean;
	};
	context: {
		maxTurnChars: number;
		maxToolResultTokens: number;
		compaction: { enabled: boolean; reserveTokens?: number; keepRecentTokens?: number };
	};
	execution: {
		backend: "local" | "docker";
		mode: "off" | "all";
		workspaceAccess: "none" | "ro" | "rw";
		image: string;
		timeoutMs: number;
	};
	subagents: {
		enabled: boolean;
		maxConcurrent: number;
		maxChildrenPerOwner: number;
		timeoutMs: number;
	};
	automation: {
		enabled: boolean;
		timezone: string;
		heartbeat: {
			enabled: boolean;
			every: string;
			platform: string;
			chatId?: string;
			userId?: string;
			prompt: string;
			ackMaxChars: number;
			timeoutMs: number;
			activeHours?: { start: string; end: string; timezone?: string };
		};
	};
	paths: {
		agentDir: string;
		cwd: string;
	};
}

export function loadConfig(configPath?: string, profile = "default"): BeeMaxConfig {
	validateProfileName(profile);
	const root = beemaxRoot();
	const location = resolveProfileLocation(profile, configPath);
	const path = location.configPath;
	const envPath = location.envPath;
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// config file optional; env-only mode
	}
	const cfg = (raw ? parseYaml(raw) : {}) as Partial<BeeMaxConfig> & { feishu?: Partial<FeishuConfig> };
	// Profile credentials and runtime policy win over ambient shell variables.
	// BEEMAX_HOME/PROFILE are resolved before this point and remain explicit routing inputs.
	const profileEnv = readEnvFileSync(envPath);
	const env = location.isHome ? profileEnv : process.env;
	const configuredChannels = parseGatewayChannels(cfg.gateway?.channels);
	const configuredFeishuChannel = configuredChannels.find((channel) => channel.adapter === "feishu");
	const configuredTelegramChannel = configuredChannels.find((channel) => channel.adapter === "telegram");
	const configuredFeishu = {
		...(cfg.gateway?.feishu ?? cfg.feishu),
		...(configuredFeishuChannel?.settings ?? {}),
	} as Partial<FeishuConfig>;

	const appId = str(env.FEISHU_APP_ID);
	const appSecret = str(env.FEISHU_APP_SECRET);

	const provider = str(env.BEEMAX_PROVIDER ?? cfg.model?.provider ?? "anthropic");
	const model = str(env.BEEMAX_MODEL ?? cfg.model?.model ?? "claude-sonnet-4-5");
	const apiKey = str(env[providerApiKeyEnv(provider)] ?? env.BEEMAX_API_KEY ?? cfg.model?.apiKey);
	const customProtocol = parseCustomProtocol(cfg.model?.customProtocol);
	const contextWindow = provider === "custom" ? optionalBoundedNumber(env.BEEMAX_MODEL_CONTEXT_WINDOW ?? cfg.model?.contextWindow, 8_000, 10_000_000) : undefined;
	const maxTokens = provider === "custom" ? optionalBoundedNumber(env.BEEMAX_MODEL_MAX_TOKENS ?? cfg.model?.maxTokens, 256, 1_000_000) : undefined;
	const configuredModels = modelChoices(cfg.models, { provider, model, baseUrl: cfg.model?.baseUrl, customProtocol, contextWindow, maxTokens });
	const apiKeys = Object.fromEntries(
		[...new Set(configuredModels.map((choice) => choice.provider))]
			.map((candidate) => [candidate, str(env[providerApiKeyEnv(candidate)] ?? (candidate === provider ? env.BEEMAX_API_KEY : ""))])
			.filter(([, key]) => Boolean(key)),
	);

	const profileDataRoot = location.isHome
		? location.homePath
		: join(root, profile === "default" ? "data" : `data/profiles/${profile}`);
	const storedSoul = location.isHome && existsSync(location.soulPath) ? readFileSync(location.soulPath, "utf8") : "";
	const soul = resolveSoul(storedSoul || env.BEEMAX_SYSTEM_PROMPT || cfg.agent?.systemPrompt);
	const feishuAllowedUsers = parseList(env.FEISHU_ALLOWED_USERS ?? configuredFeishu?.allowedUsers);
	const configuredAdmins = parseList(env.FEISHU_ADMINS ?? configuredFeishu?.admins);
	const feishu: FeishuConfig = {
		appId,
		appSecret,
		domain: (env.FEISHU_DOMAIN ?? configuredFeishu?.domain ?? "feishu") === "lark" ? "lark" : "feishu",
		requireMention: parseBool(env.FEISHU_REQUIRE_MENTION ?? configuredFeishu?.requireMention ?? true),
		allowedUsers: feishuAllowedUsers,
		allowedChats: parseList(env.FEISHU_ALLOWED_CHATS ?? configuredFeishu?.allowedChats),
		allowAllUsers: parseBool(env.FEISHU_ALLOW_ALL_USERS ?? configuredFeishu?.allowAllUsers ?? false),
		groupPolicy: parseGroupPolicy(env.FEISHU_GROUP_POLICY ?? configuredFeishu?.groupPolicy),
		groupRules: parseGroupRules(configuredFeishu?.groupRules),
		admins: configuredAdmins.length ? configuredAdmins : feishuAllowedUsers,
		homeChatId: optional(env.FEISHU_HOME_CHANNEL ?? configuredFeishu?.homeChatId),
		homeUserId: optional(env.FEISHU_HOME_USER ?? configuredFeishu?.homeUserId),
		homeChatType: configuredFeishu?.homeChatType === "group" ? "group" : configuredFeishu?.homeChatId ? "dm" : undefined,
		connectionMode: (env.FEISHU_CONNECTION_MODE ?? configuredFeishu?.connectionMode ?? "websocket") === "webhook" ? "webhook" : "websocket",
		webhookHost: str(env.FEISHU_WEBHOOK_HOST ?? configuredFeishu?.webhookHost ?? "127.0.0.1"),
		webhookPort: Number(env.FEISHU_WEBHOOK_PORT ?? configuredFeishu?.webhookPort ?? 8787),
		webhookPath: str(env.FEISHU_WEBHOOK_PATH ?? configuredFeishu?.webhookPath ?? "/feishu/events"),
		webhookVerificationToken: str(env.FEISHU_WEBHOOK_VERIFICATION_TOKEN ?? configuredFeishu?.webhookVerificationToken ?? "") || undefined,
		webhookEncryptKey: str(env.FEISHU_WEBHOOK_ENCRYPT_KEY ?? configuredFeishu?.webhookEncryptKey ?? "") || undefined,
		textBatchDelayMs: boundedNumber(env.FEISHU_TEXT_BATCH_DELAY_MS ?? configuredFeishu?.textBatchDelayMs, 600, 0, 60_000),
		textBatchSplitDelayMs: boundedNumber(env.FEISHU_TEXT_BATCH_SPLIT_DELAY_MS ?? configuredFeishu?.textBatchSplitDelayMs, 2_000, 0, 60_000),
		textBatchMaxMessages: boundedNumber(env.FEISHU_TEXT_BATCH_MAX_MESSAGES ?? configuredFeishu?.textBatchMaxMessages, 8, 1, 1_000),
		textBatchMaxChars: boundedNumber(env.FEISHU_TEXT_BATCH_MAX_CHARS ?? configuredFeishu?.textBatchMaxChars, 4_000, 1, 100_000),
		mediaBatchDelayMs: boundedNumber(env.FEISHU_MEDIA_BATCH_DELAY_MS ?? configuredFeishu?.mediaBatchDelayMs, 800, 0, 60_000),
		retryBaseDelayMs: boundedNumber(env.FEISHU_RETRY_BASE_DELAY_MS ?? configuredFeishu?.retryBaseDelayMs, 1_000, 0, 30_000),
	};
	const configuredTelegram = configuredTelegramChannel?.settings ?? {};
	const telegram: TelegramConfig = {
		botToken: str(env.TELEGRAM_BOT_TOKEN),
		allowedUsers: parseList(env.TELEGRAM_ALLOWED_USERS ?? configuredTelegram.allowedUsers),
		allowedChats: parseList(env.TELEGRAM_ALLOWED_CHATS ?? configuredTelegram.allowedChats),
		allowAllUsers: parseBool(env.TELEGRAM_ALLOW_ALL_USERS ?? configuredTelegram.allowAllUsers ?? false),
		pollingTimeoutSeconds: boundedNumber(env.TELEGRAM_POLLING_TIMEOUT_SECONDS ?? configuredTelegram.pollingTimeoutSeconds, 25, 1, 50),
		retryBaseDelayMs: boundedNumber(env.TELEGRAM_RETRY_BASE_DELAY_MS ?? configuredTelegram.retryBaseDelayMs, 1_000, 0, 30_000),
	};
	const channels = cfg.gateway?.channels === undefined
		? [
			...(feishu.appId && feishu.appSecret ? [{ id: "feishu-main", adapter: "feishu", enabled: true, credentialRef: "profile-env:feishu", settings: {} }] : []),
			...(telegram.botToken ? [{ id: "telegram-main", adapter: "telegram", enabled: true, credentialRef: "profile-env:telegram", settings: {} }] : []),
		] satisfies GatewayChannelConfig[]
		: configuredChannels;
	return {
		profile,
		agent: {
			systemPrompt: soul,
			reasoningDisplay: reasoningDisplay(env.BEEMAX_REASONING_DISPLAY ?? cfg.agent?.reasoningDisplay),
			toolset: (env.BEEMAX_TOOLSET ?? cfg.agent?.toolset) === "safe" ? "safe" : "standard",
			maxSessions: parseNumber(env.BEEMAX_MAX_SESSIONS ?? cfg.agent?.maxSessions, 100),
			sessionIdleMs: parseNumber(env.BEEMAX_SESSION_IDLE_MS ?? cfg.agent?.sessionIdleMs, 30 * 60_000),
		},
		model: {
			provider,
			model,
			apiKey,
			apiKeys,
			baseUrl: cfg.model?.baseUrl,
			customProtocol: provider === "custom" ? customProtocol : undefined,
			contextWindow,
			maxTokens,
		},
		models: configuredModels,
		gateway: { channels, feishu, telegram },
		memory: {
			dbPath: resolveFrom(location.basePath, str(env.BEEMAX_DB_PATH ?? cfg.memory?.dbPath ?? join(profileDataRoot, location.isHome ? "memory.db" : "beemax.db"))),
			memberships: parseMemoryMemberships(cfg.memory?.memberships),
		},
		credentials: {
			vaultPath: resolveFrom(location.basePath, str(env.BEEMAX_CREDENTIAL_VAULT_PATH ?? join(profileDataRoot, "credentials.vault"))),
			keyPath: join(profileDataRoot, "state", "credential-vault.key"),
			key: optional(env.BEEMAX_CREDENTIAL_VAULT_KEY) ?? optional(readFileIfPresent(join(profileDataRoot, "state", "credential-vault.key"))),
		},
		mcp: {
			configPath: resolveFrom(location.basePath, str(env.BEEMAX_MCP_CONFIG ?? cfg.mcp?.configPath ?? (location.isHome ? "mcp.json" : profile === "default" ? "config/mcp.json" : `config/profiles/${profile}.mcp.json`))),
		},
		knowledge: {
			enabled: parseBool(env.BEEMAX_KNOWLEDGE_ENABLED ?? cfg.knowledge?.enabled ?? false),
			provider: "weknora",
			baseUrl: str(env.BEEMAX_WEKNORA_BASE_URL ?? cfg.knowledge?.baseUrl ?? "http://127.0.0.1:8080"),
			apiKey: optional(env.BEEMAX_WEKNORA_API_KEY),
			spaces: parseKnowledgeSpaces(cfg.knowledge?.spaces),
		},
		imageGeneration: {
			enabled: parseBool(env.BEEMAX_IMAGE_ENABLED ?? cfg.imageGeneration?.enabled ?? false),
			provider: "openai-codex",
			quality: parseImageQuality(env.BEEMAX_IMAGE_QUALITY ?? cfg.imageGeneration?.quality),
			outputDir: resolveFrom(location.basePath, str(env.BEEMAX_IMAGE_OUTPUT_DIR ?? cfg.imageGeneration?.outputDir ?? join(profileDataRoot, "cache/images"))),
		},
		mediaUnderstanding: {
			localOcr: {
				enabled: parseBool(env.BEEMAX_LOCAL_OCR_ENABLED ?? cfg.mediaUnderstanding?.localOcr?.enabled ?? true),
				command: optional(env.BEEMAX_LOCAL_OCR_COMMAND ?? cfg.mediaUnderstanding?.localOcr?.command),
				languages: optional(env.BEEMAX_LOCAL_OCR_LANGUAGES ?? cfg.mediaUnderstanding?.localOcr?.languages),
				timeoutMs: boundedNumber(env.BEEMAX_LOCAL_OCR_TIMEOUT_MS ?? cfg.mediaUnderstanding?.localOcr?.timeoutMs, 30_000, 1_000, 300_000),
			},
			auxiliaryVisionEnabled: parseBool(env.BEEMAX_AUXILIARY_VISION_ENABLED ?? cfg.mediaUnderstanding?.auxiliaryVisionEnabled ?? true),
		},
		context: {
			maxTurnChars: boundedNumber(env.BEEMAX_CONTEXT_MAX_TURN_CHARS ?? cfg.context?.maxTurnChars, 12_000, 1_000, 100_000),
			maxToolResultTokens: boundedNumber(env.BEEMAX_MAX_TOOL_RESULT_TOKENS ?? cfg.context?.maxToolResultTokens, 12_000, 256, 1_000_000),
			compaction: {
				enabled: parseBool(env.BEEMAX_COMPACTION_ENABLED ?? cfg.context?.compaction?.enabled ?? true),
				reserveTokens: optionalBoundedNumber(env.BEEMAX_COMPACTION_RESERVE_TOKENS ?? cfg.context?.compaction?.reserveTokens, 1_024, 1_000_000),
				keepRecentTokens: optionalBoundedNumber(env.BEEMAX_COMPACTION_KEEP_RECENT_TOKENS ?? cfg.context?.compaction?.keepRecentTokens, 1_024, 1_000_000),
			},
		},
		execution: {
			backend: executionBackend(env.BEEMAX_EXECUTION_BACKEND ?? cfg.execution?.backend),
			mode: sandboxMode(env.BEEMAX_SANDBOX_MODE ?? cfg.execution?.mode),
			workspaceAccess: workspaceAccess(env.BEEMAX_SANDBOX_WORKSPACE_ACCESS ?? cfg.execution?.workspaceAccess),
			image: str(env.BEEMAX_SANDBOX_IMAGE ?? cfg.execution?.image ?? "node:22-alpine"),
			timeoutMs: parseNumber(env.BEEMAX_SANDBOX_TIMEOUT_MS ?? cfg.execution?.timeoutMs, 180_000),
		},
		subagents: {
			enabled: parseBool(env.BEEMAX_SUBAGENTS_ENABLED ?? cfg.subagents?.enabled ?? true),
			maxConcurrent: parseNumber(env.BEEMAX_SUBAGENTS_MAX_CONCURRENT ?? cfg.subagents?.maxConcurrent, 3),
			maxChildrenPerOwner: parseNumber(env.BEEMAX_SUBAGENTS_MAX_CHILDREN ?? cfg.subagents?.maxChildrenPerOwner, 5),
			timeoutMs: parseNumber(env.BEEMAX_SUBAGENTS_TIMEOUT_MS ?? cfg.subagents?.timeoutMs, 15 * 60_000),
		},
		automation: {
			enabled: parseBool(env.BEEMAX_AUTOMATION_ENABLED ?? cfg.automation?.enabled ?? true),
			timezone: str(env.BEEMAX_TIMEZONE ?? cfg.automation?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"),
			heartbeat: {
				enabled: parseBool(env.BEEMAX_HEARTBEAT_ENABLED ?? cfg.automation?.heartbeat?.enabled ?? true),
				every: str(env.BEEMAX_HEARTBEAT_EVERY ?? cfg.automation?.heartbeat?.every ?? "30m"),
				platform: str(env.BEEMAX_HEARTBEAT_PLATFORM ?? cfg.automation?.heartbeat?.platform ?? channels.find((channel) => channel.enabled)?.adapter ?? "feishu"),
				chatId: optional(env.BEEMAX_HEARTBEAT_CHAT_ID ?? cfg.automation?.heartbeat?.chatId ?? feishu.homeChatId),
				userId: optional(env.BEEMAX_HEARTBEAT_USER_ID ?? cfg.automation?.heartbeat?.userId ?? feishu.homeUserId),
				prompt: str(env.BEEMAX_HEARTBEAT_PROMPT ?? cfg.automation?.heartbeat?.prompt ?? DEFAULT_HEARTBEAT_PROMPT),
				ackMaxChars: parseNumber(env.BEEMAX_HEARTBEAT_ACK_MAX_CHARS ?? cfg.automation?.heartbeat?.ackMaxChars, 300),
				timeoutMs: parseNumber(env.BEEMAX_HEARTBEAT_TIMEOUT_MS ?? cfg.automation?.heartbeat?.timeoutMs, 120_000),
				activeHours: {
					start: str(env.BEEMAX_HEARTBEAT_ACTIVE_START ?? cfg.automation?.heartbeat?.activeHours?.start ?? "08:00"),
					end: str(env.BEEMAX_HEARTBEAT_ACTIVE_END ?? cfg.automation?.heartbeat?.activeHours?.end ?? "23:00"),
					timezone: str(env.BEEMAX_TIMEZONE ?? cfg.automation?.heartbeat?.activeHours?.timezone ?? cfg.automation?.timezone) || undefined,
				},
			},
		},
		paths: {
			agentDir: resolveFrom(location.basePath, str(env.BEEMAX_AGENT_DIR ?? cfg.paths?.agentDir ?? (location.isHome ? "." : join(profileDataRoot, "agent")))),
			cwd: resolveFrom(location.basePath, str(env.BEEMAX_CWD ?? cfg.paths?.cwd ?? (location.isHome ? root : "."))),
		},
	};
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function optionalBoundedNumber(value: unknown, min: number, max: number): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return boundedNumber(value, min, min, max);
}

function resolveFrom(root: string, path: string): string {
	return isAbsolute(path) ? path : resolve(root, path);
}

function readFileIfPresent(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }

const DEFAULT_HEARTBEAT_PROMPT = "Read HEARTBEAT.md if it exists in the workspace and follow it strictly. Review due reminders, scheduled work, recent failures, and anything that genuinely needs the user's attention. Do not infer or repeat stale tasks from old chats. If nothing needs attention, reply HEARTBEAT_OK.";


function str(v: unknown): string {
	return (typeof v === "string" ? v : "")?.trim();
}
function parseBool(v: unknown): boolean {
	if (typeof v === "boolean") return v;
	return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function parseKnowledgeSpaces(value: unknown): KnowledgeSpaceConfig[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("knowledge.spaces must be an array");
	const seen = new Set<string>();
	return value.map((entry, index) => {
		if (!entry || typeof entry !== "object") throw new Error(`knowledge.spaces[${index}] must be an object`);
		const record = entry as Record<string, unknown>;
		const id = str(record.id);
		const name = str(record.name);
		const knowledgeBaseId = str(record.knowledgeBaseId);
		if (!id || !name || !knowledgeBaseId) throw new Error(`knowledge.spaces[${index}] requires id, name, and knowledgeBaseId`);
		if (seen.has(id)) throw new Error(`knowledge.spaces contains duplicate id: ${id}`);
		seen.add(id);
		return { id, name, knowledgeBaseId };
	});
}

function optional(value: unknown): string | undefined {
	const valueString = str(value);
	return valueString || undefined;
}
function parseImageQuality(value: unknown): "low" | "medium" | "high" {
	return value === "low" || value === "high" ? value : "medium";
}
function reasoningDisplay(value: unknown): "off" | "summary" | "raw" {
	return value === "off" || value === "raw" ? value : "summary";
}
function executionBackend(value: unknown): "local" | "docker" { return value === "docker" ? "docker" : "local"; }
function sandboxMode(value: unknown): "off" | "all" { return value === "all" ? "all" : "off"; }
function workspaceAccess(value: unknown): "none" | "ro" | "rw" { return value === "rw" || value === "ro" ? value : "none"; }
function parseNumber(value: unknown, fallback: number): number {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function parseList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
	return String(value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseGatewayChannels(value: unknown): GatewayChannelConfig[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error("gateway.channels must be an array");
	const ids = new Set<string>();
	return value.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`gateway.channels[${index}] must be an object`);
		const candidate = entry as Record<string, unknown>;
		const id = str(candidate.id);
		const adapter = str(candidate.adapter);
		if (!id || !adapter) throw new Error(`gateway.channels[${index}] requires id and adapter`);
		if (ids.has(id)) throw new Error(`gateway.channels contains duplicate id: ${id}`);
		ids.add(id);
		const rawSettings = candidate.settings;
		if (rawSettings !== undefined && (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings))) {
			throw new Error(`gateway.channels[${index}].settings must be an object`);
		}
		const settings = structuredClone((rawSettings ?? {}) as Record<string, unknown>);
		assertNoChannelSecrets(settings, `gateway.channels[${index}].settings`);
		const enabled = candidate.enabled === undefined ? true : parseBool(candidate.enabled);
		const credentialRef = optional(candidate.credentialRef);
		if (enabled && (adapter === "feishu" || adapter === "telegram") && !credentialRef) {
			throw new Error(`gateway.channels[${index}].credentialRef is required for ${adapter}`);
		}
		return {
			id,
			adapter,
			enabled,
			...(credentialRef ? { credentialRef } : {}),
			settings,
		};
	});
}

function assertNoChannelSecrets(value: unknown, path: string): void {
	if (!value || typeof value !== "object") return;
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (/(?:secret|token|password|api[_-]?key|private[_-]?key)$/i.test(key)) {
			throw new Error(`${path}.${key} must use credentialRef and the Profile secret environment or Vault`);
		}
		assertNoChannelSecrets(nested, `${path}.${key}`);
	}
}

export function parseMemoryMemberships(value: unknown): MemoryMembership[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error("memory.memberships must be an array");
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`memory.memberships[${index}] must be an object`);
		const candidate = item as Record<string, unknown>;
		const platform = str(candidate.platform);
		const userId = str(candidate.userId);
		if (!platform || !userId) throw new Error(`memory.memberships[${index}] requires platform and userId`);
		return { platform, userId, projectId: optional(candidate.projectId), organizationId: optional(candidate.organizationId) };
	});
}

function parseGroupPolicy(value: unknown): "open" | "allowlist" | "disabled" { return value === "open" || value === "disabled" ? value : "allowlist"; }
function parseGroupRules(value: unknown): FeishuConfig["groupRules"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: FeishuConfig["groupRules"] = {};
	for (const [chatId, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!chatId || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const rule = raw as Record<string, unknown>;
		const policy = ["open", "allowlist", "blacklist", "admin_only", "disabled"].includes(String(rule.policy)) ? rule.policy as FeishuConfig["groupRules"][string]["policy"] : undefined;
		result[chatId] = { policy, allowlist: parseList(rule.allowlist), blacklist: parseList(rule.blacklist), ...(typeof rule.requireMention === "boolean" ? { requireMention: rule.requireMention } : {}) };
	}
	return result;
}

function modelChoices(value: unknown, active: { provider: string; model: string; baseUrl?: string; customProtocol?: CustomProtocol; contextWindow?: number; maxTokens?: number }): Array<{ provider: string; model: string; baseUrl?: string; customProtocol?: CustomProtocol; contextWindow?: number; maxTokens?: number }> {
	const items = Array.isArray(value) ? value : [];
	const choices = items.filter(isModelChoice);
	return [{ ...active }, ...choices.filter((item) => item.provider !== active.provider || item.model !== active.model || item.baseUrl !== active.baseUrl)];
}

function isModelChoice(value: unknown): value is { provider: string; model: string; baseUrl?: string; customProtocol?: CustomProtocol; contextWindow?: number; maxTokens?: number } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.provider === "string" && typeof candidate.model === "string" && (candidate.baseUrl === undefined || typeof candidate.baseUrl === "string") && (candidate.customProtocol === undefined || parseCustomProtocol(candidate.customProtocol) === candidate.customProtocol) && (candidate.contextWindow === undefined || Number.isFinite(candidate.contextWindow)) && (candidate.maxTokens === undefined || Number.isFinite(candidate.maxTokens));
}
function parseCustomProtocol(value: unknown): CustomProtocol { return value === "anthropic-messages" || value === "openai-responses" ? value : "openai-completions"; }

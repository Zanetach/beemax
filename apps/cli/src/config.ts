/**
 * BeeMax config. Loads from config/beemax.yaml + env overrides.
 *
 * Profile-owned model, runtime, and registry-based channel configuration.
 * Channel Secrets are resolved from protected Profile sources, never YAML.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { readEnvFileSync } from "./env-file.ts";
import { beemaxRoot, resolveProfileLocation, validateProfileName } from "./profile-home.ts";
import { resolveSoul } from "./soul.ts";
import { providerApiKeyEnv } from "./provider-resolver.ts";
import type { MemoryMembership } from "./memory-membership.ts";
import type { FeishuActivationSettings, FeishuGroupRule } from "@beemax/channel-feishu";
import { DEFAULT_DOCKER_SANDBOX_IMAGE, DEFAULT_RUNTIME_RESOURCE_LIMITS, resolveRuntimeTaskConcurrency } from "@beemax/core";
import { artifactSiteLocalBaseUrl, validateArtifactSiteListen, validateArtifactSitePublicBaseUrl } from "./artifact-site.ts";

export { beemaxHome, beemaxRoot, validateProfileName } from "./profile-home.ts";

export interface FeishuConfig {
	domain: "feishu" | "lark";
	requireMention: boolean;
	activation: FeishuActivationSettings;
	allowedUsers: string[];
	allowedChats: string[];
	allowAllUsers: boolean;
	groupPolicy: "open" | "allowlist" | "disabled";
	groupRules: Record<string, FeishuGroupRule>;
	admins: string[];
	homeChatId?: string;
	homeUserId?: string;
	homeChatType?: "dm" | "group";
	connectionMode: "websocket" | "webhook";
	webhookHost: string;
	webhookPort: number;
	webhookPath: string;
	textBatchDelayMs: number;
	textBatchSplitDelayMs: number;
	textBatchMaxMessages: number;
	textBatchMaxChars: number;
	mediaBatchDelayMs: number;
	retryBaseDelayMs: number;
}
export interface TelegramConfig {
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
	accountRef?: string;
	enabled: boolean;
	credentialRef?: string;
	settings: Record<string, unknown>;
}
export interface GatewayBindingConfig {
	id: string;
	profileId: string;
	channelInstanceId: string;
	accountRef?: string;
	conversationId?: string;
	threadId?: string;
	enabled: boolean;
}
export interface ArtifactSiteConfig {
	enabled: boolean;
	command: string;
	listen: string;
	publicBaseUrl: string;
}
export type GatewayChannelCredential =
	| { adapter: "feishu"; appId: string; appSecret: string; webhookVerificationToken?: string; webhookEncryptKey?: string }
	| { adapter: "telegram"; botToken: string };
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
		/** Optional generic preference weights keyed by name or kind:name; never grants authority. */
		capabilityPreferences: Record<string, number>;
		capabilityCognition: { maxModelAttempts: number; maxTokens: number; timeoutMs: number };
	};
	capabilityProviders: {
		installation: { enabled: boolean; allowedProviders: string[] };
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
	gateway: {
		channels: GatewayChannelConfig[];
		bindings: GatewayBindingConfig[];
		ingress: { maxActive: number; maxActivePerConversation: number };
		observation: { retainPerLane: number; minRelevance: number; minCredibility: number; minExpectedValue: number; minConfidence: number; evaluationTimeoutMs: number; maxActiveEvaluations: number; maxActivePerLane: number };
		proactiveDelivery: { quietHours?: FeishuActivationSettings["quietHours"]; maxDeliveriesPerWindow: number; deliveryWindowMs: number; maxTrackedLanes: number };
		artifactSite: ArtifactSiteConfig;
		feishu: FeishuConfig;
		telegram: TelegramConfig;
	};
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
		workspaceWritePolicy: "approval-required" | "allow-within-workspace";
		taskGrantCapabilities: string[];
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
			channelInstanceId?: string;
			chatId?: string;
			chatType?: "dm" | "group" | "channel" | "thread";
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
		profileEnvPath: string;
		channelCredentialEnvironment: "profile" | "ambient";
	};
}

/** Compile Profile execution policy into the capabilities seeded into each fresh Task grant. */
export function profileTaskGrantCapabilities(config: Pick<BeeMaxConfig, "execution">): readonly string[] {
	return [...new Set([
		...(config.execution.workspaceWritePolicy === "allow-within-workspace" ? ["write"] : []),
		...config.execution.taskGrantCapabilities,
	])];
}

/** Objectives terminate only through completion, explicit cancellation, or a visible unrecoverable failure. */
export function profileTurnTimeoutMs(_config: Pick<BeeMaxConfig, "subagents" | "execution">): null {
	return null;
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
	const requireMention = parseBool(env.FEISHU_REQUIRE_MENTION ?? configuredFeishu?.requireMention ?? true);
	const feishu: FeishuConfig = {
		domain: (env.FEISHU_DOMAIN ?? configuredFeishu?.domain ?? "feishu") === "lark" ? "lark" : "feishu",
		requireMention,
		activation: parseFeishuActivation(configuredFeishu?.activation, requireMention, env),
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
		textBatchDelayMs: boundedNumber(env.FEISHU_TEXT_BATCH_DELAY_MS ?? configuredFeishu?.textBatchDelayMs, 600, 0, 60_000),
		textBatchSplitDelayMs: boundedNumber(env.FEISHU_TEXT_BATCH_SPLIT_DELAY_MS ?? configuredFeishu?.textBatchSplitDelayMs, 2_000, 0, 60_000),
		textBatchMaxMessages: boundedNumber(env.FEISHU_TEXT_BATCH_MAX_MESSAGES ?? configuredFeishu?.textBatchMaxMessages, 8, 1, 1_000),
		textBatchMaxChars: boundedNumber(env.FEISHU_TEXT_BATCH_MAX_CHARS ?? configuredFeishu?.textBatchMaxChars, 4_000, 1, 100_000),
		mediaBatchDelayMs: boundedNumber(env.FEISHU_MEDIA_BATCH_DELAY_MS ?? configuredFeishu?.mediaBatchDelayMs, 800, 0, 60_000),
		retryBaseDelayMs: boundedNumber(env.FEISHU_RETRY_BASE_DELAY_MS ?? configuredFeishu?.retryBaseDelayMs, 1_000, 0, 30_000),
	};
	const configuredTelegram = configuredTelegramChannel?.settings ?? {};
	const telegramBotToken = str(env.TELEGRAM_BOT_TOKEN);
	const telegram: TelegramConfig = {
		allowedUsers: parseList(env.TELEGRAM_ALLOWED_USERS ?? configuredTelegram.allowedUsers),
		allowedChats: parseList(env.TELEGRAM_ALLOWED_CHATS ?? configuredTelegram.allowedChats),
		allowAllUsers: parseBool(env.TELEGRAM_ALLOW_ALL_USERS ?? configuredTelegram.allowAllUsers ?? false),
		pollingTimeoutSeconds: boundedNumber(env.TELEGRAM_POLLING_TIMEOUT_SECONDS ?? configuredTelegram.pollingTimeoutSeconds, 25, 1, 50),
		retryBaseDelayMs: boundedNumber(env.TELEGRAM_RETRY_BASE_DELAY_MS ?? configuredTelegram.retryBaseDelayMs, 1_000, 0, 30_000),
	};
	const channels = cfg.gateway?.channels === undefined
		? [
			...(appId && appSecret ? [{ id: "feishu-main", adapter: "feishu", enabled: true, credentialRef: "profile-env:feishu", settings: {} }] : []),
			...(telegramBotToken ? [{ id: "telegram-main", adapter: "telegram", enabled: true, credentialRef: "profile-env:telegram", settings: {} }] : []),
		] satisfies GatewayChannelConfig[]
		: configuredChannels;
	const bindings = parseGatewayBindings(cfg.gateway?.bindings, profile, channels);
	const ingress = {
		maxActive: boundedNumber(env.BEEMAX_GATEWAY_MAX_ACTIVE ?? cfg.gateway?.ingress?.maxActive, 1_000, 1, 100_000),
		maxActivePerConversation: boundedNumber(env.BEEMAX_GATEWAY_MAX_ACTIVE_PER_CONVERSATION ?? cfg.gateway?.ingress?.maxActivePerConversation, 100, 1, 10_000),
	};
	const observation = {
		retainPerLane: boundedNumber(
			env.BEEMAX_GROUP_OBSERVATION_RETAIN_PER_LANE
				?? cfg.gateway?.observation?.retainPerLane
				?? (cfg.gateway?.feishu?.activation as (Record<string, unknown> | undefined))?.observationRetainPerLane
				?? env.FEISHU_OBSERVATION_RETAIN_PER_LANE,
			100, 1, 10_000,
		),
		minRelevance: boundedScore(env.BEEMAX_GROUP_OBSERVATION_MIN_RELEVANCE ?? cfg.gateway?.observation?.minRelevance, 0.6),
		minCredibility: boundedScore(env.BEEMAX_GROUP_OBSERVATION_MIN_CREDIBILITY ?? cfg.gateway?.observation?.minCredibility, 0.4),
		minExpectedValue: boundedScore(env.BEEMAX_GROUP_OBSERVATION_MIN_EXPECTED_VALUE ?? cfg.gateway?.observation?.minExpectedValue, 0.6),
		minConfidence: boundedScore(env.BEEMAX_GROUP_OBSERVATION_MIN_CONFIDENCE ?? cfg.gateway?.observation?.minConfidence, 0.65),
		evaluationTimeoutMs: boundedNumber(env.BEEMAX_GROUP_OBSERVATION_EVALUATION_TIMEOUT_MS ?? cfg.gateway?.observation?.evaluationTimeoutMs, 15_000, 1_000, 120_000),
		maxActiveEvaluations: boundedNumber(env.BEEMAX_GROUP_OBSERVATION_MAX_ACTIVE_EVALUATIONS ?? cfg.gateway?.observation?.maxActiveEvaluations, 8, 1, 1_000),
		maxActivePerLane: boundedNumber(env.BEEMAX_GROUP_OBSERVATION_MAX_ACTIVE_PER_LANE ?? cfg.gateway?.observation?.maxActivePerLane, 1, 1, 100),
	};
	const proactiveQuietHours = parseQuietHours(cfg.gateway?.proactiveDelivery?.quietHours ?? feishu.activation.quietHours, env.BEEMAX_TIMEZONE);
	const proactiveDelivery = {
		...(proactiveQuietHours ? { quietHours: proactiveQuietHours } : {}),
		maxDeliveriesPerWindow: boundedNumber(env.BEEMAX_PROACTIVE_MAX_DELIVERIES_PER_WINDOW ?? cfg.gateway?.proactiveDelivery?.maxDeliveriesPerWindow ?? feishu.activation.maxRepliesPerWindow, 6, 1, 1_000),
		deliveryWindowMs: boundedNumber(env.BEEMAX_PROACTIVE_DELIVERY_WINDOW_MS ?? cfg.gateway?.proactiveDelivery?.deliveryWindowMs ?? feishu.activation.replyWindowMs, 60_000, 1_000, 24 * 60 * 60_000),
		maxTrackedLanes: boundedNumber(env.BEEMAX_PROACTIVE_MAX_TRACKED_LANES ?? cfg.gateway?.proactiveDelivery?.maxTrackedLanes ?? feishu.activation.maxTrackedResponseLanes, 10_000, 1, 100_000),
	};
	const artifactSiteListen = validateArtifactSiteListen(str(env.BEEMAX_ARTIFACT_SITE_LISTEN ?? cfg.gateway?.artifactSite?.listen ?? defaultArtifactSiteListen(profile)));
	const artifactSiteCommand = str(env.BEEMAX_ARTIFACT_SITE_COMMAND ?? cfg.gateway?.artifactSite?.command ?? defaultCaddyCommand());
	if (!artifactSiteCommand || /[\u0000-\u001f\u007f]/u.test(artifactSiteCommand)) throw new Error("Invalid gateway.artifactSite.command");
	const artifactSite: ArtifactSiteConfig = {
		enabled: parseBool(env.BEEMAX_ARTIFACT_SITE_ENABLED ?? cfg.gateway?.artifactSite?.enabled ?? false),
		command: artifactSiteCommand,
		listen: artifactSiteListen,
		publicBaseUrl: validateArtifactSitePublicBaseUrl(str(env.BEEMAX_ARTIFACT_SITE_PUBLIC_BASE_URL ?? cfg.gateway?.artifactSite?.publicBaseUrl ?? artifactSiteLocalBaseUrl(artifactSiteListen))),
	};
	const heartbeatPlatform = str(env.BEEMAX_HEARTBEAT_PLATFORM ?? cfg.automation?.heartbeat?.platform ?? channels.find((channel) => channel.enabled)?.adapter ?? "feishu");
	const heartbeatInstances = channels.filter((channel) => channel.enabled && channel.adapter === heartbeatPlatform);
	const heartbeatChannelInstanceId = optional(env.BEEMAX_HEARTBEAT_CHANNEL_INSTANCE_ID ?? cfg.automation?.heartbeat?.channelInstanceId) ?? (heartbeatInstances.length === 1 ? heartbeatInstances[0]!.id : undefined);
	const capabilityCognition = {
		maxModelAttempts: boundedConfiguredInteger(env.BEEMAX_CAPABILITY_COGNITION_MAX_ATTEMPTS ?? cfg.agent?.capabilityCognition?.maxModelAttempts, 3, 1, 5, "agent.capabilityCognition.maxModelAttempts"),
		maxTokens: boundedConfiguredInteger(env.BEEMAX_CAPABILITY_COGNITION_MAX_TOKENS ?? cfg.agent?.capabilityCognition?.maxTokens, 2_048, 256, 8_192, "agent.capabilityCognition.maxTokens"),
		// Capability cognition is an optional preflight lane, never the Objective
		// deadline. Fail it over quickly so Provider stalls cannot consume the
		// interactive report SLO; deterministic discovery continues the same Task.
		timeoutMs: boundedConfiguredInteger(env.BEEMAX_CAPABILITY_COGNITION_TIMEOUT_MS ?? cfg.agent?.capabilityCognition?.timeoutMs, 12_000, 1_000, 60_000, "agent.capabilityCognition.timeoutMs"),
	};
	return {
		profile,
		agent: {
			systemPrompt: soul,
			reasoningDisplay: reasoningDisplay(env.BEEMAX_REASONING_DISPLAY ?? cfg.agent?.reasoningDisplay),
			toolset: (env.BEEMAX_TOOLSET ?? cfg.agent?.toolset) === "safe" ? "safe" : "standard",
			maxSessions: parseNumber(env.BEEMAX_MAX_SESSIONS ?? cfg.agent?.maxSessions, 100),
			sessionIdleMs: parseNumber(env.BEEMAX_SESSION_IDLE_MS ?? cfg.agent?.sessionIdleMs, 30 * 60_000),
			capabilityPreferences: parseCapabilityPreferences(cfg.agent?.capabilityPreferences),
			capabilityCognition,
		},
		capabilityProviders: {
			installation: {
				enabled: parseBool(env.BEEMAX_PROVIDER_INSTALLATION_ENABLED ?? cfg.capabilityProviders?.installation?.enabled ?? false),
				allowedProviders: parseProviderIds(env.BEEMAX_PROVIDER_INSTALLATION_ALLOW ?? cfg.capabilityProviders?.installation?.allowedProviders),
			},
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
		gateway: { channels, bindings, ingress, observation, proactiveDelivery, artifactSite, feishu, telegram },
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
			workspaceWritePolicy: workspaceWritePolicy(env.BEEMAX_WORKSPACE_WRITE_POLICY ?? cfg.execution?.workspaceWritePolicy),
			taskGrantCapabilities: taskGrantCapabilities(env.BEEMAX_TASK_GRANT_CAPABILITIES ?? cfg.execution?.taskGrantCapabilities),
			image: str(env.BEEMAX_SANDBOX_IMAGE ?? cfg.execution?.image ?? DEFAULT_DOCKER_SANDBOX_IMAGE),
			timeoutMs: boundedNumber(env.BEEMAX_SANDBOX_TIMEOUT_MS ?? cfg.execution?.timeoutMs, 180_000, 1_000, 600_000),
		},
		subagents: {
			enabled: parseBool(env.BEEMAX_SUBAGENTS_ENABLED ?? cfg.subagents?.enabled ?? true),
			maxConcurrent: resolveRuntimeTaskConcurrency(parseNumber(env.BEEMAX_SUBAGENTS_MAX_CONCURRENT ?? cfg.subagents?.maxConcurrent, DEFAULT_RUNTIME_RESOURCE_LIMITS.taskConcurrency)),
			maxChildrenPerOwner: parseNumber(env.BEEMAX_SUBAGENTS_MAX_CHILDREN ?? cfg.subagents?.maxChildrenPerOwner, 5),
			timeoutMs: parseNumber(env.BEEMAX_SUBAGENTS_TIMEOUT_MS ?? cfg.subagents?.timeoutMs, 15 * 60_000),
		},
		automation: {
			enabled: parseBool(env.BEEMAX_AUTOMATION_ENABLED ?? cfg.automation?.enabled ?? true),
			timezone: str(env.BEEMAX_TIMEZONE ?? cfg.automation?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"),
			heartbeat: {
				enabled: parseBool(env.BEEMAX_HEARTBEAT_ENABLED ?? cfg.automation?.heartbeat?.enabled ?? true),
				every: str(env.BEEMAX_HEARTBEAT_EVERY ?? cfg.automation?.heartbeat?.every ?? "30m"),
				platform: heartbeatPlatform,
				channelInstanceId: heartbeatChannelInstanceId,
				chatId: optional(env.BEEMAX_HEARTBEAT_CHAT_ID ?? cfg.automation?.heartbeat?.chatId ?? feishu.homeChatId),
				chatType: cfg.automation?.heartbeat?.chatType ?? feishu.homeChatType,
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
			profileEnvPath: envPath,
			channelCredentialEnvironment: location.isHome ? "profile" : "ambient",
		},
	};
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}
function boundedConfiguredInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
	return parsed;
}
function boundedScore(value: unknown, fallback: number): number {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error("Gateway observation scores must be between 0 and 1");
	return parsed;
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
function reasoningDisplay(value: unknown): "off" | "summary" | "raw" {
	return value === "off" || value === "raw" ? value : "summary";
}
function executionBackend(value: unknown): "local" | "docker" {
	const configured = optional(value);
	if (configured === undefined) return "local";
	if (configured === "local" || configured === "docker") return configured;
	throw new Error(`Invalid execution.backend: ${configured}`);
}
function sandboxMode(value: unknown): "off" | "all" {
	const configured = optional(value);
	if (configured === undefined) return "off";
	if (configured === "off" || configured === "all") return configured;
	throw new Error(`Invalid execution.mode: ${configured}`);
}
function workspaceAccess(value: unknown): "none" | "ro" | "rw" {
	const configured = optional(value);
	if (configured === undefined) return "none";
	if (configured === "none" || configured === "ro" || configured === "rw") return configured;
	throw new Error(`Invalid execution.workspaceAccess: ${configured}`);
}
function workspaceWritePolicy(value: unknown): "approval-required" | "allow-within-workspace" {
	const configured = optional(value);
	if (configured === undefined) return "approval-required";
	if (configured === "approval-required" || configured === "allow-within-workspace") return configured;
	throw new Error(`Invalid execution.workspaceWritePolicy: ${configured}`);
}
function taskGrantCapabilities(value: unknown): string[] {
	if (value === undefined || value === null || value === "") return [];
	const entries = Array.isArray(value) ? value : String(value).split(",");
	const capabilities = entries.map((entry) => String(entry).trim()).filter(Boolean);
	for (const [index, capability] of capabilities.entries()) {
		if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(capability)) throw new Error(`Invalid execution.taskGrantCapabilities[${index}]: ${capability}`);
	}
	return [...new Set(capabilities)];
}

function parseCapabilityPreferences(value: unknown): Record<string, number> {
	if (value === undefined || value === null) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent.capabilityPreferences must be an object");
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > 500) throw new Error("agent.capabilityPreferences exceeds 500 entries");
	return Object.fromEntries(entries.map(([rawName, rawWeight]) => {
		const name = rawName.trim();
		if (!name || name.length > 256) throw new Error("agent.capabilityPreferences contains an invalid Capability name");
		if (typeof rawWeight !== "number" || !Number.isFinite(rawWeight) || rawWeight < -1 || rawWeight > 1) throw new Error(`agent.capabilityPreferences.${name} must be between -1 and 1`);
		return [name, rawWeight];
	}));
}
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

function parseProviderIds(value: unknown): string[] {
	const providers = [...new Set(parseList(value))];
	if (providers.length > 100) throw new Error("capabilityProviders.installation.allowedProviders exceeds 100 entries");
	for (const [index, provider] of providers.entries()) if (!/^[a-z0-9][a-z0-9._:@-]{0,127}$/i.test(provider)) throw new Error(`Invalid capabilityProviders.installation.allowedProviders[${index}]: ${provider}`);
	return providers;
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
		const accountRef = optional(candidate.accountRef);
		if (enabled && (adapter === "feishu" || adapter === "telegram") && !credentialRef) {
			throw new Error(`gateway.channels[${index}].credentialRef is required for ${adapter}`);
		}
		return {
			id,
			adapter,
			...(accountRef ? { accountRef } : {}),
			enabled,
			...(credentialRef ? { credentialRef } : {}),
			settings,
		};
	});
}

/** Resolve one Channel Secret only at the trusted Adapter boundary; never retain it in BeeMaxConfig. */
export function consumeChannelCredential<T>(config: BeeMaxConfig, channel: Pick<GatewayChannelConfig, "id" | "adapter" | "credentialRef">, consumer: (credential: Readonly<GatewayChannelCredential>) => T): T | undefined {
	const ref = channel.credentialRef;
	if (!ref) return undefined;
	const env: Record<string, string | undefined> = config.paths.channelCredentialEnvironment === "profile"
		? readEnvFileSync(config.paths.profileEnvPath)
		: process.env;
	if (channel.adapter === "feishu") {
		const prefix = ref === "profile-env:feishu" ? "FEISHU" : ref === `profile-env:channel:${channel.id}` ? channelEnvPrefix(channel.id) : undefined;
		if (!prefix) return undefined;
		const appId = str(env[`${prefix}_APP_ID`]);
		const appSecret = str(env[`${prefix}_APP_SECRET`]);
		if (!appId || !appSecret) return undefined;
		const webhookVerificationToken = optional(env[`${prefix}_WEBHOOK_VERIFICATION_TOKEN`]);
		const webhookEncryptKey = optional(env[`${prefix}_WEBHOOK_ENCRYPT_KEY`]);
		return consumer({ adapter: "feishu", appId, appSecret, ...(webhookVerificationToken ? { webhookVerificationToken } : {}), ...(webhookEncryptKey ? { webhookEncryptKey } : {}) });
	}
	if (channel.adapter === "telegram") {
		const key = ref === "profile-env:telegram" ? "TELEGRAM_BOT_TOKEN" : ref === `profile-env:channel:${channel.id}` ? `${channelEnvPrefix(channel.id)}_BOT_TOKEN` : undefined;
		const botToken = key ? str(env[key]) : "";
		return botToken ? consumer({ adapter: "telegram", botToken }) : undefined;
	}
	return undefined;
}

function channelEnvPrefix(instanceId: string): string {
	return `BEEMAX_CHANNEL_${instanceId.replace(/[^a-z0-9]/giu, "_").toUpperCase()}`;
}

function parseGatewayBindings(value: unknown, profileId: string, channels: GatewayChannelConfig[]): GatewayBindingConfig[] {
	if (value === undefined || value === null) return channels.map((channel) => ({
		id: `${channel.id}-default`, profileId, channelInstanceId: channel.id, enabled: channel.enabled,
	}));
	if (!Array.isArray(value)) throw new Error("gateway.bindings must be an array");
	return value.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`gateway.bindings[${index}] must be an object`);
		const candidate = entry as Record<string, unknown>;
		const id = str(candidate.id);
		const targetProfile = str(candidate.profileId);
		const channelInstanceId = str(candidate.channelInstanceId);
		const accountRef = optional(candidate.accountRef);
		const conversationId = optional(candidate.conversationId);
		const threadId = optional(candidate.threadId);
		if (!id || !targetProfile || !channelInstanceId) throw new Error(`gateway.bindings[${index}] requires id, profileId, and channelInstanceId`);
		return {
			id, profileId: targetProfile, channelInstanceId,
			...(accountRef ? { accountRef } : {}),
			...(conversationId ? { conversationId } : {}),
			...(threadId ? { threadId } : {}),
			enabled: candidate.enabled === undefined ? true : parseBool(candidate.enabled),
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
function parseFeishuActivation(value: unknown, requireMention: boolean, env: Record<string, string | undefined>): FeishuActivationSettings {
	const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const quietHours = parseQuietHours(candidate.quietHours, env.BEEMAX_TIMEZONE);
	return {
		mode: parseActivationMode(env.FEISHU_ACTIVATION_MODE ?? candidate.mode, requireMention ? "contextual" : "ambient"),
		respondTo: parseActivationSignals(env.FEISHU_ACTIVATION_RESPOND_TO ?? candidate.respondTo),
		ambientObservation: parseBool(env.FEISHU_AMBIENT_OBSERVATION ?? candidate.ambientObservation ?? false),
		activeThreadTtlMs: boundedNumber(env.FEISHU_ACTIVE_THREAD_TTL_MS ?? candidate.activeThreadTtlMs, 15 * 60_000, 1_000, 24 * 60 * 60_000),
		maxActiveThreads: boundedNumber(env.FEISHU_MAX_ACTIVE_THREADS ?? candidate.maxActiveThreads, 10_000, 1, 100_000),
		...(quietHours ? { quietHours } : {}),
		maxRepliesPerWindow: boundedNumber(env.FEISHU_MAX_REPLIES_PER_WINDOW ?? candidate.maxRepliesPerWindow, 6, 1, 1_000),
		replyWindowMs: boundedNumber(env.FEISHU_REPLY_WINDOW_MS ?? candidate.replyWindowMs, 60_000, 1_000, 24 * 60 * 60_000),
		maxTrackedResponseLanes: boundedNumber(env.FEISHU_MAX_TRACKED_RESPONSE_LANES ?? candidate.maxTrackedResponseLanes, 10_000, 1, 100_000),
	};
}
function parseQuietHours(value: unknown, fallbackTimezone: string | undefined): FeishuActivationSettings["quietHours"] {
	if (value === undefined || value === null) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("group quietHours must be an object");
	const candidate = value as Record<string, unknown>;
	const start = str(candidate.start);
	const end = str(candidate.end);
	const timezone = str(candidate.timezone ?? fallbackTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) throw new Error("group quietHours start/end must use HH:MM");
	try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { throw new Error(`Invalid group quietHours timezone: ${timezone}`); }
	return { start, end, timezone };
}
function parseActivationMode(value: unknown, fallback: FeishuActivationSettings["mode"]): FeishuActivationSettings["mode"] {
	if (value === undefined || value === null || value === "") return fallback;
	if (value === "disabled" || value === "explicit" || value === "contextual" || value === "ambient") return value;
	throw new Error(`Invalid group activation mode: ${String(value)}`);
}
function parseActivationSignals(value: unknown): FeishuActivationSettings["respondTo"] {
	const allowed = new Set(["mention", "reply", "active_thread", "command"] as const);
	if (value === undefined || value === null) return ["mention", "reply", "active_thread", "command"];
	const configured = parseList(value);
	const invalid = configured.filter((signal) => !allowed.has(signal as FeishuActivationSettings["respondTo"][number]));
	if (invalid.length) throw new Error(`Invalid group activation signals: ${invalid.join(", ")}`);
	return [...new Set(configured)] as FeishuActivationSettings["respondTo"];
}
function parseGroupRules(value: unknown): FeishuConfig["groupRules"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: FeishuConfig["groupRules"] = {};
	for (const [chatId, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!chatId || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const rule = raw as Record<string, unknown>;
		const policy = ["open", "allowlist", "blacklist", "admin_only", "disabled"].includes(String(rule.policy)) ? rule.policy as FeishuConfig["groupRules"][string]["policy"] : undefined;
		const activation = rule.activation && typeof rule.activation === "object" && !Array.isArray(rule.activation) ? rule.activation as Record<string, unknown> : undefined;
		const activationOverride = activation ? {
			...(activation.mode !== undefined ? { mode: parseActivationMode(activation.mode, "contextual") } : {}),
			...(activation.respondTo !== undefined ? { respondTo: parseActivationSignals(activation.respondTo) } : {}),
			...(activation.ambientObservation !== undefined ? { ambientObservation: parseBool(activation.ambientObservation) } : {}),
		} : undefined;
		result[chatId] = {
			policy, allowlist: parseList(rule.allowlist), blacklist: parseList(rule.blacklist),
			...(typeof rule.requireMention === "boolean" ? { requireMention: rule.requireMention } : {}),
			...(activationOverride ? { activation: activationOverride } : {}),
		};
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

function defaultCaddyCommand(): string {
	for (const candidate of ["/opt/homebrew/bin/caddy", "/home/linuxbrew/.linuxbrew/bin/caddy"]) {
		if (existsSync(candidate)) return candidate;
	}
	return "caddy";
}

function defaultArtifactSiteListen(profile: string): string {
	if (profile === "default") return "127.0.0.1:8788";
	const digest = createHash("sha256").update(`beemax-artifact-site:${profile}`).digest();
	return `127.0.0.1:${12_000 + digest.readUInt32BE(0) % 20_000}`;
}

/**
 * BeeMax config. Loads from config/beemax.yaml + env overrides.
 *
 * Mirrors the relevant slice of Hermes' ~/.hermes/config.yaml (model +
 * providers + gateway.feishu), trimmed to what BeeMax needs today.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { readEnvFileSync } from "./env-file.ts";
import { beemaxRoot, resolveProfileLocation, validateProfileName } from "./profile-home.ts";
import { resolveSoul } from "./soul.ts";
import { providerApiKeyEnv } from "./provider-resolver.ts";

export { beemaxHome, beemaxRoot, validateProfileName } from "./profile-home.ts";

export interface FeishuConfig {
	appId: string;
	appSecret: string;
	domain: "feishu" | "lark";
	requireMention: boolean;
	allowedUsers: string[];
	allowedChats: string[];
	allowAllUsers: boolean;
	connectionMode: "websocket" | "webhook";
	webhookHost: string;
	webhookPort: number;
	webhookPath: string;
	webhookVerificationToken?: string;
	webhookEncryptKey?: string;
}
export type CustomProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface BeeMaxConfig {
	profile: string;
	agent: {
		systemPrompt?: string;
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
	};
	models: Array<{ provider: string; model: string; baseUrl?: string; customProtocol?: CustomProtocol }>;
	/** Profile-owned channel configuration. A Profile may run its own Gateway. */
	gateway: { feishu: FeishuConfig };
	memory: {
		dbPath: string;
	};
	mcp: {
		configPath: string;
	};
	imageGeneration: {
		enabled: boolean;
		provider: "openai-codex";
		quality: "low" | "medium" | "high";
		outputDir: string;
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
	const configuredFeishu = cfg.gateway?.feishu ?? cfg.feishu;

	const appId = str(env.FEISHU_APP_ID ?? configuredFeishu?.appId);
	const appSecret = str(env.FEISHU_APP_SECRET ?? configuredFeishu?.appSecret);

	const provider = str(env.BEEMAX_PROVIDER ?? cfg.model?.provider ?? "anthropic");
	const model = str(env.BEEMAX_MODEL ?? cfg.model?.model ?? "claude-sonnet-4-5");
	const apiKey = str(env[providerApiKeyEnv(provider)] ?? env.BEEMAX_API_KEY ?? cfg.model?.apiKey);
	const customProtocol = parseCustomProtocol(cfg.model?.customProtocol);
	const configuredModels = modelChoices(cfg.models, { provider, model, baseUrl: cfg.model?.baseUrl, customProtocol });
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
	const feishu: FeishuConfig = {
		appId,
		appSecret,
		domain: (env.FEISHU_DOMAIN ?? configuredFeishu?.domain ?? "feishu") === "lark" ? "lark" : "feishu",
		requireMention: parseBool(env.FEISHU_REQUIRE_MENTION ?? configuredFeishu?.requireMention ?? true),
		allowedUsers: parseList(env.FEISHU_ALLOWED_USERS ?? configuredFeishu?.allowedUsers),
		allowedChats: parseList(env.FEISHU_ALLOWED_CHATS ?? configuredFeishu?.allowedChats),
		allowAllUsers: parseBool(env.FEISHU_ALLOW_ALL_USERS ?? configuredFeishu?.allowAllUsers ?? false),
		connectionMode: (env.FEISHU_CONNECTION_MODE ?? configuredFeishu?.connectionMode ?? "websocket") === "webhook" ? "webhook" : "websocket",
		webhookHost: str(env.FEISHU_WEBHOOK_HOST ?? configuredFeishu?.webhookHost ?? "127.0.0.1"),
		webhookPort: Number(env.FEISHU_WEBHOOK_PORT ?? configuredFeishu?.webhookPort ?? 8787),
		webhookPath: str(env.FEISHU_WEBHOOK_PATH ?? configuredFeishu?.webhookPath ?? "/feishu/events"),
		webhookVerificationToken: str(env.FEISHU_WEBHOOK_VERIFICATION_TOKEN ?? configuredFeishu?.webhookVerificationToken ?? "") || undefined,
		webhookEncryptKey: str(env.FEISHU_WEBHOOK_ENCRYPT_KEY ?? configuredFeishu?.webhookEncryptKey ?? "") || undefined,
	};
	return {
		profile,
		agent: {
			systemPrompt: soul,
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
		},
		models: configuredModels,
		gateway: { feishu },
		memory: {
			dbPath: resolveFrom(location.basePath, str(env.BEEMAX_DB_PATH ?? cfg.memory?.dbPath ?? join(profileDataRoot, location.isHome ? "memory.db" : "beemax.db"))),
		},
		mcp: {
			configPath: resolveFrom(location.basePath, str(env.BEEMAX_MCP_CONFIG ?? cfg.mcp?.configPath ?? (location.isHome ? "mcp.json" : profile === "default" ? "config/mcp.json" : `config/profiles/${profile}.mcp.json`))),
		},
		imageGeneration: {
			enabled: parseBool(env.BEEMAX_IMAGE_ENABLED ?? cfg.imageGeneration?.enabled ?? false),
			provider: "openai-codex",
			quality: parseImageQuality(env.BEEMAX_IMAGE_QUALITY ?? cfg.imageGeneration?.quality),
			outputDir: resolveFrom(location.basePath, str(env.BEEMAX_IMAGE_OUTPUT_DIR ?? cfg.imageGeneration?.outputDir ?? join(profileDataRoot, "cache/images"))),
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
				chatId: optional(env.BEEMAX_HEARTBEAT_CHAT_ID ?? cfg.automation?.heartbeat?.chatId),
				userId: optional(env.BEEMAX_HEARTBEAT_USER_ID ?? cfg.automation?.heartbeat?.userId),
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

function resolveFrom(root: string, path: string): string {
	return isAbsolute(path) ? path : resolve(root, path);
}

const DEFAULT_HEARTBEAT_PROMPT = "Read HEARTBEAT.md if it exists in the workspace and follow it strictly. Review due reminders, scheduled work, recent failures, and anything that genuinely needs the user's attention. Do not infer or repeat stale tasks from old chats. If nothing needs attention, reply HEARTBEAT_OK.";


function str(v: unknown): string {
	return (typeof v === "string" ? v : "")?.trim();
}
function parseBool(v: unknown): boolean {
	if (typeof v === "boolean") return v;
	return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function optional(value: unknown): string | undefined {
	const valueString = str(value);
	return valueString || undefined;
}
function parseImageQuality(value: unknown): "low" | "medium" | "high" {
	return value === "low" || value === "high" ? value : "medium";
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

function modelChoices(value: unknown, active: { provider: string; model: string; baseUrl?: string; customProtocol?: CustomProtocol }): Array<{ provider: string; model: string; baseUrl?: string; customProtocol?: CustomProtocol }> {
	const items = Array.isArray(value) ? value : [];
	const choices = items.filter(isModelChoice);
	return [{ ...active }, ...choices.filter((item) => item.provider !== active.provider || item.model !== active.model || item.baseUrl !== active.baseUrl)];
}

function isModelChoice(value: unknown): value is { provider: string; model: string; baseUrl?: string; customProtocol?: CustomProtocol } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.provider === "string" && typeof candidate.model === "string" && (candidate.baseUrl === undefined || typeof candidate.baseUrl === "string") && (candidate.customProtocol === undefined || parseCustomProtocol(candidate.customProtocol) === candidate.customProtocol);
}
function parseCustomProtocol(value: unknown): CustomProtocol { return value === "anthropic-messages" || value === "openai-responses" ? value : "openai-completions"; }

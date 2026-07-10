/**
 * BeeMax config. Loads from config/beemax.yaml + env overrides.
 *
 * Mirrors the relevant slice of Hermes' ~/.hermes/config.yaml (model +
 * providers + gateway.feishu), trimmed to what BeeMax needs today.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { readEnvFileSync } from "./env-file.ts";

export interface BeeMaxConfig {
	profile: string;
	agent: {
		systemPrompt?: string;
	};
	model: {
		provider: string;
		model: string;
		apiKey?: string;
		baseUrl?: string;
	};
	feishu: {
		appId: string;
		appSecret: string;
		domain: "feishu" | "lark";
		requireMention: boolean;
		allowedUsers: string[];
		allowedChats: string[];
		allowAllUsers: boolean;
	};
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
	const path = configPath ?? join(root, profile === "default" ? "config/beemax.yaml" : `config/profiles/${profile}.yaml`);
	const envPath = path.replace(/\.ya?ml$/i, ".env");
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// config file optional; env-only mode
	}
	const cfg = (raw ? parseYaml(raw) : {}) as Partial<BeeMaxConfig>;
	const env = { ...readEnvFileSync(envPath), ...process.env };

	const appId = str(env.FEISHU_APP_ID ?? cfg.feishu?.appId);
	const appSecret = str(env.FEISHU_APP_SECRET ?? cfg.feishu?.appSecret);

	const provider = str(env.BEEMAX_PROVIDER ?? cfg.model?.provider ?? "anthropic");
	const model = str(env.BEEMAX_MODEL ?? cfg.model?.model ?? "claude-sonnet-4-5");
	const apiKey = str(env.BEEMAX_API_KEY ?? cfg.model?.apiKey);

	const profileDataRoot = join(root, profile === "default" ? "data" : `data/profiles/${profile}`);
	return {
		profile,
		agent: {
			systemPrompt: optional(env.BEEMAX_SYSTEM_PROMPT ?? cfg.agent?.systemPrompt),
		},
		model: {
			provider,
			model,
			apiKey,
			baseUrl: cfg.model?.baseUrl,
		},
		feishu: {
			appId,
			appSecret,
			domain: (env.FEISHU_DOMAIN ?? cfg.feishu?.domain ?? "feishu") === "lark" ? "lark" : "feishu",
			requireMention: parseBool(env.FEISHU_REQUIRE_MENTION ?? cfg.feishu?.requireMention ?? true),
			allowedUsers: parseList(env.FEISHU_ALLOWED_USERS ?? cfg.feishu?.allowedUsers),
			allowedChats: parseList(env.FEISHU_ALLOWED_CHATS ?? cfg.feishu?.allowedChats),
			allowAllUsers: parseBool(env.FEISHU_ALLOW_ALL_USERS ?? cfg.feishu?.allowAllUsers ?? false),
		},
		memory: {
			dbPath: resolveFrom(root, str(env.BEEMAX_DB_PATH ?? cfg.memory?.dbPath ?? join(profileDataRoot, "beemax.db"))),
		},
		mcp: {
			configPath: resolveFrom(root, str(env.BEEMAX_MCP_CONFIG ?? cfg.mcp?.configPath ?? (profile === "default" ? "config/mcp.json" : `config/profiles/${profile}.mcp.json`))),
		},
		imageGeneration: {
			enabled: parseBool(env.BEEMAX_IMAGE_ENABLED ?? cfg.imageGeneration?.enabled ?? false),
			provider: "openai-codex",
			quality: parseImageQuality(env.BEEMAX_IMAGE_QUALITY ?? cfg.imageGeneration?.quality),
			outputDir: resolveFrom(root, str(env.BEEMAX_IMAGE_OUTPUT_DIR ?? cfg.imageGeneration?.outputDir ?? join(profileDataRoot, "cache/images"))),
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
			agentDir: resolveFrom(root, str(env.BEEMAX_AGENT_DIR ?? cfg.paths?.agentDir ?? join(profileDataRoot, "agent"))),
			cwd: resolveFrom(root, str(env.BEEMAX_CWD ?? cfg.paths?.cwd ?? ".")),
		},
	};
}

export function beemaxRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.BEEMAX_ROOT?.trim() || process.cwd());
}

function resolveFrom(root: string, path: string): string {
	return isAbsolute(path) ? path : resolve(root, path);
}

const DEFAULT_HEARTBEAT_PROMPT = "Read HEARTBEAT.md if it exists in the workspace and follow it strictly. Review due reminders, scheduled work, recent failures, and anything that genuinely needs the user's attention. Do not infer or repeat stale tasks from old chats. If nothing needs attention, reply HEARTBEAT_OK.";

export function validateProfileName(profile: string): void {
	if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) {
		throw new Error(`Invalid profile name: ${profile}. Use lowercase letters, numbers, hyphens, or underscores.`);
	}
}

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

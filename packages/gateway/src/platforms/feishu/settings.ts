/**
 * Feishu adapter settings.
 *
 * Identity model follows Hermes' Feishu adapter (see Hermes'
 * gateway/platforms/feishu.py module docstring):
 *
 *   open_id  (ou_xxx)  - app-scoped. Always in event payloads. Used as the
 *                        de-facto unique user id in single-bot mode.
 *   union_id (on_xxx)  - developer-scoped, stable across apps. Preferred for
 *                        session keying when available (userIdAlt).
 *
 * Connection: WebSocket long-connection by default; webhook mode is available
 * when a public HTTPS reverse proxy forwards to the configured local endpoint.
 *
 * Bot identity: this is a self-built (企业内部) app. Credentials app_id +
 * app_secret come from the Feishu developer console. The bot's own open_id
 * is fetched at startup via /bot/v3/info and used only for @-mention matching.
 */

import type { PairingAuthority } from "../../security/pairing.ts";
import type { GroupActivationMode, GroupActivationSignal } from "../../core/group-admission.ts";

export interface FeishuActivationSettings {
	mode: GroupActivationMode;
	respondTo: GroupActivationSignal[];
	activeThreadTtlMs?: number;
	maxActiveThreads?: number;
}

export interface FeishuGroupRule {
	policy?: "open" | "allowlist" | "blacklist" | "admin_only" | "disabled";
	allowlist?: string[];
	blacklist?: string[];
	requireMention?: boolean;
	activation?: Partial<Pick<FeishuActivationSettings, "mode" | "respondTo">>;
}

export interface FeishuSettings {
	appId: string;
	appSecret: string;
	/** "feishu" (default) or "lark" for international Lark. */
	domain: "feishu" | "lark";
	connectionMode: "websocket" | "webhook";
	webhookHost?: string;
	webhookPort?: number;
	webhookPath?: string;
	webhookVerificationToken?: string;
	webhookEncryptKey?: string;
	/**
	 * Require @mention of the bot in group chats to respond. DMs always respond.
	 * Matches Hermes default (FEISHU_REQUIRE_MENTION=true).
	 */
	requireMention: boolean;
	/** Transport-neutral group activation; requireMention remains a legacy fallback when omitted. */
	activation?: FeishuActivationSettings;
	/** Authorized Feishu open_id/user_id/union_id values. Empty means deny unless allowAllUsers=true. */
	allowedUsers: string[];
	/** Optional chat_id restriction. Empty allows authorized users in any chat. */
	allowedChats: string[];
	/** Explicit insecure override for development or intentionally public bots. */
	allowAllUsers: boolean;
	groupPolicy?: "open" | "allowlist" | "disabled";
	groupRules?: Record<string, FeishuGroupRule>;
	admins?: string[];
	setHomeChat?: (chatId: string, userId: string | undefined, chatType: "dm" | "group") => Promise<void>;
	/** Optional Profile-scoped DM pairing authority for unknown users. */
	pairing?: PairingAuthority;
	/** Bot's own open_id, hydrated at startup via /bot/v3/info. */
	botOpenId?: string;
	botName?: string;
	/** Hermes-compatible quiet windows and burst bounds. */
	textBatchDelayMs?: number;
	textBatchSplitDelayMs?: number;
	textBatchMaxMessages?: number;
	textBatchMaxChars?: number;
	mediaBatchDelayMs?: number;
	/** Base for Hermes-compatible 1s/2s connection and send retry backoff. */
	retryBaseDelayMs?: number;
}

/** Reject webhook settings that would expose an unauthenticated public listener. */
export function validateFeishuWebhookSettings(settings: FeishuSettings): void {
	if (settings.connectionMode !== "webhook") return;
	if (!settings.webhookEncryptKey?.trim()) {
		throw new Error("Webhook mode requires FEISHU_WEBHOOK_ENCRYPT_KEY so inbound Feishu events can be authenticated");
	}
	if (!Number.isInteger(settings.webhookPort) || !settings.webhookPort || settings.webhookPort < 1 || settings.webhookPort > 65_535) {
		throw new Error("Webhook port must be an integer between 1 and 65535");
	}
	if (!settings.webhookPath?.startsWith("/") || settings.webhookPath.includes("?")) {
		throw new Error("Webhook path must start with '/' and must not include a query string");
	}
}

export function loadFeishuSettings(env: NodeJS.ProcessEnv = process.env): FeishuSettings {
	const appId = (env.FEISHU_APP_ID ?? "").trim();
	const appSecret = (env.FEISHU_APP_SECRET ?? "").trim();
	if (!appId || !appSecret) {
		throw new Error(
			"Feishu requires FEISHU_APP_ID and FEISHU_APP_SECRET. " +
				"Create a self-built app at https://open.feishu.cn/app and set both env vars.",
		);
	}
	const domain: FeishuSettings["domain"] = (env.FEISHU_DOMAIN ?? "feishu").toLowerCase() === "lark" ? "lark" : "feishu";
	const requireMention = parseBool(env.FEISHU_REQUIRE_MENTION ?? "true");
	return {
		appId,
		appSecret,
		domain,
		connectionMode: (env.FEISHU_CONNECTION_MODE ?? "websocket").toLowerCase() === "webhook" ? "webhook" : "websocket",
		webhookHost: env.FEISHU_WEBHOOK_HOST ?? "127.0.0.1",
		webhookPort: Number(env.FEISHU_WEBHOOK_PORT ?? 8787),
		webhookPath: env.FEISHU_WEBHOOK_PATH ?? "/feishu/events",
		webhookVerificationToken: env.FEISHU_WEBHOOK_VERIFICATION_TOKEN?.trim() || undefined,
		webhookEncryptKey: env.FEISHU_WEBHOOK_ENCRYPT_KEY?.trim() || undefined,
		requireMention,
		allowedUsers: parseCsv(env.FEISHU_ALLOWED_USERS),
		allowedChats: parseCsv(env.FEISHU_ALLOWED_CHATS),
		allowAllUsers: parseBool(env.FEISHU_ALLOW_ALL_USERS ?? "false"),
		groupPolicy: (env.FEISHU_GROUP_POLICY === "open" || env.FEISHU_GROUP_POLICY === "disabled") ? env.FEISHU_GROUP_POLICY : "allowlist",
		groupRules: {},
		admins: parseCsv(env.FEISHU_ADMINS),
		botOpenId: (env.FEISHU_BOT_OPEN_ID ?? "").trim() || undefined,
		botName: (env.FEISHU_BOT_NAME ?? "").trim() || undefined,
		textBatchDelayMs: parseBoundedNumber(env.FEISHU_TEXT_BATCH_DELAY_MS, 600, 0, 60_000),
		textBatchSplitDelayMs: parseBoundedNumber(env.FEISHU_TEXT_BATCH_SPLIT_DELAY_MS, 2_000, 0, 60_000),
		textBatchMaxMessages: parseBoundedNumber(env.FEISHU_TEXT_BATCH_MAX_MESSAGES, 8, 1, 1_000),
		textBatchMaxChars: parseBoundedNumber(env.FEISHU_TEXT_BATCH_MAX_CHARS, 4_000, 1, 100_000),
		mediaBatchDelayMs: parseBoundedNumber(env.FEISHU_MEDIA_BATCH_DELAY_MS, 800, 0, 60_000),
		retryBaseDelayMs: parseBoundedNumber(env.FEISHU_RETRY_BASE_DELAY_MS, 1_000, 0, 30_000),
	};
}

function parseBoundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function parseBool(v: string): boolean {
	return /^(1|true|yes|on)$/i.test(v.trim());
}

function parseCsv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

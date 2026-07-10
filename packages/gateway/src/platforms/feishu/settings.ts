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
 * Connection: WebSocket long-connection by default (no public HTTPS needed,
 * friendly to local Linux deployment). Webhook mode is a future option.
 *
 * Bot identity: this is a self-built (企业内部) app. Credentials app_id +
 * app_secret come from the Feishu developer console. The bot's own open_id
 * is fetched at startup via /bot/v3/info and used only for @-mention matching.
 */

export interface FeishuSettings {
	appId: string;
	appSecret: string;
	/** "feishu" (default) or "lark" for international Lark. */
	domain: "feishu" | "lark";
	/** Only "websocket" is implemented for now. */
	connectionMode: "websocket";
	/**
	 * Require @mention of the bot in group chats to respond. DMs always respond.
	 * Matches Hermes default (FEISHU_REQUIRE_MENTION=true).
	 */
	requireMention: boolean;
	/** Authorized Feishu open_id/user_id/union_id values. Empty means deny unless allowAllUsers=true. */
	allowedUsers: string[];
	/** Optional chat_id restriction. Empty allows authorized users in any chat. */
	allowedChats: string[];
	/** Explicit insecure override for development or intentionally public bots. */
	allowAllUsers: boolean;
	/** Bot's own open_id, hydrated at startup via /bot/v3/info. */
	botOpenId?: string;
	botName?: string;
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
		connectionMode: "websocket",
		requireMention,
		allowedUsers: parseCsv(env.FEISHU_ALLOWED_USERS),
		allowedChats: parseCsv(env.FEISHU_ALLOWED_CHATS),
		allowAllUsers: parseBool(env.FEISHU_ALLOW_ALL_USERS ?? "false"),
		botOpenId: (env.FEISHU_BOT_OPEN_ID ?? "").trim() || undefined,
		botName: (env.FEISHU_BOT_NAME ?? "").trim() || undefined,
	};
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

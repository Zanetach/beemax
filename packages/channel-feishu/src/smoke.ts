import { randomUUID } from "node:crypto";
import lark, { type Client } from "@larksuiteoapi/node-sdk";
import type { FeishuSettings } from "./settings.ts";
import { retryFeishuOperation } from "./retry.ts";

export interface FeishuSmokeCheck {
	name: "credentials" | "text" | "card" | "reaction" | "image";
	status: "pass" | "fail" | "skip";
	detail: string;
}

export interface FeishuSmokeResult {
	success: boolean;
	chatId: string;
	botName?: string;
	botOpenId?: string;
	checks: FeishuSmokeCheck[];
}

interface SmokeBotResponse {
	code?: number;
	msg?: string;
	bot?: { open_id?: string; app_name?: string; bot_name?: string };
	data?: { bot?: { open_id?: string; app_name?: string; bot_name?: string } };
}

export async function runFeishuSmoke(
	settings: Pick<FeishuSettings, "appId" | "appSecret" | "domain" | "retryBaseDelayMs">,
	chatId: string,
	clientOverride?: Client,
): Promise<FeishuSmokeResult> {
	if (!chatId.trim()) throw new Error("Feishu smoke test requires a target chat_id");
	const domain = settings.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
	const client = clientOverride ?? new lark.Client({
		appId: settings.appId,
		appSecret: settings.appSecret,
		appType: lark.AppType.SelfBuild,
		domain,
		loggerLevel: lark.LoggerLevel.warn,
	});
	const retry = <T>(operation: () => Promise<T>) => retryFeishuOperation(operation, { attempts: 3, baseDelayMs: settings.retryBaseDelayMs ?? 1_000 });
	const checks: FeishuSmokeCheck[] = [];
	let botName: string | undefined;
	let botOpenId: string | undefined;
	let textMessageId: string | undefined;
	const textUuid = randomUUID();
	const cardUuid = randomUUID();
	const imageUuid = randomUUID();

	try {
		const response = await retry(() => client.request<SmokeBotResponse>({ method: "GET", url: "open-apis/bot/v3/info" }));
		if (response.code !== 0) throw feishuResponseError(response.code, response.msg);
		const bot = response.bot ?? response.data?.bot;
		botName = bot?.app_name ?? bot?.bot_name;
		botOpenId = bot?.open_id;
		if (!botName && !botOpenId) throw new Error("Feishu bot info returned no bot identity");
		checks.push({ name: "credentials", status: "pass", detail: botName ? `authenticated as ${botName}` : "credentials accepted" });
	} catch (error) {
		checks.push(failedCheck("credentials", error));
	}

	try {
		const response = await retry(() => client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: "BeeMax Feishu smoke test: text delivery passed." }), uuid: textUuid },
		}));
		if (response.code !== 0 || !response.data?.message_id) throw feishuResponseError(response.code, response.msg);
		textMessageId = response.data.message_id;
		checks.push({ name: "text", status: "pass", detail: "bot text message delivered" });
	} catch (error) { checks.push(failedCheck("text", error)); }

	try {
		const response = await retry(() => client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: chatId,
				msg_type: "interactive",
				content: JSON.stringify({ schema: "2.0", header: { title: { tag: "plain_text", content: "BeeMax smoke test" }, template: "green" }, body: { elements: [{ tag: "markdown", content: "✅ Interactive-card delivery passed." }] } }),
				uuid: cardUuid,
			},
		}));
		if (response.code !== 0 || !response.data?.message_id) throw feishuResponseError(response.code, response.msg ?? "card send returned no message_id");
		checks.push({ name: "card", status: "pass", detail: "interactive card delivered" });
	} catch (error) { checks.push(failedCheck("card", error)); }

	if (!textMessageId) {
		checks.push({ name: "reaction", status: "skip", detail: "text message failed, so Reaction could not be tested" });
	} else {
		let reactionId: string | undefined;
		let deleted = false;
		try {
			// Reaction create has no idempotency key; do not retry an ambiguous response.
			const created = await client.im.v1.messageReaction.create({ path: { message_id: textMessageId! }, data: { reaction_type: { emoji_type: "Typing" } } });
			if (created.code !== 0 || !created.data?.reaction_id) throw feishuResponseError(created.code, created.msg);
			reactionId = created.data.reaction_id;
			const removed = await retry(() => client.im.v1.messageReaction.delete({ path: { message_id: textMessageId!, reaction_id: reactionId! } }));
			if (removed.code !== 0) throw feishuResponseError(removed.code, removed.msg);
			deleted = true;
			checks.push({ name: "reaction", status: "pass", detail: "Reaction add/remove passed" });
		} catch (error) {
			checks.push(failedCheck("reaction", error));
		} finally {
			if (reactionId && !deleted) {
				await client.im.v1.messageReaction.delete({ path: { message_id: textMessageId, reaction_id: reactionId } }).catch(() => undefined);
			}
		}
	}

	try {
		const image = await retry(() => client.im.v1.image.create({ data: { image_type: "message", image: ONE_PIXEL_PNG } }));
		if (!image?.image_key) throw new Error("image upload returned no image_key");
		const response = await retry(() => client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, msg_type: "image", content: JSON.stringify({ image_key: image.image_key }), uuid: imageUuid },
		}));
		if (response.code !== 0 || !response.data?.message_id) throw feishuResponseError(response.code, response.msg ?? "image send returned no message_id");
		checks.push({ name: "image", status: "pass", detail: "image upload and delivery passed" });
	} catch (error) { checks.push(failedCheck("image", error)); }

	return { success: checks.every((check) => check.status === "pass"), chatId, botName, botOpenId, checks };
}

function failedCheck(name: FeishuSmokeCheck["name"], error: unknown): FeishuSmokeCheck {
	const message = error instanceof Error ? error.message : String(error);
	return { name, status: "fail", detail: `${message}. ${diagnosticHint(message)}`.trim() };
}

function feishuResponseError(code: number | undefined, message: string | undefined): Error {
	return new Error(`Feishu ${code ?? "unknown"}: ${message ?? "request failed"}`);
}

function diagnosticHint(message: string): string {
	if (/99991663|token|credential|secret/i.test(message)) return "Check App ID/App Secret and publish the current app version.";
	if (/230002|230027|permission|scope|forbidden/i.test(message)) return "Grant bot message, image, card, and Reaction permissions, then publish the app version.";
	if (/230001|230011|not found|not in chat/i.test(message)) return "Confirm the chat_id and add the bot to that chat.";
	if (/rate|429|9999140/i.test(message)) return "Wait for the Feishu rate-limit window and retry.";
	return "Check the Feishu developer-console permissions, bot availability, and target chat.";
}

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

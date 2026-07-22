import { runFeishuSmoke, type FeishuSmokeResult } from "@thruvera/channel-feishu";
import { consumeChannelCredential, type ThruveraConfig } from "./config.ts";

export async function executeFeishuSmoke(
	config: ThruveraConfig,
	chatId: string,
	runner: typeof runFeishuSmoke = runFeishuSmoke,
): Promise<{ success: boolean; output: string }> {
	const instance = config.gateway.channels.find((channel) => channel.enabled && channel.adapter === "feishu");
	if (!instance) throw new Error("No enabled Feishu Channel Instance is configured");
	const result = await consumeChannelCredential(config, instance, (credential) => credential.adapter === "feishu" ? runner({ ...config.gateway.feishu, ...credential }, chatId) : undefined);
	if (!result) throw new Error(`Channel Instance '${instance.id}' has no valid Feishu credentials`);
	return { success: result.success, output: renderFeishuSmoke(result, config.profile) };
}

export function renderFeishuSmoke(result: FeishuSmokeResult, profile: string): string {
	const lines = [
		`Feishu smoke test · Profile '${profile}' · chat=${result.chatId}`,
		result.botName || result.botOpenId ? `Bot: ${result.botName ?? result.botOpenId}` : "Bot: unavailable",
		"",
	];
	for (const check of result.checks) {
		const marker = check.status === "pass" ? "PASS" : check.status === "skip" ? "SKIP" : "FAIL";
		lines.push(`${marker.padEnd(4)}  ${check.name.padEnd(11)} ${check.detail}`);
	}
	lines.push("", result.success
		? "PASS  Real Feishu text, card, Reaction, and image transport are compatible."
		: "FAIL  Fix the failed checks in Feishu Developer Console, publish the app version, then rerun this command.");
	return lines.join("\n");
}

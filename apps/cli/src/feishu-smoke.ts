import { runFeishuSmoke, type FeishuSmokeResult } from "@beemax/channel-feishu";
import type { BeeMaxConfig } from "./config.ts";

export async function executeFeishuSmoke(
	config: BeeMaxConfig,
	chatId: string,
	runner: typeof runFeishuSmoke = runFeishuSmoke,
): Promise<{ success: boolean; output: string }> {
	const result = await runner(config.gateway.feishu, chatId);
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

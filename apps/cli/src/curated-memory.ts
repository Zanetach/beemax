import { curatedMemoryPrompt as coreCuratedMemoryPrompt } from "@beemax/core";

/** @deprecated Prompt composition is Core-owned; this export is retained for profile tests. */
export function curatedMemoryPrompt(agentDir: string): string {
	return coreCuratedMemoryPrompt(agentDir, { platform: "cli", chatId: "local", chatType: "dm", userId: "local" });
}

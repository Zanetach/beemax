import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThruveraRuntimeSource } from "./runtime.ts";

const LIMITS = { memory: 2_200, user: 1_375 } as const;

/** Core-owned, bounded personal snapshot. Shared channel sessions never receive it. */
export function curatedMemoryPrompt(agentDir: string, source: ThruveraRuntimeSource): string {
	const userId = source.userIdAlt ?? source.userId;
	if (source.platform !== "cli" || source.chatId !== "local" || userId !== "local") return "";
	const user = readBounded(join(agentDir, "USER.md"), LIMITS.user);
	const memory = readBounded(join(agentDir, "MEMORY.md"), LIMITS.memory);
	if (!user && !memory) return "";
	const sections: string[] = ["# Curated long-term memory", "This snapshot is fixed for this session. Use memory tools to inspect or update live memory."];
	if (user) sections.push(`## User profile\n${user}`);
	if (memory) sections.push(`## Agent memory\n${memory}`);
	return sections.join("\n\n");
}

function readBounded(path: string, maxChars: number): string {
	try {
		const value = readFileSync(path, "utf8").trim();
		return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
	} catch { return ""; }
}

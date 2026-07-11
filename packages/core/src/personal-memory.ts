import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BeeMaxRuntimeSource } from "./runtime.ts";

export interface LongTermMemoryCompiler {
	compileLongTermMemory(options: { platform: string; chatId: string; userId?: string; maxChars: number }): string;
}

/** Core-owned policy for producing the bounded profile snapshot injected into new sessions. */
export function compileLongTermMemorySnapshot(memory: LongTermMemoryCompiler, agentDir: string, source: BeeMaxRuntimeSource, maxChars = 2200): string {
	const userId = source.userIdAlt ?? source.userId;
	if (!userId) throw new Error("Long-term memory compilation requires an identified user scope");
	const snapshot = memory.compileLongTermMemory({ platform: source.platform, chatId: source.chatId, userId, maxChars });
	const path = join(agentDir, "MEMORY.md");
	writeFileSync(path, `${snapshot}\n`, { encoding: "utf8", mode: 0o600 });
	return path;
}

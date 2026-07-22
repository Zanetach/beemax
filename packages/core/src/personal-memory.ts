import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThruveraRuntimeSource } from "./runtime.ts";
import { memoryScopeForSource, type MemoryScope } from "./memory-scope.ts";

export interface LongTermMemoryCompiler {
	compileLongTermMemory(options: MemoryScope & { maxChars: number }): string;
}

/** Core-owned policy for producing the bounded profile snapshot injected into new sessions. */
export function compileLongTermMemorySnapshot(memory: LongTermMemoryCompiler, agentDir: string, source: ThruveraRuntimeSource, maxChars = 2200): string {
	const scope = memoryScopeForSource(source);
	if (scope.platform !== "cli" || scope.chatId !== "local" || scope.userId !== "local") throw new Error("Profile MEMORY.md can only be compiled from the isolated local personal session");
	const snapshot = memory.compileLongTermMemory({ ...scope, maxChars });
	const path = join(agentDir, "MEMORY.md");
	writeFileSync(path, `${snapshot}\n`, { encoding: "utf8", mode: 0o600 });
	return path;
}

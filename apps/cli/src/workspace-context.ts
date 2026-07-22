import { readFileSync } from "node:fs";
import { join } from "node:path";
import { containsPromptInjection } from "./soul.ts";

const MAX_TOOLS_CONTEXT_CHARS = 4_000;

/** Optional workspace-owned operational notes; never created or modified by Thruvera. */
export function workspaceToolsPrompt(workspace: string): string {
	try {
		const tools = readFileSync(join(workspace, "TOOLS.md"), "utf8").trim();
		if (!tools || tools.length > MAX_TOOLS_CONTEXT_CHARS || containsPromptInjection(tools)) return "";
		return `# Workspace tool notes\n${tools}`;
	} catch {
		return "";
	}
}

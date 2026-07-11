/** Managed instruction-only Skill evolution is Core runtime policy. */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, withToolPolicy, type ToolPolicy } from "./tool-runtime.ts";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createSkillTools(agentDir: string, markReloadNeeded: () => void): ToolDefinition[] {
	const root = resolve(agentDir, "skills");
	const tools = [
		defineTool({ name: "skill_list", label: "List Evolved Skills", description: "List instruction-only skills created in BeeMax's managed skill directory. Pi also loads trusted global and project skills automatically.", parameters: Type.Object({}), execute: async () => {
			const skills = await listSkills(root); return result(skills.length ? skills.map((item) => `- ${item.name}: ${item.description}`).join("\n") : "No evolved skills yet.", { skills });
		} }),
		defineTool({ name: "skill_read", label: "Read Evolved Skill", description: "Read a managed BeeMax skill's SKILL.md.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }) }), execute: async (_id, params) => {
			const path = skillPath(root, params.name); return result((await readFile(path, "utf8")).slice(0, 50_000), { name: params.name, path });
		} }),
		defineTool({ name: "skill_create", label: "Create Skill", description: "Create a durable instruction-only Agent Skill after a workflow proves reusable. Requires approval. Never put credentials in skills.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }), description: Type.String({ minLength: 10, maxLength: 1024 }), instructions: Type.String({ minLength: 20, maxLength: 30_000 }) }), execute: async (_id, params) => {
			const path = skillPath(root, params.name); await mkdir(resolve(path, ".."), { recursive: true });
			try { await readFile(path, "utf8"); throw new Error(`Skill ${params.name} already exists; use skill_update`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await writeFile(path, renderSkill(params), { encoding: "utf8", flag: "wx" }); markReloadNeeded(); return result(`Created and queued skill ${params.name} for hot reload after this turn.`, { name: params.name, path });
		} }),
		defineTool({ name: "skill_update", label: "Update Skill", description: "Replace a managed instruction-only Agent Skill after learning a better verified workflow. Requires approval.", parameters: Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }), description: Type.String({ minLength: 10, maxLength: 1024 }), instructions: Type.String({ minLength: 20, maxLength: 30_000 }) }), execute: async (_id, params) => {
			const path = skillPath(root, params.name); await readFile(path, "utf8"); await writeFile(path, renderSkill(params), "utf8"); markReloadNeeded(); return result(`Updated and queued skill ${params.name} for hot reload after this turn.`, { name: params.name, path });
		} }),
	];
	const evolveSkill: ToolPolicy = { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "high", reversible: "unknown", impact: "Changes durable instructions that influence future Agent behavior" };
	const policies: Record<string, ToolPolicy> = {
		skill_list: { ...READ_ONLY_TOOL_POLICY },
		skill_read: { ...READ_ONLY_TOOL_POLICY },
		skill_create: { ...evolveSkill, reversible: true },
		skill_update: evolveSkill,
	};
	return tools.map((tool) => withToolPolicy(tool, policies[tool.name]!));
}
async function listSkills(root: string): Promise<Array<{ name: string; description: string; sha256: string; managed: boolean }>> {
	let entries: string[]; try { entries = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const result: Array<{ name: string; description: string; sha256: string; managed: boolean }> = [];
	for (const name of entries.sort()) { if (!SKILL_NAME.test(name)) continue; try { const content = await readFile(skillPath(root, name), "utf8"); result.push({ name, description: content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "(no description)", sha256: createHash("sha256").update(content).digest("hex"), managed: /managed-by:\s*beemax\b/.test(content) }); } catch { /* Ignore incomplete directories. */ } }
	return result;
}
function skillPath(root: string, name: string): string { if (!SKILL_NAME.test(name) || name.length > 64) throw new Error(`Invalid skill name: ${name}`); const path = resolve(root, name, "SKILL.md"); if (!path.startsWith(`${root}${sep}`)) throw new Error("Skill path escaped managed directory"); return path; }
function renderSkill(input: { name: string; description: string; instructions: string }): string { const description = input.description.replace(/[\r\n]+/g, " ").trim(); return `---\nname: ${input.name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  managed-by: beemax\n---\n\n# ${input.name}\n\n${input.instructions.trim()}\n`; }
function result(text: string, details: unknown) { return { content: [{ type: "text" as const, text }], details }; }

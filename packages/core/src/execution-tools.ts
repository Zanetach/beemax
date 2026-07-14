import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { relative, resolve, sep } from "node:path";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import type { ExecutionPort } from "./execution.ts";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, withToolPolicy } from "./tool-runtime.ts";

export function createExecutionTools(source: BeeMaxRuntimeSource, cwd: string, execution: ExecutionPort): ToolDefinition[] {
	const tools = [
		defineTool({
			name: "bash",
			label: "Run Command",
			description: "Run a shell command through BeeMax's configured execution backend. Requires approval.",
			parameters: Type.Object({
				command: Type.String({ minLength: 1, maxLength: 20_000 }),
				timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
			}),
			execute: async (_id, params, signal) => {
				const result = await execution.execute({ source, command: params.command, cwd, timeoutMs: (params.timeout ?? 180) * 1_000, signal });
				return { content: [{ type: "text" as const, text: [result.stdout, result.stderr].filter(Boolean).join("\n") || `(exit ${result.exitCode})` }], details: result, isError: result.exitCode !== 0 };
			},
		}),
		defineTool({
			name: "read",
			label: "Read File",
			description: "Read a workspace file through BeeMax's configured execution backend.",
			parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
			execute: async (_id, params, signal) => {
				const path = workspacePath(cwd, params.path);
				const content = await execution.readFile({ source, cwd, path, signal });
				return { content: [{ type: "text" as const, text: content.slice(0, 100_000) }], details: { path } };
			},
		}),
		defineTool({
			name: "write",
			label: "Write File",
			description: "Write a workspace file through BeeMax's configured execution backend. Requires approval.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				content: Type.String({ maxLength: 1_000_000 }),
				idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Stable identity for safely detecting repeated execution of the same intended write" })),
			}),
			execute: async (_id, params, signal) => {
				const path = workspacePath(cwd, params.path);
				await execution.writeFile({ source, cwd, path, signal }, params.content);
				const externalRef = `workspace:${relative(cwd, path).replaceAll("\\", "/") || "."}`;
				return {
					content: [{ type: "text" as const, text: `Wrote ${path}` }],
					details: {
						path,
						beemaxEffect: {
							operation: "write workspace file",
							externalRef,
							...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
						},
					},
				};
			},
		}),
	];
	return tools.map((tool) => withToolPolicy(tool, tool.name === "read"
		? { ...READ_ONLY_TOOL_POLICY, impact: "Reads one file inside the configured workspace" }
		: { ...MUTATING_TOOL_POLICY, sideEffect: "local", impact: tool.name === "write" ? "Writes one file inside the configured workspace" : "Runs a command through the configured execution backend" }));
}

function workspacePath(cwd: string, input: string): string {
	const path = resolve(cwd, input); const rel = relative(cwd, path);
	if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Tool path is outside the configured workspace");
	return path;
}

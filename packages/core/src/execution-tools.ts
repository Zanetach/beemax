import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { relative, resolve, sep } from "node:path";
import type { ThruveraRuntimeSource } from "./runtime.ts";
import type { ExecutionPort } from "./execution.ts";
import { MUTATING_TOOL_POLICY, READ_ONLY_TOOL_POLICY, withToolPolicy } from "./tool-runtime.ts";
import { createArtifactManifest } from "./artifact-runtime.ts";

export function createExecutionTools(source: ThruveraRuntimeSource, cwd: string, execution: ExecutionPort): ToolDefinition[] {
	const tools = [
		defineTool({
			name: "bash",
			label: "Run Command",
			description: "Run a shell command through Thruvera's configured execution backend.",
			parameters: Type.Object({
				command: Type.String({ minLength: 1, maxLength: 20_000 }),
				timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
			}),
			execute: async (_id, params, signal) => {
				const result = await execution.execute({ source, command: params.command, cwd, timeoutMs: (params.timeout ?? 180) * 1_000, signal });
				return { content: [{ type: "text" as const, text: [result.stdout, result.stderr].filter(Boolean).join("\n") || `(exit ${result.exitCode})` }], details: result, isError: result.exitCode !== 0 };
			},
		}),
		Object.assign(defineTool({
			name: "read",
			label: "Read File",
			description: "Read a workspace file through Thruvera's configured execution backend.",
			parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
			execute: async (_id, params, signal) => {
				const path = workspacePath(cwd, params.path);
				const content = await execution.readFile({ source, cwd, path, signal });
				return { content: [{ type: "text" as const, text: content.slice(0, 100_000) }], details: { path } };
			},
		}), { aliases: ["读取文件", "查看文件", "读取 HTML", "read file", "open file", "read HTML"], triggers: ["再次读取", "读取本地文件", "读取该 HTML", "读取现有 HTML", "read back", "read the file", "read the existing HTML", "read and edit the existing HTML file"] }),
		Object.assign(defineTool({
			name: "write",
			label: "Write File",
			description: "Write a workspace file through Thruvera's configured execution backend. Keep ordinary reports under 18,000 characters and finish them in one complete replace call. Only genuinely longer requested artifacts should use complete chunks: replace first, then append with the prior receipt's exact byte length and SHA-256.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				content: Type.String({ maxLength: 1_000_000 }),
				mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")], { description: "replace (default), or checksum-guarded append for the next complete chunk" })),
				expectedByteLength: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000, description: "Required for append; exact byteLength from the preceding write receipt" })),
				expectedSha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", description: "Required for append; exact sha256 from the preceding write receipt" })),
				mediaType: Type.Optional(Type.String({ minLength: 3, maxLength: 128, description: "Declared media type when this write produces an Artifact that must be independently verified" })),
				idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Stable identity for safely detecting repeated execution of the same intended write" })),
			}),
			execute: async (_id, params, signal) => {
				const path = workspacePath(cwd, params.path);
				const mode = params.mode ?? "replace";
				let completeContent = params.content;
				if (mode === "append") {
					if (params.expectedByteLength === undefined || !params.expectedSha256) throw new Error("Append requires expectedByteLength and expectedSha256 from the preceding write receipt");
					const existing = await execution.readFile({ source, cwd, path, signal });
					const existingBytes = Buffer.from(existing, "utf8");
					const existingSha256 = createHash("sha256").update(existingBytes).digest("hex");
					if (existingBytes.byteLength !== params.expectedByteLength || existingSha256 !== params.expectedSha256) throw new Error("Current workspace file does not match expected append base; refusing a duplicate or out-of-order chunk");
					completeContent = existing + params.content;
				}
				await execution.writeFile({ source, cwd, path, signal }, completeContent);
				const externalRef = `workspace:${relative(cwd, path).replaceAll("\\", "/") || "."}`;
				const bytes = Buffer.from(completeContent, "utf8");
				const sha256 = createHash("sha256").update(bytes).digest("hex");
				const artifactManifest = params.mediaType ? createArtifactManifest({
					locator: { kind: "workspace", uri: externalRef }, mediaType: params.mediaType, byteLength: bytes.byteLength,
					sha256, producer: { providerId: "beemax.workspace-write", providerVersion: "1", operation: "write" }, sourceRefs: [], createdAt: Date.now(),
				}) : undefined;
				return {
					content: [{ type: "text" as const, text: `Wrote ${path} (${bytes.byteLength} bytes; sha256 ${sha256})` }],
						details: {
						path,
						byteLength: bytes.byteLength,
						sha256,
						...(artifactManifest ? { artifactManifest } : {}),
						beemaxEffect: {
							operation: mode === "append" ? "append workspace file" : "write workspace file",
							externalRef,
							...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
						},
					},
				};
			},
		}), { aliases: ["写入文件", "保存文件", "修改文件", "编辑文件", "修正文件", "保存草稿", "交付 HTML", "生成 HTML", "HTML 文件", ".html", "write file", "edit file", "update file", "save file", "save the draft", "deliver HTML", "create HTML"], triggers: ["写入本地文件", "保存到本地文件", "在 workspace 中交付 HTML", "生成 HTML 文件", "必要时修正", "修正现有文件", "修改现有文件", "编辑现有文件", "修正 HTML", "write to a file", "edit the existing HTML file", "read and edit the existing HTML file", "update the existing file", "save the draft", "deliver an HTML file to the workspace"] }),
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

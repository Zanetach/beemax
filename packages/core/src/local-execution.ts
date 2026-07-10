import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { ExecutionFileRequest, ExecutionPort, ExecutionRequest, ExecutionResult } from "./execution.ts";

const execFileAsync = promisify(execFile);

/** Explicit host execution backend; policy selects it only for trusted flows. */
export class LocalExecutionPort implements ExecutionPort {
	async readFile(request: ExecutionFileRequest): Promise<string> { return readFile(request.path, "utf8"); }
	async writeFile(request: ExecutionFileRequest, content: string): Promise<void> { await writeFile(request.path, content, "utf8"); }
	async execute(request: ExecutionRequest): Promise<ExecutionResult> {
		try {
			const { stdout, stderr } = await execFileAsync("sh", ["-lc", request.command], {
			cwd: request.cwd,
			timeout: request.timeoutMs ?? 180_000,
			maxBuffer: 4 * 1024 * 1024,
		});
			return { exitCode: 0, stdout, stderr };
		} catch (error) {
			return executionErrorResult(error);
		}
	}
}

function executionErrorResult(error: unknown): ExecutionResult {
	const value = error instanceof Error ? error as Error & { code?: unknown; stdout?: unknown; stderr?: unknown } : undefined;
	return {
		exitCode: typeof value?.code === "number" ? value.code : 1,
		stdout: typeof value?.stdout === "string" ? value.stdout : "",
		stderr: typeof value?.stderr === "string" ? value.stderr : String(error),
	};
}

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { executionErrorResult, type ExecutionFileRequest, type ExecutionPort, type ExecutionRequest, type ExecutionResult } from "./execution.ts";

const execFileAsync = promisify(execFile);

/** Explicit host execution backend; policy selects it only for trusted flows. */
export class LocalExecutionPort implements ExecutionPort {
	async readFile(request: ExecutionFileRequest): Promise<string> { return readFile(request.path, { encoding: "utf8", signal: request.signal }); }
	async writeFile(request: ExecutionFileRequest, content: string): Promise<void> {
		await mkdir(dirname(request.path), { recursive: true });
		await writeFile(request.path, content, { encoding: "utf8", signal: request.signal });
	}
	async execute(request: ExecutionRequest): Promise<ExecutionResult> {
		try {
			const { stdout, stderr } = await execFileAsync("sh", ["-lc", request.command], {
			cwd: request.cwd,
			timeout: request.timeoutMs ?? 180_000,
			maxBuffer: 4 * 1024 * 1024,
			signal: request.signal,
		});
			return { exitCode: 0, stdout, stderr };
		} catch (error) {
			return executionErrorResult(error);
		}
	}
}

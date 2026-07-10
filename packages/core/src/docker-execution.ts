import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ExecutionFileRequest, ExecutionPort, ExecutionRequest, ExecutionResult } from "./execution.ts";

const execFileAsync = promisify(execFile);

export interface DockerExecutionOptions {
	image: string;
	timeoutMs: number;
	workspaceAccess: "none" | "ro" | "rw";
	workspace?: string;
}

/** One-shot hardened Docker execution. Host workspace is mounted only by explicit policy. */
export class DockerExecutionPort implements ExecutionPort {
	private readonly options: DockerExecutionOptions;
	constructor(options: DockerExecutionOptions) { this.options = options; }
	async readFile(request: ExecutionFileRequest): Promise<string> {
		const path = this.containerPath(request);
		const result = await this.execute({ source: request.source, cwd: request.cwd, command: `cat -- ${quote(path)}` });
		if (result.exitCode !== 0) throw new Error(result.stderr || `Could not read ${request.path}`);
		return result.stdout;
	}
	async writeFile(request: ExecutionFileRequest, content: string): Promise<void> {
		const path = this.containerPath(request);
		const encoded = Buffer.from(content, "utf8").toString("base64");
		const result = await this.execute({ source: request.source, cwd: request.cwd, command: `printf %s ${quote(encoded)} | base64 -d > ${quote(path)}` });
		if (result.exitCode !== 0) throw new Error(result.stderr || `Could not write ${request.path}`);
	}

	async execute(request: ExecutionRequest): Promise<ExecutionResult> {
		const args = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--pids-limit", "256", "--memory", "2048m", "--cpus", "1"];
		if (this.options.workspaceAccess !== "none" && this.options.workspace) {
			args.push("--mount", `type=bind,src=${this.options.workspace},dst=/workspace${this.options.workspaceAccess === "ro" ? ",readonly" : ""}`);
		}
		args.push("--tmpfs", "/tmp:rw,noexec,nosuid,size=256m", "-w", this.options.workspaceAccess === "none" ? "/tmp" : "/workspace", this.options.image, "sh", "-lc", request.command);
		try {
			const { stdout, stderr } = await execFileAsync("docker", args, { timeout: request.timeoutMs ?? this.options.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
			return { exitCode: 0, stdout, stderr };
		} catch (error) {
			return executionErrorResult(error);
		}
	}

	private containerPath(request: ExecutionFileRequest): string {
		if (this.options.workspaceAccess === "none" || !this.options.workspace) {
			throw new Error("File access is disabled by the Docker sandbox policy");
		}
		const workspace = resolve(this.options.workspace);
		const file = resolve(request.path);
		const pathWithinWorkspace = relative(workspace, file);
		if (pathWithinWorkspace === ".." || pathWithinWorkspace.startsWith(`..${sep}`)) {
			throw new Error("Sandbox file path is outside the configured workspace");
		}
		return pathWithinWorkspace ? `/workspace/${pathWithinWorkspace.split(sep).join("/")}` : "/workspace";
	}
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function executionErrorResult(error: unknown): ExecutionResult {
	const value = error instanceof Error ? error as Error & { code?: unknown; stdout?: unknown; stderr?: unknown } : undefined;
	return {
		exitCode: typeof value?.code === "number" ? value.code : 1,
		stdout: typeof value?.stdout === "string" ? value.stdout : "",
		stderr: typeof value?.stderr === "string" ? value.stderr : String(error),
	};
}

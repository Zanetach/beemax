import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ExecutionFileRequest, ExecutionPort, ExecutionRequest, ExecutionResult } from "./execution.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_DOCKER_SANDBOX_LIMITS = Object.freeze({
	memoryBytes: 2 * 1024 * 1024 * 1024,
	cpus: 1,
	pids: 256,
	tmpfsBytes: 256 * 1024 * 1024,
	maxOutputBytes: 4 * 1024 * 1024,
	nofile: 1_024,
});

export interface DockerExecutionOptions {
	profileId: string;
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
		const result = await this.execute({ source: request.source, cwd: request.cwd, command: `cat -- ${quote(path)}`, signal: request.signal });
		if (result.exitCode !== 0) throw new Error(result.stderr || `Could not read ${request.path}`);
		return result.stdout;
	}
	async writeFile(request: ExecutionFileRequest, content: string): Promise<void> {
		if (this.options.workspaceAccess !== "rw") throw new Error("Docker Execution Sandbox write requires read-write workspace access");
		const path = this.containerPath(request);
		const result = await this.run({ source: request.source, cwd: request.cwd, command: `cat > ${quote(path)}`, signal: request.signal }, content);
		if (result.exitCode !== 0) throw new Error(result.stderr || `Could not write ${request.path}`);
	}

	async execute(request: ExecutionRequest): Promise<ExecutionResult> {
		return this.run(request);
	}

	private async run(request: ExecutionRequest, stdin?: string): Promise<ExecutionResult> {
		const name = `beemax-sandbox-${randomUUID()}`;
		const limits = DEFAULT_DOCKER_SANDBOX_LIMITS;
		const args = [
			"run", "--rm", ...(stdin === undefined ? [] : ["-i"]), "--name", name,
			"--label", "com.beemax.sandbox=execution", "--label", `com.beemax.profile=${this.options.profileId}`,
			"--init", "--network", "none", "--ipc", "none", "--read-only", "--cap-drop", "ALL",
			"--security-opt", "no-new-privileges:true", "--pids-limit", String(limits.pids),
			"--memory", String(limits.memoryBytes), "--cpus", String(limits.cpus),
			"--ulimit", `nofile=${limits.nofile}:${limits.nofile}`,
		];
		if (this.options.workspaceAccess !== "none" && this.options.workspace) {
			args.push("--mount", `type=bind,src=${this.options.workspace},dst=/workspace${this.options.workspaceAccess === "ro" ? ",readonly" : ""}`);
		}
		args.push("--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpfsBytes}`, "-w", this.options.workspaceAccess === "none" ? "/tmp" : "/workspace", this.options.image, "sh", "-lc", request.command);
		try {
			const invocation = execFileAsync("docker", args, { timeout: boundedTimeout(request.timeoutMs, this.options.timeoutMs), maxBuffer: limits.maxOutputBytes, signal: request.signal });
			if (stdin !== undefined) invocation.child?.stdin?.end(stdin);
			const { stdout, stderr } = await invocation;
			return { exitCode: 0, stdout, stderr };
		} catch (error) {
			await removeContainer(name);
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

async function removeContainer(name: string): Promise<void> {
	try { await execFileAsync("docker", ["rm", "-f", name], { timeout: 5_000, maxBuffer: 64 * 1024 }); } catch { /* Container may already be removed or Docker may be unavailable. */ }
}

function boundedTimeout(requested: number | undefined, configured: number): number {
	const hardLimit = Number.isFinite(configured) && configured >= 1 ? configured : 180_000;
	const desired = Number.isFinite(requested) && Number(requested) >= 1 ? Number(requested) : hardLimit;
	return Math.min(desired, hardLimit);
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

import type { BeeMaxRuntimeSource } from "./runtime.ts";

export type ExecutionBackend = "local" | "docker";
export type SandboxMode = "off" | "all";
export type WorkspaceAccess = "none" | "ro" | "rw";

export interface ExecutionPolicy {
	backend: ExecutionBackend;
	mode: SandboxMode;
	workspaceAccess: WorkspaceAccess;
	timeoutMs: number;
}

export interface ExecutionRequest {
	source: BeeMaxRuntimeSource;
	command: string;
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ExecutionFileRequest {
	source: BeeMaxRuntimeSource;
	/** Host workspace used to validate and map file access. */
	cwd: string;
	/** Absolute path already constrained to cwd by the caller. */
	path: string;
	signal?: AbortSignal;
}

export interface ExecutionResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Infrastructure port: Core asks for execution without knowing Docker or SSH. */
export interface ExecutionPort {
	execute(request: ExecutionRequest): Promise<ExecutionResult>;
	readFile(request: ExecutionFileRequest): Promise<string>;
	writeFile(request: ExecutionFileRequest, content: string): Promise<void>;
}

/** Normalize child-process failures without coupling execution adapters to Node's error shape. */
export function executionErrorResult(error: unknown): ExecutionResult {
	const value = error instanceof Error ? error as Error & { code?: unknown; stdout?: unknown; stderr?: unknown } : undefined;
	return {
		exitCode: typeof value?.code === "number" ? value.code : 1,
		stdout: typeof value?.stdout === "string" ? value.stdout : "",
		stderr: typeof value?.stderr === "string" ? value.stderr : String(error),
	};
}

export function resolveExecutionBackend(policy: Pick<ExecutionPolicy, "backend" | "mode">, source: BeeMaxRuntimeSource): ExecutionBackend {
	if (policy.mode === "off") return "local";
	if (policy.backend !== "docker") throw new Error("Sandbox mode 'all' requires the Docker Execution Sandbox");
	return policy.backend;
}

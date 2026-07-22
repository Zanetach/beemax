import { DockerExecutionPort, LocalExecutionPort, resolveExecutionBackend, type ExecutionPort } from "@thruvera/core";
import type { SessionSource } from "@thruvera/channel-runtime";
import type { ThruveraConfig } from "./config.ts";

/** Infrastructure composition only: Core selects no Docker policy itself. */
export function executionPortFor(config: ThruveraConfig): (source: SessionSource) => ExecutionPort {
	const local = new LocalExecutionPort();
	const docker = new DockerExecutionPort({
		profileId: config.profile,
		image: config.execution.image,
		timeoutMs: config.execution.timeoutMs,
		workspaceAccess: config.execution.workspaceAccess,
		workspace: config.paths.cwd,
	});
	return (source) => resolveExecutionBackend(config.execution, source) === "docker" ? docker : local;
}

/** Prevent Pi's host-bound filesystem tools bypassing a selected sandbox. */
export function executionSafeTools(config: ThruveraConfig, tools: string[]): string[] {
	if (config.execution.mode === "off") return tools;
	return tools.filter((name) => !["edit", "grep", "find", "ls"].includes(name));
}

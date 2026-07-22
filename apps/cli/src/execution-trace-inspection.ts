import { FileExecutionTraceStore, type ExecutionTrace } from "@thruvera/core";
import { join } from "node:path";

export function inspectProfileExecutionTrace(agentDir: string, executionId: string, accessScopeId?: string): ExecutionTrace | undefined {
	const store = new FileExecutionTraceStore(join(agentDir, "logs", "execution-trace.jsonl"));
	return store.trace({ executionId, ...(accessScopeId ? { accessScopeId } : {}) });
}

export function renderExecutionTrace(trace: ExecutionTrace): string {
	const identity = [trace.executionId, trace.objectiveId && `objective=${trace.objectiveId}`, trace.taskId && `task=${trace.taskId}`, trace.taskRunId && `run=${trace.taskRunId}`].filter(Boolean).join("; ");
	const lifecycle = `status=${trace.status ?? "running"}; mode=${trace.mode}; trigger=${trace.triggerKind}; duration=${trace.durationMs ?? "running"}ms`;
	const resources = `turns=${trace.modelTurns}; tools=${trace.toolCalls}; effects=${trace.effects}; unknown-effects=${trace.unknownEffects}; checkpoints=${trace.checkpoints}; verifications=${trace.verifications}; deliveries=${trace.deliveries}`;
	const usage = `tokens=input:${trace.inputTokens},output:${trace.outputTokens},cache-read:${trace.cacheReadTokens},cache-write:${trace.cacheWriteTokens}; cost-usd=${trace.costUsd}`;
	const outcomes = [trace.verificationStatus && `verification=${trace.verificationStatus}`, trace.deliveryStatus && `delivery=${trace.deliveryStatus}`].filter(Boolean).join("; ");
	return [identity, lifecycle, resources, usage, outcomes, "Events:", ...trace.events.map((event) => `${event.sequence}. ${event.type} @ ${new Date(event.at).toISOString()}${event.status ? ` · ${event.status}` : ""}`)].filter(Boolean).join("\n");
}

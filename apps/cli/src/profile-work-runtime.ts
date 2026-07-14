import {
	AutonomousPlanningPolicy,
	FileExecutionTraceStore,
	FileToolEffectJournal,
	ObjectiveRuntime,
	ProfileTaskScheduler,
	SubagentManager,
	TaskPlanRuntime,
	TaskRecoveryRunner,
	TaskRecoveryService,
	DEFAULT_RUNTIME_RESOURCE_LIMITS,
	resolveRuntimeTaskConcurrency,
	type ObjectiveDeliverer,
	type SubagentExecutor,
	type TaskGraphExecutor,
	type TaskGraphVerifier,
	type TaskGraphVerificationContext,
	type TaskGraphExecutionResult,
	type TaskRecord,
	type ExecutionTraceSink,
	type TaskRecoveryCycleResult,
	type DirectObjectiveVerificationNotifier,
	type VerifiedObjectiveMemoryPublisher,
	type TaskLedger,
} from "@beemax/core";
import { join } from "node:path";
import type { TaskRecoveryStatus } from "./profile-control.ts";
import type { ProfileRuntimeResource } from "./runtime-composition.ts";

export interface ProfileWorkRuntimeOptions {
	agentDir: string;
	ledger: TaskLedger;
	recoveryQueue?: Pick<TaskLedger, "reconcileExpiredTaskRuns">;
	maxConcurrent: number;
	maxSubagents: number;
	taskTimeoutMs: number;
	subagentsEnabled: boolean;
	backgroundRecoveryEnabled?: boolean;
	executeTask: (task: TaskRecord, signal: AbortSignal | undefined, context: Parameters<TaskGraphExecutor>[2], executionTrace: ExecutionTraceSink, effectAuthority: FileToolEffectJournal) => ReturnType<TaskGraphExecutor>;
	verifyTaskCandidate: (task: TaskRecord, result: TaskGraphExecutionResult, signal: AbortSignal | undefined, context: TaskGraphVerificationContext | undefined, executionTrace: ExecutionTraceSink) => ReturnType<TaskGraphVerifier>;
	deliverObjective: (input: Parameters<ObjectiveDeliverer>[0], signal: AbortSignal | undefined, executionTrace: ExecutionTraceSink) => ReturnType<ObjectiveDeliverer>;
	publishVerifiedOutcome?: VerifiedObjectiveMemoryPublisher;
	executeSubagent: (task: Parameters<SubagentExecutor>[0], signal: Parameters<SubagentExecutor>[1], executionTrace: ExecutionTraceSink) => ReturnType<SubagentExecutor>;
	onTaskPlanError?: (event: { planId: string; error: unknown }) => void;
	onRecoveryStatus?: (status: TaskRecoveryStatus, cycle?: TaskRecoveryCycleResult) => void;
	onRecoveryError?: (error: unknown) => void;
	deliverDirectObjectiveVerification?: DirectObjectiveVerificationNotifier;
}

/**
 * Channel-neutral durable work graph for one Profile. Channels supply only
 * execution and presentation adapters; Task lifecycle wiring lives here.
 */
export function createProfileWorkRuntime(options: ProfileWorkRuntimeOptions) {
	// Perform fallible local I/O before starting recovery timers or accepting work.
	const maxConcurrent = resolveRuntimeTaskConcurrency(options.maxConcurrent);
	const executionTrace = new FileExecutionTraceStore(join(options.agentDir, "logs", "execution-trace.jsonl"));
	const toolEffects = new FileToolEffectJournal(join(options.agentDir, "tool-effects.jsonl"), 5_000, executionTrace);
	const taskScheduler = new ProfileTaskScheduler({
		maxConcurrent,
		maxQueued: DEFAULT_RUNTIME_RESOURCE_LIMITS.taskQueueMax,
		maxQueuedPerOwner: DEFAULT_RUNTIME_RESOURCE_LIMITS.taskQueueMaxPerOwner,
	});
	const planningPolicy = new AutonomousPlanningPolicy({ maxConcurrent, maxSubagents: options.maxSubagents });
	const planningBudgets = planningPolicy.createBudgetRegistry();
	const taskPlanRuntime = new TaskPlanRuntime((event) => options.onTaskPlanError?.(event));
	const verifyTask: TaskGraphVerifier = (task, result, signal, context) => taskScheduler.run(task.ownerKey, () => options.verifyTaskCandidate(task, result, signal, context, executionTrace), signal);
	const taskRecovery = new TaskRecoveryRunner(
		options.ledger,
		(task, signal, context) => taskScheduler.run(task.ownerKey, () => options.executeTask(task, signal, context, executionTrace, toolEffects), signal),
		taskPlanRuntime,
		verifyTask,
		executionTrace,
		options.deliverDirectObjectiveVerification,
	);
	const backgroundRecoveryEnabled = options.backgroundRecoveryEnabled !== false;
	let recoveryStatus: TaskRecoveryStatus = emptyRecoveryStatus(options.subagentsEnabled && backgroundRecoveryEnabled ? "running" : "disabled");
	const recoveryService = new TaskRecoveryService(options.recoveryQueue ?? options.ledger, options.subagentsEnabled ? taskRecovery : undefined, {
		effectAuthority: toolEffects,
		runnerOptions: { maxConcurrent },
		onCycle: (cycle) => {
			recoveryStatus = {
				phase: options.subagentsEnabled ? "completed" : "disabled",
				plans: cycle.recovery.plans,
				succeeded: cycle.recovery.succeeded,
				failed: cycle.recovery.failed,
				blocked: cycle.recovery.blocked.length,
				verification: cycle.verification,
			};
			options.onRecoveryStatus?.(recoveryStatus, cycle);
		},
		onError: (error) => {
			recoveryStatus = { ...recoveryStatus, phase: "failed" };
			options.onRecoveryStatus?.(recoveryStatus);
			options.onRecoveryError?.(error);
		},
	});
	if (backgroundRecoveryEnabled) recoveryService.start();
	const objectiveRuntime = new ObjectiveRuntime(options.ledger, (input, signal) => options.deliverObjective(input, signal, executionTrace), options.publishVerifiedOutcome);
	const subagents = options.subagentsEnabled ? new SubagentManager({
		maxConcurrent,
		maxChildrenPerOwner: options.maxSubagents,
		defaultTimeoutMs: options.taskTimeoutMs,
		taskLedger: options.ledger,
		safeRetry: true,
		admit: (ownerKey, work, signal) => taskScheduler.run(ownerKey, work, signal),
		execute: (task, signal) => options.executeSubagent(task, signal, executionTrace),
		// A single Delegation already owns one scheduler admission while TaskGraph
		// sequences Pi execution and Verification, so Verification must not re-enter
		// the same capacity gate and deadlock a maxConcurrent=1 Profile.
		verify: (task, result, signal, context) => options.verifyTaskCandidate(task, result, signal, context, executionTrace),
		maxCorrectiveAttempts: 1,
	}) : undefined;
	const resources: ProfileRuntimeResource[] = [
		{ name: "effects", dispose: () => toolEffects.close() },
		{ name: "task-plan", dispose: () => taskPlanRuntime.shutdown(new Error("Profile Runtime shutting down")) },
		{ name: "recovery", dispose: () => recoveryService.stop(new Error("Profile Runtime shutting down")) },
		...(subagents ? [{ name: "subagents", dispose: () => subagents.dispose() }] : []),
	];
	return {
		taskScheduler,
		planningPolicy,
		planningBudgets,
		taskPlanRuntime,
		verifyTask,
		taskRecovery,
		recoveryService,
		objectiveRuntime,
		subagents,
		toolEffects,
		executionTrace,
		resources,
		recoveryStatus: () => recoveryStatus,
	};
}

function emptyRecoveryStatus(phase: TaskRecoveryStatus["phase"]): TaskRecoveryStatus {
	return { phase, plans: 0, succeeded: 0, failed: 0, blocked: 0, verification: { attempted: 0, accepted: 0, rejected: 0, unavailable: 0 } };
}

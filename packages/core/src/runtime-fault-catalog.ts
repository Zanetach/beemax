export const RUNTIME_FAULT_KINDS = [
	"pi_crash",
	"tool_timeout",
	"process_exit",
	"restart",
	"multi_instance_claim",
	"unknown_effect",
	"verification_unavailable",
	"delivery_failure",
	"compaction",
	"steering",
	"correction",
] as const;

export type RuntimeFaultKind = typeof RUNTIME_FAULT_KINDS[number];

/** Runtime-level recovery contract. It intentionally contains no enterprise business rules. */
export interface RuntimeFaultDefinition {
	kind: RuntimeFaultKind;
	observableState: readonly string[];
	automaticRecovery: string;
	operatorRecovery: readonly string[];
	releaseEvidence: readonly string[];
}

export interface RuntimeFaultCoverageAssessment {
	passed: boolean;
	missingFaults: RuntimeFaultKind[];
	missingObservability: RuntimeFaultKind[];
	missingOperatorRecovery: RuntimeFaultKind[];
	missingReleaseEvidence: RuntimeFaultKind[];
}

export const RUNTIME_FAULT_CATALOG: readonly RuntimeFaultDefinition[] = [
	{
		kind: "pi_crash",
		observableState: ["Task Run lease", "Task Checkpoint", "Execution Trace"],
		automaticRecovery: "Expire the interrupted run, preserve its checkpoint, and resume only an idempotent safe-retry Task.",
		operatorRecovery: ["Inspect /tasks show <plan-id> and thruvera trace show <execution-id>.", "Use /tasks retry <plan-id> only after unresolved Effects are reconciled."],
		releaseEvidence: ["p7-task-recovery-acceptance", "tool-effect crash recovery"],
	},
	{
		kind: "tool_timeout",
		observableState: ["unknown Effect", "effect.settled trace event"],
		automaticRecovery: "Block replay while mutation outcome is unknown.",
		operatorRecovery: ["Run thruvera effect list --status unknown.", "Observe the external system, then run thruvera effect reconcile <id> --status committed|failed."],
		releaseEvidence: ["tool-effect timeout", "effect-inspection"],
	},
	{
		kind: "process_exit",
		observableState: ["expired Task Run lease", "durable Task state", "durable Effect state"],
		automaticRecovery: "Reconcile expired leases on the next recovery cycle without replaying unresolved Effects.",
		operatorRecovery: ["Run thruvera gateway status and thruvera gateway logs.", "Inspect /tasks plans and unknown Effects."],
		releaseEvidence: ["worker process crash", "task recovery reconciliation"],
	},
	{
		kind: "restart",
		observableState: ["recovery cycle status", "Task Plan status", "delivery outbox state"],
		automaticRecovery: "Reopen durable stores and reclaim expired recovery and delivery leases.",
		operatorRecovery: ["Run thruvera status --deep and /status.", "Inspect failed Plans before an explicit retry."],
		releaseEvidence: ["durable restart recovery", "delivery lease reclaim"],
	},
	{
		kind: "multi_instance_claim",
		observableState: ["claim owner", "lease expiry", "single authority transition"],
		automaticRecovery: "Use atomic authority claims so only one live instance executes or settles work.",
		operatorRecovery: ["Inspect gateway logs and Task Runs.", "Stop an unintended duplicate gateway before retrying expired work."],
		releaseEvidence: ["multi-instance Task claims", "multi-instance Effect authority"],
	},
	{
		kind: "unknown_effect",
		observableState: ["Effect status", "idempotency key", "scope", "tool identity"],
		automaticRecovery: "Fail closed and prevent both Task replay and duplicate mutation.",
		operatorRecovery: ["Run thruvera effect list --status unknown.", "Reconcile from externally observed evidence; never infer success from model text."],
		releaseEvidence: ["effect-inspection", "reliability fault release gate"],
	},
	{
		kind: "verification_unavailable",
		observableState: ["Verification status", "verification feedback", "retry backoff"],
		automaticRecovery: "Keep candidate output unaccepted and retry Verification with bounded backoff without replaying execution.",
		operatorRecovery: ["Inspect /tasks show <plan-id>.", "Run /tasks verify <plan-id> when the verifier is available."],
		releaseEvidence: ["unavailable Verification retry", "candidate result isolation"],
	},
	{
		kind: "delivery_failure",
		observableState: ["outbox attempt count", "last delivery error", "delivery lease"],
		automaticRecovery: "Reclaim an expired delivery lease and retry the durable notice with bounded attempts.",
		operatorRecovery: ["Inspect /tasks show <plan-id> and gateway logs.", "Repair the channel adapter and allow the outbox retry cycle to continue."],
		releaseEvidence: ["delivery outbox failure", "delivery lease reclaim"],
	},
	{
		kind: "compaction",
		observableState: ["Task Preservation Envelope", "Checkpoint", "compaction trace event"],
		automaticRecovery: "Rehydrate active responsibility from the durable Task Ledger and Checkpoint, not chat history.",
		operatorRecovery: ["Inspect /tasks show <plan-id> and thruvera trace show <execution-id>.", "Use /resume <session-id> if the conversation session also changed."],
		releaseEvidence: ["runtime boundary compaction", "checkpoint preservation"],
	},
	{
		kind: "steering",
		observableState: ["interaction journal", "queued input", "execution trace"],
		automaticRecovery: "Serialize steering against the active run and durably queue input that cannot be applied immediately.",
		operatorRecovery: ["Inspect /status and the interaction trace.", "Resend only if the queued input is absent after restart."],
		releaseEvidence: ["interaction steering", "queued input startup replay"],
	},
	{
		kind: "correction",
		observableState: ["Verification feedback", "corrective attempt count", "superseded Memory evidence"],
		automaticRecovery: "Run bounded correction only for an explicitly safe-retry Task and preserve rejected evidence.",
		operatorRecovery: ["Inspect /tasks show <plan-id> and memory explain output.", "Run /tasks retry <plan-id> after correcting evidence or policy."],
		releaseEvidence: ["automatic correction", "correction budget", "Memory correction retention"],
	},
] as const;

export function assessRuntimeFaultCoverage(definitions: readonly RuntimeFaultDefinition[]): RuntimeFaultCoverageAssessment {
	const byKind = new Map<RuntimeFaultKind, RuntimeFaultDefinition>();
	for (const definition of definitions) if (!byKind.has(definition.kind)) byKind.set(definition.kind, definition);
	const missingFaults = RUNTIME_FAULT_KINDS.filter((kind) => !byKind.has(kind));
	const missingObservability = RUNTIME_FAULT_KINDS.filter((kind) => byKind.has(kind) && !hasText(byKind.get(kind)!.observableState));
	const missingOperatorRecovery = RUNTIME_FAULT_KINDS.filter((kind) => byKind.has(kind) && !hasText(byKind.get(kind)!.operatorRecovery));
	const missingReleaseEvidence = RUNTIME_FAULT_KINDS.filter((kind) => byKind.has(kind) && !hasText(byKind.get(kind)!.releaseEvidence));
	return {
		passed: missingFaults.length === 0 && missingObservability.length === 0 && missingOperatorRecovery.length === 0 && missingReleaseEvidence.length === 0,
		missingFaults,
		missingObservability,
		missingOperatorRecovery,
		missingReleaseEvidence,
	};
}

function hasText(values: readonly string[]): boolean {
	return values.length > 0 && values.every((value) => value.trim().length > 0);
}

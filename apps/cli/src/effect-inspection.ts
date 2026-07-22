import { join } from "node:path";
import { containsCredentialMaterial, FileExecutionTraceStore, FileToolEffectJournal, type ToolEffectRecord } from "@thruvera/core";

export function inspectProfileEffects(agentDir: string, status: ToolEffectRecord["status"] | "all" = "unknown"): ToolEffectRecord[] {
	const journal = openEffectAuthority(agentDir);
	try {
		const latest = new Map<string, ToolEffectRecord>();
		for (const event of journal.events()) latest.set(event.id, event);
		return [...latest.values()].filter((effect) => status === "all" || effect.status === status).sort((left, right) => right.at - left.at);
	} finally { journal.close(); }
}

export function reconcileProfileEffect(agentDir: string, effectId: string, resolution: { status: "committed" | "failed"; operation?: string; externalRef?: string }): ToolEffectRecord {
	if (!effectId.trim()) throw new Error("Effect identity is required");
	if (containsCredentialMaterial(JSON.stringify(resolution))) throw new Error("Effect reconciliation cannot contain credential material");
	if (resolution.status === "committed" && !resolution.operation?.trim()) throw new Error("Committed Effect reconciliation requires an observed operation");
	const journal = openEffectAuthority(agentDir);
	try {
		const before = journal.effect(effectId);
		if (!before) throw new Error(`Effect ${effectId} was not found`);
		if (before.status !== "unknown") throw new Error(`Effect ${effectId} is ${before.status}; only unknown Effects can be reconciled`);
		if (!journal.reconcile(effectId, resolution)) throw new Error(`Effect ${effectId} reconciliation lost an authority race`);
		return journal.effect(effectId)!;
	} finally { journal.close(); }
}

function openEffectAuthority(agentDir: string): FileToolEffectJournal {
	const trace = new FileExecutionTraceStore(join(agentDir, "logs", "execution-trace.jsonl"));
	return new FileToolEffectJournal(join(agentDir, "tool-effects.jsonl"), 5_000, trace);
}

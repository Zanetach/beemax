import type { TaskCriterionVerification } from "./task-ledger.ts";

export interface TaskCriterionDefinition { id: string; text: string; }

/** Stable, domain-agnostic criterion identities shared by execution and Verification. */
export function taskCriterionDefinitions(value: string | undefined): TaskCriterionDefinition[] {
	const items = (value ?? "Observable outcome is satisfied").split(/\r?\n/).map((line) => line.trim().replace(/^[-*]\s*/, "")).filter(Boolean);
	return (items.length ? items : ["Observable outcome is satisfied"]).slice(0, 50).map((text, index) => ({ id: `C${index + 1}`, text: text.slice(0, 2_000) }));
}

export function unavailableTaskCriterionVerifications(value: string | undefined, reason?: string): TaskCriterionVerification[] {
	const evidence = reason?.trim().slice(0, 5_000);
	return taskCriterionDefinitions(value).map(({ id, text }) => ({ criterionId: id, criterion: text, status: "unavailable", ...(evidence ? { evidence } : {}), evidenceRefs: [] }));
}

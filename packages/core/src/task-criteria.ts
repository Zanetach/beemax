import type { TaskCriterionVerification } from "./task-ledger.ts";
import { containsCredentialMaterial, redactCredentialMaterial } from "./credential-material.ts";

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

export function sanitizeTaskCriterionVerifications(value: TaskCriterionVerification[] | undefined): TaskCriterionVerification[] | undefined {
	if (!value) return undefined;
	const ids = new Set<string>();
	const verifications = value.slice(0, 100).flatMap((item) => {
		if (!item || !["accepted", "rejected", "unavailable"].includes(item.status)) return [];
		const criterionId = item.criterionId?.trim().slice(0, 128);
		const criterion = item.criterion?.trim().slice(0, 2_000);
		if (!criterionId || !criterion || ids.has(criterionId) || containsCredentialMaterial(`${criterionId}\n${criterion}`)) return [];
		const evidence = item.evidence?.trim() ? redactCredentialMaterial(item.evidence.trim()).slice(0, 5_000) : undefined;
		const evidenceRefs = [...new Set((item.evidenceRefs ?? []).slice(0, 50).map((ref) => ref.trim().slice(0, 1_000)).filter((ref) => ref && !containsCredentialMaterial(ref)))];
		ids.add(criterionId);
		return [{ criterionId, criterion, status: item.status, ...(evidence ? { evidence } : {}), evidenceRefs }];
	});
	return verifications.length ? verifications : undefined;
}

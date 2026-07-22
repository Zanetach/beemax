import { createHash, randomUUID } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import {
	containsCredentialMaterial,
	createExecutionEnvelope,
	type AppendLearningSignalInput,
	type ContextPackCommit,
	type ContextPackCommitResult,
	type ContributionReceipt,
	type CriterionOutcome,
	type LearningSettlement,
	type LearningExtractionBundle,
	type LearningExtractionClaim,
	type LearningExtractionCommitResult,
	type LearningObjectiveClaim,
	type LearningObjectiveCommitResult,
	type LearningProposal,
	type MaintenanceResult,
	type ManagedSkillLearningPort,
	type ManagedSkillPointerSnapshot,
	type ManagedSkillSelectionReceipt,
	type MaintainMemoryInput,
	type MemoryComponentKind,
	type MemoryComponentRef,
	type MemoryCandidateRecallInput,
	type MemoryLearningAuthorityPort,
	type MemoryObservation,
	type MemoryRecallCandidate,
	type MemoryRoutingAssessment,
	type ObservationReceipt,
	type OperationalRoutingReceipt,
	type PersistedContextPack,
	type ReadContextPackInput,
	type RegisterManagedSkillVersionInput,
	type RollbackManagedSkillVersionInput,
	type SelectManagedSkillVersionInput,
	type SettleLearningInput,
	type SituationFingerprint,
} from "@thruvera/core";

interface RecallHit {
	id: string;
	content: string;
	memoryType: "curated" | "claim" | "candidate";
	confidence: number;
	status: string;
	score: number;
	createdAt: number;
}

export interface SqliteMemoryLearningAuthorityOptions {
	db: DatabaseType;
	profileId: string;
	recall: (query: string, options: MemoryCandidateRecallInput["scope"] & { limit: number; includeCandidates?: boolean }) => readonly RecallHit[];
	applyClaimCorrection?: (input: ClaimCorrectionAdmissionInput) => MemoryComponentRef | undefined;
	applyExtractedClaim?: (input: ExtractedClaimAdmissionInput) => MemoryComponentRef | undefined;
	now?: () => number;
}

export const MEMORY_LEARNING_SCHEMA_VERSION = 11;

export interface ClaimCorrectionAdmissionInput {
	targetId: string;
	statement: string;
	scope: SettleLearningInput["scope"];
	observationId: string;
	evidenceDigest: string;
}

export interface ExtractedClaimAdmissionInput {
	statement: string;
	kind: "claim" | "preference";
	confidence: number;
	scope: SettleLearningInput["scope"];
	observationId: string;
	evidenceDigest: string;
	evidenceExcerpt: string;
}

export class SqliteMemoryLearningAuthority implements MemoryLearningAuthorityPort, ManagedSkillLearningPort {
	private readonly db: DatabaseType;
	private readonly profileId: string;
	private readonly recall: SqliteMemoryLearningAuthorityOptions["recall"];
	private readonly applyClaimCorrection?: SqliteMemoryLearningAuthorityOptions["applyClaimCorrection"];
	private readonly applyExtractedClaim?: SqliteMemoryLearningAuthorityOptions["applyExtractedClaim"];
	private readonly now: () => number;

	constructor(options: SqliteMemoryLearningAuthorityOptions) {
		this.db = options.db;
		this.profileId = requiredText(options.profileId, "Profile", 256);
		this.recall = options.recall;
		this.applyClaimCorrection = options.applyClaimCorrection;
		this.applyExtractedClaim = options.applyExtractedClaim;
		this.now = options.now ?? Date.now;
		applyMemoryLearningMigrations(this.db);
	}

	recallCandidates(input: MemoryCandidateRecallInput): readonly MemoryRecallCandidate[] {
		this.assertProfile(input.scope.profileId);
		const now = this.now();
		const limit = boundedInteger(input.limit, "recall limit", 1, 100);
		const claims = this.recall(input.query, { ...input.scope, limit, includeCandidates: false })
			.filter((hit) => hit.memoryType === "claim" && hit.status === "active")
			.map((hit) => ({
				component: { kind: "claim" as const, id: hit.id, version: `updated:${hit.createdAt}`, digest: sha256(hit.content) },
				content: hit.content,
				relevance: boundedScore(hit.score),
				semanticConfidence: boundedScore(hit.confidence),
				evidenceQuality: 0.5,
				freshness: 1,
				contextualUtility: 0.5,
				recency: Number((1 / (1 + Math.max(0, now - hit.createdAt) / (30 * 24 * 60 * 60 * 1_000))).toFixed(6)),
				applicability: "eligible" as const,
				evidenceRefs: [`memory:${hit.id}`],
			}));
		const candidates = [...claims, ...this.recallEpisodeCandidates(input, now), ...this.recallProjectionCandidates(input, now)];
		const unique = new Map<string, MemoryRecallCandidate>();
		for (const candidate of candidates) {
			const assessment = this.assessmentFor(candidate.component, input.situationFingerprint.digest);
			const assessed = { ...candidate, contextualUtility: assessment.utility, applicability: assessment.applicability };
			const key = `${candidate.component.kind}\0${candidate.component.id}\0${candidate.component.version}`;
			const current = unique.get(key);
			if (!current || assessed.relevance > current.relevance) unique.set(key, assessed);
		}
		return [...unique.values()].sort((left, right) => right.relevance - left.relevance || right.recency - left.recency || left.component.id.localeCompare(right.component.id)).slice(0, limit);
	}

	recallRoutingDirectives(input: MemoryCandidateRecallInput): readonly MemoryRoutingAssessment[] {
		this.assertProfile(input.scope.profileId);
		if (!this.adaptiveLearningEnabled()) return [];
		const limit = boundedInteger(input.limit, "routing directive limit", 1, 100);
		const rows = this.db.prepare(`SELECT component_kind, component_id, component_version, situation_fingerprint,
			posterior_mean, accepted_weight, failure_weight, state, revision
			FROM memory_assessments
			WHERE profile_id = ? AND component_kind IN ('tool','skill','capability') AND situation_fingerprint IN (?, 'GLOBAL')
			ORDER BY component_kind, component_id, component_version, situation_fingerprint`)
			.all(this.profileId, input.situationFingerprint.digest) as RoutingAssessmentRow[];
		const groups = new Map<string, RoutingAssessmentRow[]>();
		for (const row of rows) {
			const key = `${row.component_kind}\0${row.component_id}\0${row.component_version}`;
			groups.set(key, [...(groups.get(key) ?? []), row]);
		}
		const directives: MemoryRoutingAssessment[] = [];
		for (const group of groups.values()) {
			const specific = group.find((row) => row.situation_fingerprint === input.situationFingerprint.digest);
			const global = group.find((row) => row.situation_fingerprint === "GLOBAL");
			const applicability = mostRestrictiveApplicability(specific?.state, global?.state);
			if (applicability === "eligible") continue;
			const specificWeight = specific ? (specific.accepted_weight + specific.failure_weight) / (specific.accepted_weight + specific.failure_weight + 5) : 0;
			const utility = specific ? specificWeight * specific.posterior_mean + (1 - specificWeight) * (global?.posterior_mean ?? 0.5) : global?.posterior_mean ?? 0.5;
			const row = specific ?? global!;
			directives.push({
				component: { kind: row.component_kind, id: row.component_id, version: row.component_version, digest: sha256(canonicalJson([row.component_kind, row.component_id, row.component_version])) },
				applicability,
				utility: boundedScore(utility),
				assessmentRevision: Math.max(specific?.revision ?? 0, global?.revision ?? 0),
				evidenceRefs: group.map((item) => `assessment:${item.component_kind}:${item.component_id}:${item.component_version}:${item.situation_fingerprint}:${item.revision}`),
			});
		}
		return directives.sort((left, right) => routingSeverity(right.applicability) - routingSeverity(left.applicability) || left.component.kind.localeCompare(right.component.kind) || left.component.id.localeCompare(right.component.id) || left.component.version.localeCompare(right.component.version)).slice(0, limit);
	}

	registerVersion(input: RegisterManagedSkillVersionInput): ManagedSkillPointerSnapshot {
		this.assertProfile(input.profileId);
		validateManagedSkillVersionInput(input);
		return this.db.transaction(() => {
			const existingVersion = this.db.prepare(`SELECT artifact_sha256, signed_receipt_ref, accepted_trial_ids, risk_tier, policy_version
				FROM memory_managed_skill_versions WHERE profile_id = ? AND skill_name = ? AND version_sha256 = ?`)
				.get(this.profileId, input.name, input.versionSha256) as { artifact_sha256: string; signed_receipt_ref: string; accepted_trial_ids: string; risk_tier: string; policy_version: string } | undefined;
			if (existingVersion) {
				if (existingVersion.artifact_sha256 !== input.artifactSha256 || existingVersion.signed_receipt_ref !== input.signedReceiptRef || existingVersion.accepted_trial_ids !== JSON.stringify([...new Set(input.acceptedTrialIds)]) || existingVersion.risk_tier !== input.riskTier || existingVersion.policy_version !== input.policyVersion) throw new Error("Managed Skill version identity conflicts with different immutable evidence");
			} else {
				this.db.prepare(`INSERT INTO memory_managed_skill_versions
					(profile_id, skill_name, version_sha256, artifact_sha256, signed_receipt_ref, accepted_trial_ids, risk_tier, policy_version, registered_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
					.run(this.profileId, input.name, input.versionSha256, input.artifactSha256, input.signedReceiptRef, JSON.stringify([...new Set(input.acceptedTrialIds)]), input.riskTier, input.policyVersion, input.registeredAt);
			}
			const current = this.managedSkillPointerRow(input.name);
			if (!current) {
				this.db.prepare(`INSERT INTO memory_managed_skill_pointers
					(profile_id, skill_name, stable_version_sha256, canary_version_sha256, canary_percentage, status, policy_version, revision, updated_at)
					VALUES (?, ?, ?, NULL, 10, 'stable', ?, 1, ?)`)
					.run(this.profileId, input.name, input.versionSha256, input.policyVersion, input.registeredAt);
				this.recordManagedSkillEvent(input.name, "stable_initialized", undefined, input.versionSha256, input.signedReceiptRef, input.policyVersion, 1, input.registeredAt);
				return this.managedSkillPointer(input.name);
			}
			if (current.stable_version_sha256 === input.versionSha256 || current.canary_version_sha256 === input.versionSha256) return this.managedSkillPointer(input.name);
			if (current.canary_version_sha256) throw new Error(`Managed Skill ${input.name} already has an unresolved canary version`);
			const revision = current.revision + 1;
			const changed = this.db.prepare(`UPDATE memory_managed_skill_pointers SET canary_version_sha256 = ?, canary_percentage = 10, status = 'canary', policy_version = ?, revision = ?, updated_at = ?
				WHERE profile_id = ? AND skill_name = ? AND revision = ?`)
				.run(input.versionSha256, input.policyVersion, revision, input.registeredAt, this.profileId, input.name, current.revision).changes;
			if (changed !== 1) throw new Error("Managed Skill canary pointer revision fence was lost");
			this.recordManagedSkillEvent(input.name, "canary_staged", current.stable_version_sha256, input.versionSha256, input.signedReceiptRef, input.policyVersion, revision, input.registeredAt);
			return this.managedSkillPointer(input.name);
		})();
	}

	selectVersion(input: SelectManagedSkillVersionInput): ManagedSkillSelectionReceipt | undefined {
		this.assertProfile(input.profileId);
		const name = managedSkillName(input.name);
		const executionId = requiredText(input.executionId, "Managed Skill execution", 512);
		const policyVersion = requiredText(input.policyVersion, "Managed Skill selection policy", 128);
		if (!Number.isSafeInteger(input.selectedAt) || input.selectedAt < 0) throw new Error("Managed Skill selection time is invalid");
		return this.db.transaction(() => {
			const existing = this.db.prepare(`SELECT * FROM memory_managed_skill_selection_receipts WHERE profile_id = ? AND skill_name = ? AND execution_id = ? AND policy_version = ?`)
				.get(this.profileId, name, executionId, policyVersion) as ManagedSkillSelectionRow | undefined;
			if (existing) return mapManagedSkillSelection(existing);
			const pointer = this.managedSkillPointerRow(name);
			if (!pointer) return undefined;
			const bucket = deterministicCanaryBucket(this.profileId, name, executionId, policyVersion);
			const chooseCanary = this.adaptiveLearningEnabled() && pointer.status === "canary" && Boolean(pointer.canary_version_sha256) && bucket < pointer.canary_percentage;
			const channel = chooseCanary ? "canary" as const : "stable" as const;
			const versionSha256 = chooseCanary ? pointer.canary_version_sha256! : pointer.stable_version_sha256;
			const version = this.db.prepare(`SELECT artifact_sha256 FROM memory_managed_skill_versions WHERE profile_id = ? AND skill_name = ? AND version_sha256 = ?`)
				.get(this.profileId, name, versionSha256) as { artifact_sha256: string } | undefined;
			if (!version) throw new Error("Managed Skill pointer references an unavailable immutable version");
			const unsigned = { name, executionId, channel, versionSha256, artifactSha256: version.artifact_sha256, bucket, canaryPercentage: pointer.canary_percentage, pointerRevision: pointer.revision, policyVersion, selectedAt: input.selectedAt };
			const receiptDigest = sha256(canonicalJson(unsigned));
			const receiptId = `managed_skill_selection:${sha256(canonicalJson([this.profileId, name, executionId, policyVersion]))}`;
			this.db.prepare(`INSERT INTO memory_managed_skill_selection_receipts
				(receipt_id, receipt_digest, profile_id, skill_name, execution_id, channel, version_sha256, artifact_sha256, bucket, canary_percentage, pointer_revision, policy_version, selected_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(receiptId, receiptDigest, this.profileId, name, executionId, channel, versionSha256, version.artifact_sha256, bucket, pointer.canary_percentage, pointer.revision, policyVersion, input.selectedAt);
			return { receiptId, receiptDigest, ...unsigned };
		})();
	}

	listManagedSkillNames(profileId: string): readonly string[] {
		this.assertProfile(profileId);
		return (this.db.prepare("SELECT skill_name FROM memory_managed_skill_pointers WHERE profile_id = ? ORDER BY skill_name").all(this.profileId) as Array<{ skill_name: string }>).map((row) => row.skill_name);
	}

	getPointer(profileId: string, name: string): ManagedSkillPointerSnapshot | undefined {
		this.assertProfile(profileId);
		const normalized = managedSkillName(name);
		return this.managedSkillPointerRow(normalized) ? this.managedSkillPointer(normalized) : undefined;
	}

	rollbackVersion(input: RollbackManagedSkillVersionInput): ManagedSkillPointerSnapshot {
		this.assertProfile(input.profileId);
		const name = managedSkillName(input.name);
		assertSha256Digest(input.targetVersionSha256, "Managed Skill rollback version");
		const evidenceRef = requiredText(input.evidenceRef, "Managed Skill rollback evidence", 1_000);
		const policyVersion = requiredText(input.policyVersion, "Managed Skill rollback policy", 128);
		if (!Number.isSafeInteger(input.rolledBackAt) || input.rolledBackAt < 0) throw new Error("Managed Skill rollback time is invalid");
		return this.db.transaction(() => {
			const target = this.db.prepare("SELECT 1 FROM memory_managed_skill_versions WHERE profile_id = ? AND skill_name = ? AND version_sha256 = ?").get(this.profileId, name, input.targetVersionSha256);
			if (!target) throw new Error("Managed Skill rollback target is unavailable");
			const current = this.managedSkillPointerRow(name);
			if (!current) throw new Error("Managed Skill pointer is unavailable");
			const revision = current.revision + 1;
			const changed = this.db.prepare(`UPDATE memory_managed_skill_pointers SET stable_version_sha256 = ?, canary_version_sha256 = NULL, status = 'rolled_back', policy_version = ?, revision = ?, updated_at = ?
				WHERE profile_id = ? AND skill_name = ? AND revision = ?`)
				.run(input.targetVersionSha256, policyVersion, revision, input.rolledBackAt, this.profileId, name, current.revision).changes;
			if (changed !== 1) throw new Error("Managed Skill rollback pointer revision fence was lost");
			const automatic = input.mode === "automatic_integrity";
			this.recordManagedSkillEvent(name, automatic ? "automatic_rollback" : "manual_rollback", automatic ? current.canary_version_sha256 ?? current.stable_version_sha256 : current.stable_version_sha256, input.targetVersionSha256, evidenceRef, policyVersion, revision, input.rolledBackAt);
			return this.managedSkillPointer(name);
		})();
	}

	commitContextPack(input: ContextPackCommit): ContextPackCommitResult {
		this.assertProfile(input.pack.scope.profileId);
		validateContextPackCommit(input);
		return this.db.transaction((): ContextPackCommitResult => {
			const latest = this.db.prepare(`SELECT revision, status FROM memory_context_packs
				WHERE profile_id = ? AND execution_id = ? AND query_digest = ? AND policy_version = ?
				ORDER BY revision DESC LIMIT 1`)
				.get(this.profileId, input.pack.executionId, input.pack.queryDigest, input.pack.policyVersion) as { revision: number; status: string } | undefined;
			if (latest?.status !== undefined && latest.status !== "invalidated") {
				const existing = this.readContextPackByIdentity(input.pack.executionId, input.pack.queryDigest, input.pack.policyVersion);
				return existing ? { status: "existing", persisted: existing } : { status: "unavailable" };
			}
			const revision = (latest?.revision ?? 0) + 1;
			const inserted = this.db.prepare(`INSERT OR IGNORE INTO memory_context_packs
				(pack_id, profile_id, execution_id, objective_id, task_id, task_run_id, platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id,
				situation_fingerprint, situation_features, query_digest, work_contract_digest, policy_version, authority_watermark, status, revision,
				required_chars, optional_chars, included_count, omitted, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(input.pack.packId, input.pack.scope.profileId, input.pack.executionId, input.pack.objectiveId ?? null, input.pack.taskId ?? null, input.pack.taskRunId ?? null, input.pack.scope.platform, input.pack.scope.chatId,
					input.pack.scope.chatType ?? null, input.pack.scope.userId ?? null, input.pack.scope.threadId ?? null, input.pack.scope.projectId ?? null,
					input.pack.scope.organizationId ?? null, input.pack.situationFingerprint.digest, JSON.stringify(input.pack.situationFingerprint), input.pack.queryDigest,
					input.pack.workContractDigest ?? null, input.pack.policyVersion, input.pack.authorityWatermark, input.pack.status, revision,
					input.pack.requiredChars, input.pack.optionalChars, input.pack.includedCount, JSON.stringify(input.pack.omitted), input.pack.createdAt).changes;
			if (!inserted) {
				const existing = this.readContextPackByIdentity(input.pack.executionId, input.pack.queryDigest, input.pack.policyVersion);
				return existing ? { status: "existing", persisted: existing } : { status: "unavailable" };
			}
			const insertReceipt = this.db.prepare(`INSERT INTO memory_contribution_receipts
				(receipt_id, receipt_digest, pack_id, profile_id, execution_id, component_kind, component_id, component_version, component_digest,
				phase, role, rank, score, applicability, evidence_refs, ranker_version, policy_version, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
			for (const receipt of input.receipts) insertReceipt.run(receipt.receiptId, receipt.receiptDigest, receipt.packId, this.profileId, receipt.executionId,
				receipt.component.kind, receipt.component.id, receipt.component.version, receipt.component.digest, receipt.phase, receipt.role, receipt.rank,
				receipt.score, receipt.applicability, JSON.stringify(receipt.evidenceRefs), receipt.rankerVersion, receipt.policyVersion, receipt.createdAt);
			const insertRoutingReceipt = this.db.prepare(`INSERT INTO memory_routing_receipts
				(receipt_id, receipt_digest, pack_id, profile_id, execution_id, component_kind, component_id, component_version, component_digest,
				applicability, utility, assessment_revision, evidence_refs, situation_fingerprint, policy_version, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
			for (const receipt of input.routingReceipts) insertRoutingReceipt.run(receipt.receiptId, receipt.receiptDigest, receipt.packId, this.profileId, receipt.executionId,
				receipt.component.kind, receipt.component.id, receipt.component.version, receipt.component.digest, receipt.applicability, receipt.utility,
				receipt.assessmentRevision, JSON.stringify(receipt.evidenceRefs), receipt.situationFingerprint, receipt.policyVersion, receipt.createdAt);
			return { status: "committed", persisted: input };
		})();
	}

	readContextPack(input: ReadContextPackInput): ContextPackCommit | undefined {
		this.assertProfile(input.profileId);
		const row = this.db.prepare(`SELECT * FROM memory_context_packs WHERE profile_id = ? AND pack_id = ? AND execution_id = ?`)
			.get(this.profileId, requiredText(input.packId, "Context Pack id", 512), requiredText(input.executionId, "execution id", 512)) as ContextPackRow | undefined;
		if (!row) return undefined;
		const receiptRows = this.db.prepare(`SELECT * FROM memory_contribution_receipts WHERE profile_id = ? AND pack_id = ? ORDER BY rank, receipt_id`)
			.all(this.profileId, row.pack_id) as ContributionReceiptRow[];
		const routingRows = this.db.prepare(`SELECT * FROM memory_routing_receipts WHERE profile_id = ? AND pack_id = ? ORDER BY component_kind, component_id, component_version`)
			.all(this.profileId, row.pack_id) as RoutingReceiptRow[];
		return { pack: mapContextPack(row), receipts: receiptRows.map(mapContributionReceipt), routingReceipts: routingRows.map(mapRoutingReceipt) };
	}

	appendLearningSignal(input: AppendLearningSignalInput): string {
		this.assertProfile(input.profileId);
		if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1 || !Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 100 || !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) throw new Error("Memory Learning signal metadata is invalid");
		if (!/^[a-f0-9]{64}$/i.test(input.sourceDigest)) throw new Error("Memory Learning signal source digest is invalid");
		const sourceId = requiredText(input.sourceId, "signal source", 512);
		const identity = sha256(canonicalJson([this.profileId, input.sourceKind, sourceId, input.sourceRevision, input.signalType]));
		const signalId = `learning_signal:${identity}`;
		this.db.prepare(`INSERT OR IGNORE INTO memory_learning_signals
			(signal_id, profile_id, source_kind, source_id, source_revision, source_digest, signal_type, priority, status, attempts, next_eligible_at, input_digest, authority_watermark, policy_version, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)`)
			.run(signalId, this.profileId, input.sourceKind, sourceId, input.sourceRevision, input.sourceDigest, input.signalType, input.priority,
				input.occurredAt, input.sourceDigest, input.occurredAt, requiredText(input.policyVersion, "signal policy version", 128), input.occurredAt, input.occurredAt);
		const persisted = this.db.prepare("SELECT source_digest FROM memory_learning_signals WHERE profile_id = ? AND signal_id = ?")
			.get(this.profileId, signalId) as { source_digest: string } | undefined;
		if (!persisted) throw new Error("Memory Learning signal could not be persisted");
		if (persisted.source_digest !== input.sourceDigest) throw new Error("Memory Learning signal identity conflicts with a different source digest");
		return signalId;
	}

	private readContextPackByIdentity(executionId: string, queryDigest: string, policyVersion: string): ContextPackCommit | undefined {
		const row = this.db.prepare(`SELECT * FROM memory_context_packs WHERE profile_id = ? AND execution_id = ? AND query_digest = ? AND policy_version = ? AND status <> 'invalidated' ORDER BY revision DESC LIMIT 1`)
			.get(this.profileId, executionId, queryDigest, policyVersion) as ContextPackRow | undefined;
		if (!row) return undefined;
		const receiptRows = this.db.prepare(`SELECT * FROM memory_contribution_receipts WHERE profile_id = ? AND pack_id = ? AND invalidated_at IS NULL ORDER BY rank, receipt_id`)
			.all(this.profileId, row.pack_id) as ContributionReceiptRow[];
		const routingRows = this.db.prepare(`SELECT * FROM memory_routing_receipts WHERE profile_id = ? AND pack_id = ? ORDER BY component_kind, component_id, component_version`)
			.all(this.profileId, row.pack_id) as RoutingReceiptRow[];
		return { pack: mapContextPack(row), receipts: receiptRows.map(mapContributionReceipt), routingReceipts: routingRows.map(mapRoutingReceipt) };
	}

	appendObservation(input: MemoryObservation): ObservationReceipt {
		this.assertProfile(input.scope.profileId);
		if (containsCredentialMaterial(JSON.stringify(input))) return { observationId: `observation:rejected:${randomUUID()}`, accepted: false, reasonCode: "credential_rejected", recordedAt: this.now() };
		if (!input.scope.platform.trim() || !input.scope.chatId.trim() || input.type === "evidence" && input.content !== undefined && (!input.content.trim() || input.content.length > 20_000)
			|| input.type === "execution" && input.component && !/^[a-f0-9]{64}$/i.test(input.component.digest)
			|| input.type === "execution" && input.traceRef !== undefined && (!input.traceRef.trim() || input.traceRef.length > 1_000)) {
			return { observationId: `observation:rejected:${randomUUID()}`, accepted: false, reasonCode: "invalid", recordedAt: this.now() };
		}
		const recordedAt = this.now();
		const identity = sha256(canonicalJson(input));
		const observationId = `observation:${identity}`;
		const signalId = `learning_signal:${identity}`;
		const inserted = this.db.transaction(() => {
			const observation = this.db.prepare(`INSERT OR IGNORE INTO memory_learning_observations
				(observation_id, profile_id, type, evidence_kind, event_type, evidence_digest, source_ref, content, execution_id, status, component, occurred_at, created_at, identity_digest,
				platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id, objective_id, task_id, task_run_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(observationId, this.profileId, input.type, input.type === "evidence" ? input.evidenceKind : null, input.type === "execution" ? input.eventType : null,
					input.type === "evidence" ? input.evidenceDigest : null, input.type === "evidence" ? input.sourceRef ?? null : input.traceRef ?? null,
					input.type === "evidence" ? input.content ?? null : null, input.type === "execution" ? input.envelope.executionId : null,
					input.type === "execution" ? input.status ?? null : null, input.type === "execution" && input.component ? JSON.stringify(input.component) : null,
					input.occurredAt ?? recordedAt, recordedAt, identity, input.scope.platform, input.scope.chatId, input.scope.chatType ?? null, input.scope.userId ?? null,
					input.scope.threadId ?? null, input.scope.projectId ?? null, input.scope.organizationId ?? null,
					input.type === "execution" ? input.envelope.objectiveId ?? null : null, input.type === "execution" ? input.envelope.taskId ?? null : null,
					input.type === "execution" ? input.envelope.taskRunId ?? null : null).changes;
			if (observation) this.db.prepare(`INSERT OR IGNORE INTO memory_learning_signals
				(signal_id, profile_id, source_kind, source_id, source_revision, source_digest, signal_type, priority, status, attempts, next_eligible_at, input_digest, authority_watermark, policy_version, created_at, updated_at)
				VALUES (?, ?, 'observation', ?, 1, ?, 'observation', 50, 'pending', 0, ?, ?, ?, 'l4.v1', ?, ?)`)
				.run(signalId, this.profileId, observationId, identity, recordedAt, identity, recordedAt, recordedAt, recordedAt);
			return observation > 0;
		})();
		return { observationId, accepted: true, reasonCode: inserted ? "recorded" : "duplicate", ...(input.type === "evidence" ? { evidenceDigest: input.evidenceDigest } : {}), learningSignalId: signalId, recordedAt };
	}

	claimLearningExtractions(input: { profileId: string; maxItems: number; leaseMs: number; now: number }): readonly LearningExtractionClaim[] {
		this.assertProfile(input.profileId);
		const maxItems = boundedInteger(input.maxItems, "extraction item limit", 1, 1_000);
		const leaseMs = boundedInteger(input.leaseMs, "extraction lease", 1, 24 * 60 * 60 * 1_000);
		if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("Learning extraction claim time is invalid");
		return this.db.transaction(() => {
			this.db.prepare(`UPDATE memory_learning_signals SET status = 'pending', lease_holder = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
				next_eligible_at = MIN(next_eligible_at, ?), updated_at = ?, last_reason_code = 'extraction_lease_expired'
				WHERE profile_id = ? AND source_kind = 'observation' AND status = 'leased' AND lease_expires_at <= ?`)
				.run(input.now, input.now, this.profileId, input.now);
			const rows = this.db.prepare(`SELECT s.signal_id, s.input_digest, s.authority_watermark, s.policy_version,
				o.observation_id, o.evidence_kind, o.evidence_digest, o.source_ref, o.content, o.platform, o.chat_id, o.chat_type, o.user_id, o.thread_id, o.project_id, o.organization_id
				FROM memory_learning_signals s JOIN memory_learning_observations o ON o.profile_id = s.profile_id AND o.observation_id = s.source_id
				WHERE s.profile_id = ? AND s.source_kind = 'observation' AND s.signal_type = 'observation' AND s.status IN ('pending','deferred')
				AND s.next_eligible_at <= ? AND o.type = 'evidence' AND o.evidence_kind IN ('conversation','source','feedback','skill')
				AND (o.content IS NOT NULL OR o.source_ref LIKE 'memory-event:%') AND o.evidence_digest IS NOT NULL ORDER BY s.priority DESC, s.created_at, s.signal_id LIMIT ?`)
				.all(this.profileId, input.now, maxItems) as ExtractionClaimRow[];
			const holder = `memory-extraction:${randomUUID()}`;
			const claims: LearningExtractionClaim[] = [];
			for (const row of rows) {
				const evidence = this.resolveExtractionEvidence(row);
				if (!evidence || sha256(evidence.content) !== row.evidence_digest) {
					this.db.prepare(`UPDATE memory_learning_signals SET status = 'quarantined', last_reason_code = ?, updated_at = ?
						WHERE profile_id = ? AND signal_id = ? AND status IN ('pending','deferred')`)
						.run(evidence ? "extraction_evidence_digest_mismatch" : "extraction_evidence_unavailable", input.now, this.profileId, row.signal_id);
					continue;
				}
				const leaseToken = randomUUID();
				const changed = this.db.prepare(`UPDATE memory_learning_signals SET status = 'leased', attempts = attempts + 1, lease_holder = ?, lease_token = ?, leased_at = ?, lease_expires_at = ?, updated_at = ?
					WHERE profile_id = ? AND signal_id = ? AND status IN ('pending','deferred') AND next_eligible_at <= ?`)
					.run(holder, leaseToken, input.now, input.now + leaseMs, input.now, this.profileId, row.signal_id, input.now).changes;
				if (changed !== 1) continue;
				claims.push({
					profileId: this.profileId,
					observationId: row.observation_id,
					evidenceDigest: row.evidence_digest,
					evidenceKind: row.evidence_kind,
					content: evidence.content,
					...(row.source_ref ? { sourceRef: row.source_ref } : {}),
					scope: learningScopeFromExtractionRow(evidence, this.profileId),
					signalId: row.signal_id,
					leaseToken,
					leaseExpiresAt: input.now + leaseMs,
					inputDigest: row.input_digest,
					authorityWatermark: row.authority_watermark,
					policyVersion: row.policy_version,
				});
			}
			return claims;
		})();
	}

	commitLearningExtraction(input: { claim: LearningExtractionClaim; bundle: LearningExtractionBundle; now: number }): LearningExtractionCommitResult {
		this.assertProfile(input.claim.profileId);
		if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("Learning extraction commit time is invalid");
		return this.db.transaction((): LearningExtractionCommitResult => {
			const signal = this.db.prepare(`SELECT signal_id, input_digest, authority_watermark, policy_version FROM memory_learning_signals
				WHERE profile_id = ? AND signal_id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at >= ?`)
				.get(this.profileId, input.claim.signalId, input.claim.leaseToken, input.now) as { signal_id: string; input_digest: string; authority_watermark: number; policy_version: string } | undefined;
			if (!signal || signal.input_digest !== input.claim.inputDigest || signal.authority_watermark !== input.claim.authorityWatermark || signal.policy_version !== input.claim.policyVersion) {
				return { status: "stale", reasonCode: "extraction_fence_stale", authorityWatermark: input.claim.authorityWatermark };
			}
			const rawObservation = this.db.prepare(`SELECT observation_id, evidence_kind, evidence_digest, source_ref, content, platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id
				FROM memory_learning_observations WHERE profile_id = ? AND observation_id = ? AND type = 'evidence'`)
				.get(this.profileId, input.claim.observationId) as ExtractionEvidenceRow | undefined;
			const observation = rawObservation ? this.resolveExtractionEvidence(rawObservation) : undefined;
			const quarantine = (reasonCode: string): LearningExtractionCommitResult => {
				this.db.prepare(`UPDATE memory_learning_signals SET status = 'quarantined', last_reason_code = ?, updated_at = ?, lease_holder = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL
					WHERE profile_id = ? AND signal_id = ? AND status = 'leased' AND lease_token = ?`)
					.run(reasonCode, input.now, this.profileId, input.claim.signalId, input.claim.leaseToken);
				return { status: "quarantined", reasonCode, authorityWatermark: signal.authority_watermark };
			};
			if (!observation || sha256(observation.content) !== observation.evidence_digest || observation.evidence_digest !== input.claim.evidenceDigest || observation.content !== input.claim.content || observation.evidence_kind !== input.claim.evidenceKind
				|| !scopeMatches(input.claim.scope, observation)) return quarantine("extraction_evidence_stale");
			let proposals: ValidatedExtractionProposal[];
			try { proposals = validateExtractionBundle(input.bundle, input.claim); }
			catch { return quarantine("invalid_extraction_proposal"); }
			const proposalIds: string[] = [];
			const transitions: string[] = [];
			let admittedPreference = false;
			for (const proposal of proposals) {
				const proposalId = `learning_proposal:${sha256(canonicalJson([this.profileId, input.claim.evidenceDigest, input.bundle.extractorVersion, proposal.proposalDigest]))}`;
				const existing = this.db.prepare("SELECT status, admitted_component_kind, admitted_component_id, admitted_component_version FROM memory_learning_proposals WHERE profile_id = ? AND proposal_id = ?")
					.get(this.profileId, proposalId) as { status: "candidate" | "admitted" | "quarantined" | "rejected"; admitted_component_kind: string | null; admitted_component_id: string | null; admitted_component_version: string | null } | undefined;
				let status = existing?.status ?? "candidate";
				let admitted: MemoryComponentRef | undefined = existing?.admitted_component_kind && existing.admitted_component_id && existing.admitted_component_version
					? { kind: existing.admitted_component_kind as MemoryComponentKind, id: existing.admitted_component_id, version: existing.admitted_component_version, digest: sha256(proposal.statement) }
					: undefined;
				const deterministicAdmission = input.bundle.extractorVersion === "beemax.deterministic-learning-extractor.v1"
					&& (proposal.kind === "preference" || proposal.kind === "claim") && proposal.confidence >= 0.9
					&& this.adaptiveLearningEnabled() && Boolean(this.applyExtractedClaim);
				if (!existing && deterministicAdmission) {
					admitted = this.applyExtractedClaim!({ statement: proposal.statement, kind: proposal.kind as "claim" | "preference", confidence: proposal.confidence,
						scope: input.claim.scope, observationId: input.claim.observationId, evidenceDigest: input.claim.evidenceDigest, evidenceExcerpt: proposal.sourceExcerpt });
					if (!admitted) return quarantine("extraction_admission_fence_changed");
					status = "admitted";
					admittedPreference ||= proposal.kind === "preference";
				}
				if (!existing) this.db.prepare(`INSERT INTO memory_learning_proposals
					(proposal_id, profile_id, observation_id, evidence_digest, extractor_version, model_version, proposal_digest, proposal_kind, statement, confidence,
					evidence_refs, source_spans, intended_verification, platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id, status, admission_reason,
					admitted_component_kind, admitted_component_id, admitted_component_version, authority_watermark, policy_version, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
					.run(proposalId, this.profileId, input.claim.observationId, input.claim.evidenceDigest, input.bundle.extractorVersion, input.bundle.modelVersion ?? null,
						proposal.proposalDigest, proposal.kind, proposal.statement, proposal.confidence, JSON.stringify(proposal.evidenceRefs), JSON.stringify(proposal.persistedSpans),
						proposal.intendedVerification ?? null, input.claim.scope.platform, input.claim.scope.chatId, input.claim.scope.chatType ?? null, input.claim.scope.userId ?? null,
						input.claim.scope.threadId ?? null, input.claim.scope.projectId ?? null, input.claim.scope.organizationId ?? null, status,
						status === "admitted" ? "deterministic_explicit_declaration" : "candidate_requires_type_specific_admission",
						admitted?.kind ?? null, admitted?.id ?? null, admitted?.version ?? null, input.claim.authorityWatermark, input.claim.policyVersion, input.now, input.now);
				proposalIds.push(proposalId);
				transitions.push(`extraction:${proposal.kind}:${status}:${proposalId}`);
			}
			if (admittedPreference) {
				const projection = this.buildUserPreferencesProjection(input.claim.scope, input.now);
				if (projection) transitions.push(...this.publishProjection(projection, input.now));
			}
			const completionDigest = sha256(canonicalJson({ signalId: input.claim.signalId, extractorVersion: input.bundle.extractorVersion, proposalIds, transitions }));
			const changed = this.db.prepare(`UPDATE memory_learning_signals SET status = 'completed', completion_digest = ?, last_reason_code = 'extraction_committed', completed_at = ?, updated_at = ?,
				lease_holder = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL WHERE profile_id = ? AND signal_id = ? AND status = 'leased' AND lease_token = ?`)
				.run(completionDigest, input.now, input.now, this.profileId, input.claim.signalId, input.claim.leaseToken).changes;
			if (changed !== 1) return { status: "stale", reasonCode: "extraction_completion_fence_stale", authorityWatermark: signal.authority_watermark };
			return { status: "committed", proposalIds, transitions, authorityWatermark: signal.authority_watermark };
		})();
	}

	renewLearningExtraction(input: { claim: LearningExtractionClaim; leaseExpiresAt: number; now: number }): boolean {
		this.assertProfile(input.claim.profileId);
		if (!Number.isSafeInteger(input.now) || input.now < 0 || !Number.isSafeInteger(input.leaseExpiresAt) || input.leaseExpiresAt <= input.now) throw new Error("Learning extraction lease renewal is invalid");
		return this.db.prepare(`UPDATE memory_learning_signals SET lease_expires_at = ?, updated_at = ? WHERE profile_id = ? AND signal_id = ?
			AND source_kind = 'observation' AND status = 'leased' AND lease_token = ? AND lease_expires_at >= ?`)
			.run(input.leaseExpiresAt, input.now, this.profileId, input.claim.signalId, input.claim.leaseToken, input.now).changes === 1;
	}

	deferLearningExtraction(input: { claim: LearningExtractionClaim; reasonCode: string; now: number }): boolean {
		this.assertProfile(input.claim.profileId);
		const reasonCode = requiredText(input.reasonCode, "Learning extraction defer reason", 128);
		const signal = this.db.prepare("SELECT signal_id, attempts FROM memory_learning_signals WHERE profile_id = ? AND signal_id = ? AND status = 'leased' AND lease_token = ?")
			.get(this.profileId, input.claim.signalId, input.claim.leaseToken) as Pick<LearningSignalRow, "signal_id" | "attempts"> | undefined;
		if (!signal) return false;
		const delay = Math.min(60 * 60 * 1_000, 1_000 * 2 ** Math.min(signal.attempts, 12));
		return this.db.prepare(`UPDATE memory_learning_signals SET status = 'deferred', next_eligible_at = ?, last_reason_code = ?, updated_at = ?,
			lease_holder = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL
			WHERE profile_id = ? AND signal_id = ? AND status = 'leased' AND lease_token = ?`)
			.run(input.now + delay, reasonCode, input.now, this.profileId, input.claim.signalId, input.claim.leaseToken).changes === 1;
	}

	claimLearningObjectives(input: { profileId: string; maxItems: number; leaseMs: number; now: number }): readonly LearningObjectiveClaim[] {
		this.assertProfile(input.profileId);
		const maxItems = boundedInteger(input.maxItems, "Learning Objective item limit", 1, 10);
		const leaseMs = boundedInteger(input.leaseMs, "Learning Objective lease", 1, 24 * 60 * 60 * 1_000);
		if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("Learning Objective claim time is invalid");
		if (!this.adaptiveLearningEnabled()) return [];
		return this.db.transaction(() => {
			this.db.prepare(`UPDATE memory_learning_proposals SET objective_state = 'deferred', objective_lease_token = NULL, objective_lease_expires_at = NULL,
				next_objective_at = MIN(next_objective_at, ?), objective_reason = 'learning_objective_lease_expired', updated_at = ?
				WHERE profile_id = ? AND objective_state = 'leased' AND objective_lease_expires_at <= ?`)
				.run(input.now, input.now, this.profileId, input.now);
			const rows = this.db.prepare(`SELECT proposal_id, observation_id, evidence_digest, proposal_digest, statement, confidence, intended_verification,
				evidence_refs, platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id, authority_watermark, policy_version
				FROM memory_learning_proposals WHERE profile_id = ? AND status = 'candidate' AND proposal_kind = 'capability_gap'
				AND extractor_version = 'beemax.deterministic-learning-extractor.v1' AND confidence >= 0.9 AND intended_verification IS NOT NULL
				AND chat_type IN ('dm','group','channel','thread') AND objective_state IN ('pending','deferred') AND next_objective_at <= ?
				ORDER BY confidence DESC, created_at, proposal_id LIMIT ?`).all(this.profileId, input.now, maxItems) as LearningObjectiveRow[];
			const claims: LearningObjectiveClaim[] = [];
			for (const row of rows) {
				const leaseToken = randomUUID();
				const changed = this.db.prepare(`UPDATE memory_learning_proposals SET objective_state = 'leased', objective_attempts = objective_attempts + 1,
					objective_lease_token = ?, objective_lease_expires_at = ?, objective_reason = 'learning_objective_claimed', updated_at = ?
					WHERE profile_id = ? AND proposal_id = ? AND status = 'candidate' AND objective_state IN ('pending','deferred') AND next_objective_at <= ?`)
					.run(leaseToken, input.now + leaseMs, input.now, this.profileId, row.proposal_id, input.now).changes;
				if (changed !== 1) continue;
				claims.push({
					profileId: this.profileId,
					proposalId: row.proposal_id,
					observationId: row.observation_id,
					evidenceDigest: row.evidence_digest,
					proposalDigest: row.proposal_digest,
					statement: row.statement,
					confidence: row.confidence,
					intendedVerification: row.intended_verification!,
					evidenceRefs: parseStringList(row.evidence_refs),
					scope: learningScopeFromObjectiveRow(row, this.profileId),
					leaseToken,
					leaseExpiresAt: input.now + leaseMs,
					authorityWatermark: row.authority_watermark,
					policyVersion: row.policy_version,
				});
			}
			return claims;
		})();
	}

	commitLearningObjective(input: { claim: LearningObjectiveClaim; objectiveId: string; now: number }): LearningObjectiveCommitResult {
		this.assertProfile(input.claim.profileId);
		const objectiveId = requiredText(input.objectiveId, "Learning Objective identity", 512);
		if (!Number.isSafeInteger(input.now) || input.now < 0 || containsCredentialMaterial(objectiveId)) throw new Error("Learning Objective commit is invalid");
		return this.db.transaction((): LearningObjectiveCommitResult => {
			const row = this.db.prepare(`SELECT proposal_id, observation_id, evidence_digest, proposal_digest, statement, confidence, intended_verification, evidence_refs,
				platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id, status, objective_state, objective_id,
				objective_lease_token, objective_lease_expires_at, authority_watermark, policy_version
				FROM memory_learning_proposals WHERE profile_id = ? AND proposal_id = ?`).get(this.profileId, input.claim.proposalId) as LearningObjectiveCommitRow | undefined;
			if (row?.objective_state === "created" && row.objective_id === objectiveId && learningObjectiveClaimMatches(input.claim, row, this.profileId)) {
				return { status: "duplicate", objectiveId, transition: `learning_objective:admitted:${row.proposal_id}:${objectiveId}`, authorityWatermark: row.authority_watermark };
			}
			if (!row || row.status !== "candidate" || row.objective_state !== "leased" || row.objective_lease_token !== input.claim.leaseToken
				|| (row.objective_lease_expires_at ?? -1) < input.now) return { status: "stale", reasonCode: "learning_objective_fence_stale", authorityWatermark: input.claim.authorityWatermark };
			if (!learningObjectiveClaimMatches(input.claim, row, this.profileId)) {
				this.db.prepare(`UPDATE memory_learning_proposals SET status = 'quarantined', objective_state = 'rejected', objective_reason = 'learning_objective_identity_mismatch',
					objective_lease_token = NULL, objective_lease_expires_at = NULL, updated_at = ? WHERE profile_id = ? AND proposal_id = ? AND objective_lease_token = ?`)
					.run(input.now, this.profileId, row.proposal_id, input.claim.leaseToken);
				return { status: "quarantined", reasonCode: "learning_objective_identity_mismatch", authorityWatermark: row.authority_watermark };
			}
			if (!this.adaptiveLearningEnabled()) {
				this.db.prepare(`UPDATE memory_learning_proposals SET objective_state = 'deferred', next_objective_at = ?, objective_reason = 'adaptive_learning_disabled',
					objective_lease_token = NULL, objective_lease_expires_at = NULL, updated_at = ? WHERE profile_id = ? AND proposal_id = ? AND objective_lease_token = ?`)
					.run(input.now + 60_000, input.now, this.profileId, row.proposal_id, input.claim.leaseToken);
				return { status: "stale", reasonCode: "adaptive_learning_disabled", authorityWatermark: row.authority_watermark };
			}
			const changed = this.db.prepare(`UPDATE memory_learning_proposals SET status = 'admitted', admission_reason = 'read_only_learning_objective',
				objective_state = 'created', objective_id = ?, objective_reason = 'learning_objective_admitted', objective_lease_token = NULL,
				objective_lease_expires_at = NULL, updated_at = ? WHERE profile_id = ? AND proposal_id = ? AND status = 'candidate'
				AND objective_state = 'leased' AND objective_lease_token = ?`).run(objectiveId, input.now, this.profileId, row.proposal_id, input.claim.leaseToken).changes;
			if (changed !== 1) return { status: "stale", reasonCode: "learning_objective_commit_fence_stale", authorityWatermark: row.authority_watermark };
			return { status: "committed", objectiveId, transition: `learning_objective:admitted:${row.proposal_id}:${objectiveId}`, authorityWatermark: row.authority_watermark };
		})();
	}

	renewLearningObjective(input: { claim: LearningObjectiveClaim; leaseExpiresAt: number; now: number }): boolean {
		this.assertProfile(input.claim.profileId);
		if (!Number.isSafeInteger(input.now) || input.now < 0 || !Number.isSafeInteger(input.leaseExpiresAt) || input.leaseExpiresAt <= input.now) throw new Error("Learning Objective lease renewal is invalid");
		return this.db.prepare(`UPDATE memory_learning_proposals SET objective_lease_expires_at = ?, updated_at = ? WHERE profile_id = ? AND proposal_id = ?
			AND status = 'candidate' AND objective_state = 'leased' AND objective_lease_token = ? AND objective_lease_expires_at >= ?`)
			.run(input.leaseExpiresAt, input.now, this.profileId, input.claim.proposalId, input.claim.leaseToken, input.now).changes === 1;
	}

	deferLearningObjective(input: { claim: LearningObjectiveClaim; reasonCode: string; now: number }): boolean {
		this.assertProfile(input.claim.profileId);
		const reasonCode = requiredText(input.reasonCode, "Learning Objective defer reason", 128);
		if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("Learning Objective defer time is invalid");
		const row = this.db.prepare("SELECT objective_attempts FROM memory_learning_proposals WHERE profile_id = ? AND proposal_id = ? AND status = 'candidate' AND objective_state = 'leased' AND objective_lease_token = ?")
			.get(this.profileId, input.claim.proposalId, input.claim.leaseToken) as { objective_attempts: number } | undefined;
		if (!row) return false;
		const delay = Math.min(60 * 60 * 1_000, 5_000 * 2 ** Math.min(row.objective_attempts, 10));
		return this.db.prepare(`UPDATE memory_learning_proposals SET objective_state = 'deferred', next_objective_at = ?, objective_reason = ?,
			objective_lease_token = NULL, objective_lease_expires_at = NULL, updated_at = ? WHERE profile_id = ? AND proposal_id = ?
			AND status = 'candidate' AND objective_state = 'leased' AND objective_lease_token = ?`)
			.run(input.now + delay, reasonCode, input.now, this.profileId, input.claim.proposalId, input.claim.leaseToken).changes === 1;
	}

	settleLearning(input: SettleLearningInput): LearningSettlement {
		this.assertProfile(input.scope.profileId);
		if (!Number.isSafeInteger(input.subject.revision) || input.subject.revision < 1 || !Number.isSafeInteger(input.verificationRevision) || input.verificationRevision < 1) throw new Error("Memory Learning settlement revision is invalid");
		if (!/^[a-f0-9]{64}$/i.test(input.verificationDigest)) throw new Error("Memory Learning Verification digest is invalid");
		if (!input.criteria.length) throw new Error("Memory Learning settlement requires criterion outcomes");
		const settledAt = this.now();
		const criteriaDigest = sha256(canonicalJson(input.criteria));
		const key = sha256(canonicalJson([this.profileId, input.subject, input.verificationRevision, input.policyVersion]));
		const proposedId = `settlement:${key}`;
		const outcome = learningOutcome(input);
		const externalEvidenceRefs = normalizedSettlementEvidenceRefs(input);
		const rejectedReason = validateSettlementIdentity(input);
		if (rejectedReason) return { settlementId: proposedId, status: "rejected", outcome, attributionStatus: "unknown", appliedAssessmentEvents: [], proposedTransitions: [], reasonCodes: [rejectedReason] };
		const existing = this.findSettlement(input);
		if (existing) {
			if (existing.verification_digest !== input.verificationDigest || existing.criteria_digest !== criteriaDigest || !this.settlementEvidenceRefsMatch(existing.settlement_id, externalEvidenceRefs)) throw new Error("Memory Learning settlement identity conflicts with different Verification evidence");
			return this.settlementResult(existing, "duplicate");
		}

		const pack = this.db.prepare("SELECT * FROM memory_context_packs WHERE profile_id = ? AND execution_id = ? AND status <> 'invalidated' ORDER BY revision DESC, created_at DESC LIMIT 1")
			.get(this.profileId, input.envelope.executionId) as ContextPackRow | undefined;
		if (pack && !scopeMatches(input.scope, pack)) return { settlementId: proposedId, status: "rejected", outcome, attributionStatus: "unknown", appliedAssessmentEvents: [], proposedTransitions: [], reasonCodes: ["context_scope_mismatch"] };
		if (pack && (pack.task_id && input.subject.kind === "task" && pack.task_id !== input.subject.id || pack.objective_id && input.subject.kind === "objective" && pack.objective_id !== input.subject.id)) {
			return { settlementId: proposedId, status: "rejected", outcome, attributionStatus: "unknown", appliedAssessmentEvents: [], proposedTransitions: [], reasonCodes: ["context_subject_mismatch"] };
		}
		const receiptRows = pack ? this.db.prepare("SELECT * FROM memory_contribution_receipts WHERE profile_id = ? AND pack_id = ? AND invalidated_at IS NULL ORDER BY rank, receipt_id")
			.all(this.profileId, pack.pack_id) as ContributionReceiptRow[] : [];
		const observations = this.db.prepare(`SELECT observation_id, event_type, status, component, source_ref, occurred_at, platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id
			FROM memory_learning_observations WHERE profile_id = ? AND execution_id = ? ORDER BY occurred_at, observation_id`)
			.all(this.profileId, input.envelope.executionId) as ExecutionObservationRow[];
		if (observations.some((row) => !scopeMatches(input.scope, row))) return { settlementId: proposedId, status: "rejected", outcome, attributionStatus: "unknown", appliedAssessmentEvents: [], proposedTransitions: [], reasonCodes: ["observation_scope_mismatch"] };
		const drafts = attributionDrafts(input, receiptRows, observations, settledAt);
		const attributionStatus: LearningSettlement["attributionStatus"] = drafts.length === 0 ? "unknown" : outcome === "rejected" && drafts.every((draft) => draft.failureWeight > 0) ? "supported" : "partial";
		const reasonCodes = outcome === "unavailable" ? ["verification_unavailable"] : drafts.length === 0 ? ["causal_evidence_missing"] : drafts.some((draft) => draft.failureWeight > 0) ? ["deterministic_component_failure"] : ["correlated_components"];
		const correlationDigest = sha256(canonicalJson({ packId: pack?.pack_id ?? null, receipts: receiptRows.map((row) => row.receipt_id), observations: observations.map((row) => row.observation_id), deliveryReceiptRefs: externalEvidenceRefs.delivery, artifactReceiptRefs: externalEvidenceRefs.artifact }));

		return this.db.transaction((): LearningSettlement => {
			const raced = this.findSettlement(input);
			if (raced) {
				if (raced.verification_digest !== input.verificationDigest || raced.criteria_digest !== criteriaDigest || !this.settlementEvidenceRefsMatch(raced.settlement_id, externalEvidenceRefs)) throw new Error("Memory Learning settlement identity conflicts with different Verification evidence");
				return this.settlementResult(raced, "duplicate");
			}
			const prior = this.db.prepare(`SELECT settlement_id, verification_revision FROM memory_learning_settlements
				WHERE profile_id = ? AND subject_kind = ? AND subject_id = ? AND subject_revision = ? AND policy_version = ?
				ORDER BY verification_revision DESC LIMIT 1`)
				.get(this.profileId, input.subject.kind, input.subject.id, input.subject.revision, input.policyVersion) as { settlement_id: string; verification_revision: number } | undefined;
			if (prior && prior.verification_revision >= input.verificationRevision) return { settlementId: proposedId, status: "rejected", outcome, attributionStatus: "unknown", appliedAssessmentEvents: [], proposedTransitions: [], reasonCodes: ["stale_verification_revision"] };
			this.db.prepare(`INSERT INTO memory_learning_settlements
				(settlement_id, profile_id, execution_id, subject_kind, subject_id, subject_revision, verification_revision, verification_digest,
				criteria_digest, outcome, correlation_digest, attribution_status, policy_version, reason_codes, supersedes_settlement_id, created_at, settled_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(proposedId, this.profileId, input.envelope.executionId, input.subject.kind, input.subject.id, input.subject.revision, input.verificationRevision,
					input.verificationDigest, criteriaDigest, outcome, correlationDigest, attributionStatus, input.policyVersion, JSON.stringify(reasonCodes), prior?.settlement_id ?? null, settledAt, settledAt);
			const insertEvidenceRef = this.db.prepare(`INSERT INTO memory_settlement_evidence_refs
				(profile_id, settlement_id, ref_kind, evidence_ref, evidence_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
			for (const ref of externalEvidenceRefs.artifact) insertEvidenceRef.run(this.profileId, proposedId, "artifact", ref, sha256(ref), settledAt);
			for (const ref of externalEvidenceRefs.delivery) insertEvidenceRef.run(this.profileId, proposedId, "delivery", ref, sha256(ref), settledAt);

			if (prior) this.compensateSettlement(prior.settlement_id, proposedId, input.policyVersion, settledAt);
			const insertAttribution = this.db.prepare(`INSERT INTO memory_attributions
				(attribution_id, profile_id, settlement_id, criterion_id, component_kind, component_id, component_version, cause_code,
				contribution_strength, positive_weight, failure_weight, supporting_receipts, attributor_version, validator_result, confidence_band, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'beemax.deterministic-attribution.v1', 'supported', ?, ?)`);
			const deltaByComponent = new Map<string, AssessmentDelta>();
			for (const draft of drafts) {
				const attributionId = `attribution:${sha256(canonicalJson([proposedId, draft]))}`;
				insertAttribution.run(attributionId, this.profileId, proposedId, draft.criterionId, draft.component.kind, draft.component.id, draft.component.version,
					draft.causeCode, draft.contributionStrength, draft.positiveWeight, draft.failureWeight, JSON.stringify(draft.supportingReceiptIds), draft.confidenceBand, settledAt);
				const deltaKey = `${draft.component.kind}\0${draft.component.id}\0${draft.component.version}\0${draft.component.digest}`;
				const delta = deltaByComponent.get(deltaKey) ?? { component: draft.component, positiveWeight: 0, failureWeight: 0, attributionIds: [] };
				delta.positiveWeight += draft.positiveWeight;
				delta.failureWeight += draft.failureWeight;
				delta.attributionIds.push(attributionId);
				deltaByComponent.set(deltaKey, delta);
			}
			const fingerprint = pack ? parseFingerprint(pack.situation_features, pack.situation_fingerprint) : undefined;
			for (const delta of deltaByComponent.values()) {
				const fingerprints = fingerprint ? [fingerprint.digest, "GLOBAL"] : ["GLOBAL"];
				for (const assessmentFingerprint of fingerprints) this.applyAssessmentDelta({
					settlementId: proposedId,
					attributionId: delta.attributionIds.length === 1 ? delta.attributionIds[0] : undefined,
					component: delta.component,
					situationFingerprint: assessmentFingerprint,
					riskTier: fingerprint?.riskTier ?? "low",
					successDelta: delta.positiveWeight,
					failureDelta: delta.failureWeight,
					policyVersion: input.policyVersion,
					reasonCode: delta.failureWeight > 0 ? "supported_failure" : "verified_success",
					createdAt: settledAt,
				});
			}
			return this.settlementResult(this.findSettlement(input)!, "settled");
		})();
	}

	private findSettlement(input: SettleLearningInput): SettlementRow | undefined {
		return this.db.prepare(`SELECT settlement_id, outcome, attribution_status, reason_codes, settled_at, verification_digest, criteria_digest FROM memory_learning_settlements
			WHERE profile_id = ? AND subject_kind = ? AND subject_id = ? AND subject_revision = ? AND verification_revision = ? AND policy_version = ?`)
			.get(this.profileId, input.subject.kind, input.subject.id, input.subject.revision, input.verificationRevision, input.policyVersion) as SettlementRow | undefined;
	}

	private settlementEvidenceRefsMatch(settlementId: string, expected: SettlementEvidenceRefs): boolean {
		const rows = this.db.prepare(`SELECT ref_kind, evidence_ref FROM memory_settlement_evidence_refs
			WHERE profile_id = ? AND settlement_id = ? ORDER BY ref_kind, evidence_ref`).all(this.profileId, settlementId) as Array<{ ref_kind: "artifact" | "delivery"; evidence_ref: string }>;
		return canonicalJson(rows) === canonicalJson([
			...expected.artifact.map((evidence_ref) => ({ ref_kind: "artifact" as const, evidence_ref })),
			...expected.delivery.map((evidence_ref) => ({ ref_kind: "delivery" as const, evidence_ref })),
		]);
	}

	private settlementResult(row: SettlementRow, status: "settled" | "duplicate"): LearningSettlement {
		const events = this.db.prepare(`SELECT event_id, component_kind, component_id, component_version, situation_fingerprint, prior_state, resulting_state
			FROM memory_assessment_events WHERE profile_id = ? AND settlement_id = ? ORDER BY created_at, event_id`)
			.all(this.profileId, row.settlement_id) as AssessmentEventResultRow[];
		return {
			settlementId: row.settlement_id, status, outcome: row.outcome, attributionStatus: row.attribution_status,
			appliedAssessmentEvents: events.map((event) => event.event_id),
			proposedTransitions: events.filter((event) => event.prior_state !== event.resulting_state).map(assessmentTransitionRef),
			reasonCodes: parseStringList(row.reason_codes), settledAt: row.settled_at,
		};
	}

	private compensateSettlement(priorSettlementId: string, settlementId: string, policyVersion: string, createdAt: number): void {
		const priorEvents = this.db.prepare(`SELECT component_kind, component_id, component_version, situation_fingerprint, success_delta, failure_delta
			FROM memory_assessment_events WHERE profile_id = ? AND settlement_id = ?`)
			.all(this.profileId, priorSettlementId) as Array<{ component_kind: MemoryComponentKind; component_id: string; component_version: string; situation_fingerprint: string; success_delta: number; failure_delta: number }>;
		for (const event of priorEvents) this.applyAssessmentDelta({
			settlementId, component: { kind: event.component_kind, id: event.component_id, version: event.component_version, digest: sha256(canonicalJson([event.component_kind, event.component_id, event.component_version])) },
			situationFingerprint: event.situation_fingerprint, riskTier: "low", successDelta: -event.success_delta, failureDelta: -event.failure_delta,
			policyVersion, reasonCode: "superseded_verification_compensation", createdAt,
		});
	}

	private applyAssessmentDelta(input: ApplyAssessmentDeltaInput): void {
		const current = this.db.prepare(`SELECT * FROM memory_assessments WHERE profile_id = ? AND component_kind = ? AND component_id = ? AND component_version = ? AND situation_fingerprint = ?`)
			.get(this.profileId, input.component.kind, input.component.id, input.component.version, input.situationFingerprint) as AssessmentRow | undefined;
		const oldRevision = current?.revision ?? 0;
		const priorState = current?.state ?? "eligible";
		const alpha = Math.max(2, (current?.alpha ?? 2) + input.successDelta);
		const beta = Math.max(2, (current?.beta ?? 2) + input.failureDelta);
		const acceptedWeight = Math.max(0, (current?.accepted_weight ?? 0) + input.successDelta);
		const failureWeight = Math.max(0, (current?.failure_weight ?? 0) + input.failureDelta);
		const compensation = input.successDelta < 0 || input.failureDelta < 0;
		const consecutiveSuccesses = compensation ? 0 : input.successDelta > 0 && input.failureDelta === 0 ? (current?.consecutive_successes ?? 0) + 1 : 0;
		const consecutiveFailures = compensation ? 0 : input.failureDelta > 0 ? (current?.consecutive_failures ?? 0) + 1 : 0;
		const posteriorMean = Number((alpha / (alpha + beta)).toFixed(6));
		const riskTier = strongerRisk(current?.risk_tier, input.riskTier);
		const resultingState = assessmentState({ priorState, acceptedWeight, failureWeight, consecutiveSuccesses, consecutiveFailures, posteriorMean, riskTier, compensation });
		const newRevision = oldRevision + 1;
		const eventId = `assessment_event:${sha256(canonicalJson([this.profileId, input.settlementId, input.attributionId ?? null, input.component.kind, input.component.id, input.component.version, input.situationFingerprint, input.successDelta, input.failureDelta, input.reasonCode]))}`;
		const inserted = this.db.prepare(`INSERT OR IGNORE INTO memory_assessment_events
			(event_id, profile_id, settlement_id, attribution_id, component_kind, component_id, component_version, situation_fingerprint, old_revision, new_revision,
			success_delta, failure_delta, prior_state, resulting_state, threshold_policy_version, reason_code, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(eventId, this.profileId, input.settlementId, input.attributionId ?? null, input.component.kind, input.component.id, input.component.version,
				input.situationFingerprint, oldRevision, newRevision, input.successDelta, input.failureDelta, priorState, resultingState, input.policyVersion, input.reasonCode, input.createdAt).changes;
		if (!inserted) return;
		if (!current) {
			this.db.prepare(`INSERT INTO memory_assessments
				(profile_id, component_kind, component_id, component_version, situation_fingerprint, alpha, beta, accepted_weight, failure_weight,
				consecutive_successes, consecutive_failures, posterior_mean, state, risk_tier, revision, last_outcome, transitioned_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(this.profileId, input.component.kind, input.component.id, input.component.version, input.situationFingerprint, alpha, beta, acceptedWeight, failureWeight,
					consecutiveSuccesses, consecutiveFailures, posteriorMean, resultingState, riskTier, newRevision, input.failureDelta > 0 ? "rejected" : input.successDelta > 0 ? "accepted" : "compensated",
					resultingState === priorState ? null : input.createdAt, input.createdAt);
			return;
		}
		const changed = this.db.prepare(`UPDATE memory_assessments SET alpha = ?, beta = ?, accepted_weight = ?, failure_weight = ?, consecutive_successes = ?, consecutive_failures = ?,
			posterior_mean = ?, state = ?, risk_tier = ?, revision = ?, last_outcome = ?, transitioned_at = CASE WHEN state <> ? THEN ? ELSE transitioned_at END, updated_at = ?
			WHERE profile_id = ? AND component_kind = ? AND component_id = ? AND component_version = ? AND situation_fingerprint = ? AND revision = ?`)
			.run(alpha, beta, acceptedWeight, failureWeight, consecutiveSuccesses, consecutiveFailures, posteriorMean, resultingState, riskTier, newRevision,
				input.failureDelta > 0 ? "rejected" : input.successDelta > 0 ? "accepted" : "compensated", resultingState, input.createdAt, input.createdAt,
				this.profileId, input.component.kind, input.component.id, input.component.version, input.situationFingerprint, oldRevision).changes;
		if (changed !== 1) throw new Error("Memory assessment revision fence was lost");
	}

	maintainMemory(input: MaintainMemoryInput): MaintenanceResult {
		this.assertProfile(input.profileId);
		const maxItems = boundedInteger(input.maxItems, "maintenance item limit", 1, 10_000);
		boundedInteger(input.maxModelCalls, "maintenance model-call limit", 0, 10_000);
		boundedInteger(input.leaseMs, "maintenance lease", 1, 24 * 60 * 60 * 1_000);
		this.reconcileLearningSignals(input.now, input.trigger === "scheduled" || input.trigger === "manual");
		this.db.prepare(`UPDATE memory_learning_signals SET status = 'pending', lease_holder = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
			next_eligible_at = MIN(next_eligible_at, ?), updated_at = ?, last_reason_code = 'lease_expired'
			WHERE profile_id = ? AND status = 'leased' AND lease_expires_at <= ?`).run(input.now, input.now, this.profileId, input.now);
		const due = this.db.prepare(`SELECT signal_id FROM memory_learning_signals
			WHERE profile_id = ? AND status IN ('pending', 'deferred') AND next_eligible_at <= ? ORDER BY priority DESC, created_at, signal_id LIMIT ?`)
			.all(this.profileId, input.now, maxItems) as Array<{ signal_id: string }>;
		let claimed = 0;
		let completed = 0;
		let deferred = 0;
		let failed = 0;
		let watermark = 0;
		const transitions: string[] = [];
		const holder = `memory-maintenance:${randomUUID()}`;
		for (const dueSignal of due) {
			const leaseToken = randomUUID();
			const changed = this.db.prepare(`UPDATE memory_learning_signals SET status = 'leased', attempts = attempts + 1, lease_holder = ?, lease_token = ?, leased_at = ?, lease_expires_at = ?, updated_at = ?
				WHERE profile_id = ? AND signal_id = ? AND status IN ('pending','deferred') AND next_eligible_at <= ?`)
				.run(holder, leaseToken, input.now, input.now + input.leaseMs, input.now, this.profileId, dueSignal.signal_id, input.now).changes;
			if (changed !== 1) continue;
			claimed++;
			const signal = this.db.prepare("SELECT * FROM memory_learning_signals WHERE profile_id = ? AND signal_id = ? AND lease_token = ?")
				.get(this.profileId, dueSignal.signal_id, leaseToken) as LearningSignalRow | undefined;
			if (!signal) { failed++; continue; }
			watermark = Math.max(watermark, signal.authority_watermark);
			try {
				const result = this.processLearningSignal(signal, input.now, input.maxModelCalls > 0);
				if (result.status === "deferred") {
					this.deferSignal(signal, leaseToken, input.now, result.reasonCode);
					deferred++;
					continue;
				}
				if (result.status === "quarantined") {
					this.quarantineSignal(signal, leaseToken, input.now, result.reasonCode);
					failed++;
					continue;
				}
				const committedTransitions = this.completeSignal(signal, leaseToken, result, input.now);
				if (!committedTransitions) { failed++; continue; }
				transitions.push(...result.transitions, ...committedTransitions);
				completed++;
			} catch (error) {
				this.deferSignal(signal, leaseToken, input.now, safeReasonCode(error));
				deferred++;
				failed++;
			}
		}
		transitions.push(...this.reconcileManagedSkillCanaries(input.now));
		this.db.prepare(`INSERT INTO memory_maintenance_watermarks (profile_id, job_kind, last_sequence, last_success_at, failure_count, last_reason_code, updated_at)
			VALUES (?, 'learning_signals', ?, ?, ?, ?, ?)
			ON CONFLICT(profile_id, job_kind) DO UPDATE SET last_sequence = MAX(last_sequence, excluded.last_sequence),
			last_success_at = excluded.last_success_at, failure_count = excluded.failure_count, last_reason_code = excluded.last_reason_code, updated_at = excluded.updated_at`)
			.run(this.profileId, watermark, input.now, failed, failed ? "maintenance_partial_failure" : null, input.now);
		return { claimed, completed, deferred, failed, transitions, createdObjectiveIds: [], nextWatermarks: { learning_signals: watermark } };
	}

	private processLearningSignal(signal: LearningSignalRow, now: number, extractionExpected: boolean): ProcessLearningSignalResult {
		if (signal.signal_type === "observation") {
			const observation = this.db.prepare(`SELECT observation_id, type, evidence_kind, evidence_digest, source_ref, content, platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id
				FROM memory_learning_observations WHERE profile_id = ? AND observation_id = ?`).get(this.profileId, signal.source_id) as EvidenceLearningObservationRow | undefined;
			if (!observation) return { status: "deferred", reasonCode: "observation_missing" };
			if (observation.type !== "evidence" || observation.evidence_kind !== "correction") {
				if (extractionExpected && observation.type === "evidence" && observation.content && observation.evidence_kind && ["conversation", "source", "feedback", "skill"].includes(observation.evidence_kind)) return { status: "deferred", reasonCode: "extraction_capacity_deferred" };
				return { status: "completed", reasonCode: "observation_recorded", transitions: [] };
			}
			const targetId = correctionTargetId(observation.source_ref);
			if (!targetId || !observation.content || !observation.evidence_digest || !this.applyClaimCorrection) return { status: "quarantined", reasonCode: "invalid_correction_proposal" };
			const scope = learningScopeFromObservation(observation, this.profileId);
			if (!scope) return { status: "quarantined", reasonCode: "invalid_correction_scope" };
			const target = this.db.prepare(`SELECT id FROM memory_claims WHERE profile_id = ? AND id = ? AND platform = ? AND chat_id = ? AND user_id IS ? AND thread_id IS ?
				AND project_id IS ? AND organization_id IS ? AND status IN ('active','conflicted')`)
				.get(this.profileId, targetId, scope.platform, scope.chatId, scope.userId ?? null, scope.threadId ?? null, scope.projectId ?? null, scope.organizationId ?? null) as { id: string } | undefined;
			if (!target) return { status: "quarantined", reasonCode: "correction_target_unavailable" };
			return { status: "completed", reasonCode: "claim_corrected", correction: { targetId, statement: observation.content, scope, observationId: observation.observation_id, evidenceDigest: observation.evidence_digest }, transitions: [] };
		}
		if (signal.source_kind === "claim" && signal.signal_type === "reconcile") {
			const claim = this.db.prepare(`SELECT id, profile_id, platform, chat_id, user_id, thread_id, project_id, organization_id, visibility, kind, statement, source_ref, status, updated_at
				FROM memory_claims WHERE profile_id = ? AND id = ?`).get(this.profileId, signal.source_id) as ClaimProjectionRow | undefined;
			if (!claim || claim.status !== "active" || claim.kind !== "preference") return { status: "completed", reasonCode: "claim_no_longer_projectable", transitions: [] };
			if (Math.max(1, claim.updated_at) !== signal.source_revision || sha256(claim.statement) !== signal.source_digest) return { status: "quarantined", reasonCode: "claim_revision_fence_mismatch" };
			const scope = claimProjectionScope(claim);
			const projection = this.buildUserPreferencesProjection(scope, now);
			return projection ? { status: "completed", reasonCode: "user_preferences_projected", projection, transitions: [] } : { status: "completed", reasonCode: "no_preferences_to_project", transitions: [] };
		}
		if (signal.signal_type !== "terminal_outcome") return { status: "completed", reasonCode: "signal_recorded", transitions: [] };
		if (signal.source_kind === "objective") {
			const projection = this.buildRecentOutcomesProjection(signal.source_id, now);
			return projection ? { status: "completed", reasonCode: "verified_episode_projected", projection, transitions: [] } : { status: "deferred", reasonCode: "verified_episode_missing" };
		}
		if (signal.source_kind === "task_run") {
			const row = this.db.prepare(`SELECT r.id AS run_id, r.status AS run_status, r.output AS run_output, r.error AS run_error, r.finished_at AS run_finished_at,
				t.id AS task_id, t.kind AS task_kind, t.parent_id, t.status AS task_status, t.execution_scope, t.verification_outcome, t.criterion_verifications,
				t.verification_attempts, t.evidence, t.artifacts, t.updated_at
				FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?`).get(signal.source_id) as TaskRunLearningRow | undefined;
			if (!row || !["succeeded", "failed", "cancelled"].includes(row.run_status) || !["succeeded", "failed", "cancelled"].includes(row.task_status)) return { status: "deferred", reasonCode: "terminal_task_evidence_missing" };
			const transitions: string[] = [];
			if (row.verification_outcome && ["accepted", "rejected", "unavailable"].includes(row.verification_outcome)) {
				const scope = learningScopeFromExecution(row.execution_scope, this.profileId);
				if (scope) {
					const criteria = taskLearningCriteria(row);
					const pack = this.db.prepare("SELECT execution_id FROM memory_context_packs WHERE profile_id = ? AND task_run_id = ? ORDER BY created_at DESC LIMIT 1")
						.get(this.profileId, row.run_id) as { execution_id: string } | undefined;
					const envelope = createExecutionEnvelope({ executionId: pack?.execution_id ?? `execution:${row.run_id}`, trigger: { kind: "task_transition", id: row.task_id },
						...(row.parent_id ? { objectiveId: row.parent_id } : {}), taskId: row.task_id, taskRunId: row.run_id });
					const settlement = this.settleLearning({ envelope, scope, subject: { kind: row.task_kind === "objective" ? "objective" : "task", id: row.task_id, revision: 1 },
						verificationRevision: Math.max(1, row.verification_attempts), verificationDigest: sha256(canonicalJson(criteria)), criteria,
						deliveryReceiptRefs: this.deliveryReceiptRefsForTaskRun(row.run_id), artifactReceiptRefs: taskLearningArtifactReceiptRefs(row), policyVersion: signal.policy_version });
					if (settlement.status === "settled" || settlement.status === "duplicate") transitions.push(...settlement.proposedTransitions);
				}
			}
			return { status: "completed", reasonCode: "terminal_task_observed", transitions };
		}
		return { status: "completed", reasonCode: "terminal_source_recorded", transitions: [] };
	}

	private completeSignal(signal: LearningSignalRow, leaseToken: string, result: Extract<ProcessLearningSignalResult, { status: "completed" }>, now: number): string[] | undefined {
		return this.db.transaction(() => {
			const fenced = this.db.prepare(`SELECT source_digest, input_digest, authority_watermark FROM memory_learning_signals
				WHERE profile_id = ? AND signal_id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at >= ?`)
				.get(this.profileId, signal.signal_id, leaseToken, now) as { source_digest: string; input_digest: string; authority_watermark: number } | undefined;
			if (!fenced || fenced.source_digest !== signal.source_digest || fenced.input_digest !== signal.input_digest || fenced.authority_watermark !== signal.authority_watermark) return undefined;
			const transitions = result.projection ? this.publishProjection(result.projection, now) : [];
			if (result.correction) {
				const corrected = this.applyClaimCorrection?.(result.correction);
				if (!corrected) throw new Error("Claim correction admission fence changed");
				this.invalidateClaimDependents(result.correction.targetId, now);
				transitions.push(`claim:${result.correction.targetId}:corrected->${corrected.id}:${corrected.version}`);
				const preferenceProjection = this.buildUserPreferencesProjection(result.correction.scope, now);
				if (preferenceProjection) transitions.push(...this.publishProjection(preferenceProjection, now));
			}
			const completionDigest = sha256(canonicalJson({ signalId: signal.signal_id, reasonCode: result.reasonCode, transitions: [...result.transitions, ...transitions] }));
			const changed = this.db.prepare(`UPDATE memory_learning_signals SET status = 'completed', completion_digest = ?, last_reason_code = ?, completed_at = ?, updated_at = ?,
				lease_holder = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL WHERE profile_id = ? AND signal_id = ? AND status = 'leased' AND lease_token = ?`)
				.run(completionDigest, result.reasonCode, now, now, this.profileId, signal.signal_id, leaseToken).changes;
			return changed === 1 ? transitions : undefined;
		})();
	}

	private deliveryReceiptRefsForTaskRun(taskRunId: string): string[] {
		const rows = this.db.prepare(`SELECT receipt_idempotency_key, receipt_delivered_at, receipt_provider_message_id
			FROM objective_completion_outbox WHERE task_run_id = ? AND receipt_idempotency_key IS NOT NULL AND receipt_delivered_at IS NOT NULL
			ORDER BY id`).all(taskRunId) as Array<{ receipt_idempotency_key: string; receipt_delivered_at: number; receipt_provider_message_id: string | null }>;
		return rows.map((row) => `delivery-receipt:sha256:${sha256(canonicalJson({ idempotencyKey: row.receipt_idempotency_key, deliveredAt: row.receipt_delivered_at, providerMessageId: row.receipt_provider_message_id }))}`);
	}

	private deferSignal(signal: LearningSignalRow, leaseToken: string, now: number, reasonCode: string): void {
		const delay = Math.min(60 * 60 * 1_000, 1_000 * 2 ** Math.min(signal.attempts, 12));
		this.db.prepare(`UPDATE memory_learning_signals SET status = 'deferred', next_eligible_at = ?, last_reason_code = ?, updated_at = ?,
			lease_holder = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL
			WHERE profile_id = ? AND signal_id = ? AND status = 'leased' AND lease_token = ?`)
			.run(now + delay, reasonCode, now, this.profileId, signal.signal_id, leaseToken);
	}

	private quarantineSignal(signal: LearningSignalRow, leaseToken: string, now: number, reasonCode: string): void {
		this.db.prepare(`UPDATE memory_learning_signals SET status = 'quarantined', last_reason_code = ?, updated_at = ?,
			lease_holder = NULL, lease_token = NULL, leased_at = NULL, lease_expires_at = NULL
			WHERE profile_id = ? AND signal_id = ? AND status = 'leased' AND lease_token = ?`)
			.run(reasonCode, now, this.profileId, signal.signal_id, leaseToken);
	}

	private invalidateClaimDependents(claimId: string, now: number): void {
		const packRows = this.db.prepare("SELECT DISTINCT pack_id FROM memory_contribution_receipts WHERE profile_id = ? AND component_kind = 'claim' AND component_id = ? AND invalidated_at IS NULL")
			.all(this.profileId, claimId) as Array<{ pack_id: string }>;
		this.db.prepare("UPDATE memory_contribution_receipts SET invalidated_at = ?, invalidation_reason = 'claim_corrected' WHERE profile_id = ? AND component_kind = 'claim' AND component_id = ? AND invalidated_at IS NULL")
			.run(now, this.profileId, claimId);
		const invalidatePack = this.db.prepare("UPDATE memory_context_packs SET status = 'invalidated', invalidated_at = ?, invalidation_reason = 'claim_corrected' WHERE profile_id = ? AND pack_id = ? AND status <> 'invalidated'");
		for (const row of packRows) invalidatePack.run(now, this.profileId, row.pack_id);
		const projections = this.db.prepare("SELECT DISTINCT projection_id FROM memory_projection_inputs WHERE input_kind = 'claim' AND input_id = ?").all(claimId) as Array<{ projection_id: string }>;
		for (const projection of projections) {
			this.db.prepare("DELETE FROM memory_projection_current WHERE profile_id = ? AND projection_id = ?").run(this.profileId, projection.projection_id);
			this.db.prepare("UPDATE memory_projections SET status = 'invalidated', invalidated_at = ? WHERE profile_id = ? AND projection_id = ? AND status <> 'invalidated'").run(now, this.profileId, projection.projection_id);
		}
	}

	private reconcileLearningSignals(now: number, includeClaims: boolean): void {
		const missingEpisodes = this.db.prepare(`SELECT e.objective_id, e.situation, e.action, e.outcome, e.evidence, e.status, e.updated_at
			FROM memory_episodes e WHERE e.profile_id = ? AND e.status = 'verified' AND NOT EXISTS (
				SELECT 1 FROM memory_learning_signals s WHERE s.profile_id = e.profile_id AND s.source_kind = 'objective' AND s.source_id = e.objective_id AND s.signal_type = 'terminal_outcome') LIMIT 100`)
			.all(this.profileId) as Array<{ objective_id: string; situation: string; action: string; outcome: string; evidence: string | null; status: string; updated_at: number }>;
		for (const episode of missingEpisodes) this.appendLearningSignal({ profileId: this.profileId, sourceKind: "objective", sourceId: episode.objective_id, sourceRevision: 1,
			sourceDigest: sha256(canonicalJson({ situation: episode.situation, action: episode.action, outcome: episode.outcome, evidence: episode.evidence, status: episode.status })), signalType: "terminal_outcome", priority: 90,
			occurredAt: Math.max(0, episode.updated_at), policyVersion: "l4.v1" });
		const missingRuns = this.db.prepare(`SELECT r.id, r.task_id, r.status, r.output, r.error, r.finished_at, t.status AS task_status, t.updated_at
			FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE r.status IN ('succeeded','failed','cancelled') AND t.status IN ('succeeded','failed','cancelled')
			AND NOT EXISTS (SELECT 1 FROM memory_learning_signals s WHERE s.profile_id = ? AND s.source_kind = 'task_run' AND s.source_id = r.id AND s.signal_type = 'terminal_outcome') LIMIT 100`)
			.all(this.profileId) as Array<{ id: string; task_id: string; status: string; output: string | null; error: string | null; finished_at: number | null; task_status: string; updated_at: number }>;
		for (const run of missingRuns) this.appendLearningSignal({ profileId: this.profileId, sourceKind: "task_run", sourceId: run.id, sourceRevision: 1,
			sourceDigest: sha256(canonicalJson(run)), signalType: "terminal_outcome", priority: 80, occurredAt: Math.max(0, run.finished_at ?? run.updated_at ?? now), policyVersion: "l4.v1" });
		if (!includeClaims) return;
		const missingClaims = this.db.prepare(`SELECT id, statement, updated_at FROM memory_claims c WHERE profile_id = ? AND kind = 'preference' AND status = 'active'
			AND NOT EXISTS (SELECT 1 FROM memory_learning_signals s WHERE s.profile_id = c.profile_id AND s.source_kind = 'claim' AND s.source_id = c.id AND s.source_revision = c.updated_at AND s.signal_type = 'reconcile') LIMIT 100`)
			.all(this.profileId) as Array<{ id: string; statement: string; updated_at: number }>;
		for (const claim of missingClaims) this.appendLearningSignal({ profileId: this.profileId, sourceKind: "claim", sourceId: claim.id, sourceRevision: Math.max(1, claim.updated_at), sourceDigest: sha256(claim.statement),
			signalType: "reconcile", priority: 60, occurredAt: Math.max(0, claim.updated_at), policyVersion: "l4.v1" });
	}

	private buildUserPreferencesProjection(scope: SettleLearningInput["scope"], now: number): ProjectionPlan | undefined {
		const claims = this.db.prepare(`SELECT id, profile_id, platform, chat_id, user_id, thread_id, project_id, organization_id, visibility, kind, statement, source_ref, status, updated_at
			FROM memory_claims WHERE profile_id = ? AND platform = ? AND chat_id = ? AND user_id IS ? AND thread_id IS ? AND project_id IS ? AND organization_id IS ?
			AND kind = 'preference' AND status = 'active' ORDER BY updated_at DESC, id LIMIT 50`)
			.all(this.profileId, scope.platform, scope.chatId, scope.userId ?? null, scope.threadId ?? null, scope.projectId ?? null, scope.organizationId ?? null) as ClaimProjectionRow[];
		if (!claims.length) return undefined;
		const assertions = claims.map((claim) => ({ claimId: claim.id, statement: safeProjectionText(claim.statement, 2_000), ...(claim.source_ref ? { sourceRef: sha256(claim.source_ref) } : {}) }));
		const content = JSON.stringify({ kind: "user_preferences", executable: false, assertions });
		if (containsCredentialMaterial(content) || content.length > 30_000) throw new Error("User preference Projection failed deterministic validation");
		const projectionScope: ProjectionPlan["scope"] = { platform: scope.platform, chatId: scope.chatId, ...(scope.chatType ? { chatType: scope.chatType } : {}), ...(scope.userId ? { userId: scope.userId } : {}), ...(scope.threadId ? { threadId: scope.threadId } : {}), ...(scope.projectId ? { projectId: scope.projectId } : {}), ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) };
		return {
			kind: "user_preferences", scope: projectionScope, scopeKey: sha256(canonicalJson(projectionScope)), visibility: projectionVisibility(claims.map((claim) => claim.visibility)),
			content, contentDigest: sha256(content), policyVersion: "l4.v1", inputWatermark: Math.max(now, ...claims.map((claim) => claim.updated_at)),
			inputs: claims.map((claim) => ({ kind: "claim", id: claim.id, version: `updated:${claim.updated_at}`, digest: claimProjectionDigest(claim), assertionIds: [claim.id], role: "preference" })),
		};
	}

	private buildRecentOutcomesProjection(objectiveId: string, now: number): ProjectionPlan | undefined {
		const source = this.db.prepare(`SELECT id, profile_id, platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id, visibility, objective_id, situation_summary, action, outcome, evidence, status, updated_at
			FROM memory_episodes WHERE profile_id = ? AND objective_id = ? AND status = 'verified'`).get(this.profileId, objectiveId) as EpisodeProjectionRow | undefined;
		if (!source) return undefined;
		const projectionScope = sameVisibilityScopeWhere("memory_episodes", source);
		const episodes = this.db.prepare(`SELECT id, profile_id, platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id, visibility, objective_id, situation_summary, action, outcome, evidence, status, updated_at
			FROM memory_episodes WHERE profile_id = ? AND visibility = ? AND status = 'verified' AND ${projectionScope.where}
			ORDER BY updated_at DESC, id LIMIT 10`)
			.all(this.profileId, source.visibility, ...projectionScope.params) as EpisodeProjectionRow[];
		const assertions = episodes.map((episode) => ({ episodeId: episode.id, objectiveId: episode.objective_id, situation: safeProjectionText(episode.situation_summary, 1_000), action: safeProjectionText(episode.action, 1_000), outcome: safeProjectionText(episode.outcome, 2_000), ...(episode.evidence ? { evidenceRef: sha256(episode.evidence) } : {}) }));
		const content = JSON.stringify({ kind: "recent_outcomes", executable: false, assertions });
		if (containsCredentialMaterial(content) || content.length > 30_000) throw new Error("Recent outcome Projection failed deterministic validation");
		const chatType: ProjectionPlan["scope"]["chatType"] = source.chat_type === "dm" || source.chat_type === "group" || source.chat_type === "channel" || source.chat_type === "thread" ? source.chat_type : undefined;
		const scope: ProjectionPlan["scope"] = { platform: source.platform, chatId: source.chat_id, ...(chatType ? { chatType } : {}), ...(source.user_id ? { userId: source.user_id } : {}), ...(source.thread_id ? { threadId: source.thread_id } : {}), ...(source.project_id ? { projectId: source.project_id } : {}), ...(source.organization_id ? { organizationId: source.organization_id } : {}) };
		return {
			kind: "recent_outcomes", scope, scopeKey: projectionScopeKey(scope, source.visibility), visibility: source.visibility, content, contentDigest: sha256(content), policyVersion: "l4.v1", inputWatermark: Math.max(...episodes.map((episode) => episode.updated_at), now),
			inputs: episodes.map((episode) => ({ kind: "episode", id: episode.id, version: `updated:${episode.updated_at}`, digest: episodeProjectionDigest(episode), assertionIds: [episode.objective_id], role: "verified_outcome" })),
		};
	}

	private publishProjection(plan: ProjectionPlan, now: number): string[] {
		for (const input of plan.inputs) {
			if (input.kind === "episode") {
				const row = this.db.prepare(`SELECT id, profile_id, platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id, visibility, objective_id, situation_summary, action, outcome, evidence, status, updated_at
					FROM memory_episodes WHERE profile_id = ? AND id = ? AND status = 'verified'`).get(this.profileId, input.id) as EpisodeProjectionRow | undefined;
				if (!row || `updated:${row.updated_at}` !== input.version || episodeProjectionDigest(row) !== input.digest) throw new Error("Projection Episode input fence changed before publication");
				continue;
			}
			const claim = this.db.prepare(`SELECT id, profile_id, platform, chat_id, user_id, thread_id, project_id, organization_id, visibility, kind, statement, source_ref, status, updated_at
				FROM memory_claims WHERE profile_id = ? AND id = ? AND status = 'active'`).get(this.profileId, input.id) as ClaimProjectionRow | undefined;
			if (!claim || `updated:${claim.updated_at}` !== input.version || claimProjectionDigest(claim) !== input.digest) throw new Error("Projection Claim input fence changed before publication");
		}
		const inputDigest = sha256(canonicalJson(plan.inputs));
		const existing = this.db.prepare(`SELECT p.projection_id, p.input_digest, p.content_digest FROM memory_projection_current c
			JOIN memory_projections p ON p.projection_id = c.projection_id WHERE c.profile_id = ? AND c.scope_key = ? AND c.projection_kind = ?`)
			.get(this.profileId, plan.scopeKey, plan.kind) as { projection_id: string; input_digest: string; content_digest: string } | undefined;
		if (existing?.input_digest === inputDigest && existing.content_digest === plan.contentDigest) return [];
		const next = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM memory_projections WHERE profile_id = ? AND scope_key = ? AND projection_kind = ?")
			.get(this.profileId, plan.scopeKey, plan.kind) as { version: number };
		const projectionId = `projection:${sha256(canonicalJson([this.profileId, plan.scopeKey, plan.kind, next.version, plan.contentDigest, inputDigest]))}`;
		this.db.prepare(`INSERT INTO memory_projections
			(projection_id, profile_id, projection_kind, scope_key, version, status, content_digest, content, generator_version, policy_version, input_watermark, input_digest,
			validation_result, created_at, published_at, platform, chat_id, chat_type, user_id, thread_id, project_id, organization_id, visibility)
				VALUES (?, ?, ?, ?, ?, 'current', ?, ?, 'beemax.deterministic-projection.v1', ?, ?, ?, 'valid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(projectionId, this.profileId, plan.kind, plan.scopeKey, next.version, plan.contentDigest, plan.content, plan.policyVersion, plan.inputWatermark, inputDigest, now, now,
				plan.scope.platform, plan.scope.chatId, plan.scope.chatType ?? null, plan.scope.userId ?? null, plan.scope.threadId ?? null, plan.scope.projectId ?? null, plan.scope.organizationId ?? null, plan.visibility);
		const insertInput = this.db.prepare(`INSERT INTO memory_projection_inputs (projection_id, input_kind, input_id, input_version, input_digest, assertion_ids, role) VALUES (?, ?, ?, ?, ?, ?, ?)`);
		for (const input of plan.inputs) insertInput.run(projectionId, input.kind, input.id, input.version, input.digest, JSON.stringify(input.assertionIds), input.role);
		if (existing) this.db.prepare("UPDATE memory_projections SET status = 'superseded', superseded_at = ? WHERE profile_id = ? AND projection_id = ? AND status = 'current'").run(now, this.profileId, existing.projection_id);
		this.db.prepare(`INSERT INTO memory_projection_current (profile_id, scope_key, projection_kind, projection_id, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(profile_id, scope_key, projection_kind) DO UPDATE SET projection_id = excluded.projection_id, updated_at = excluded.updated_at`)
			.run(this.profileId, plan.scopeKey, plan.kind, projectionId, now);
		return [`projection:${plan.kind}:${projectionId}:published`];
	}

	private recallEpisodeCandidates(input: MemoryCandidateRecallInput, now: number): MemoryRecallCandidate[] {
		const terms = lexicalTerms(input.query).slice(0, 8);
		if (!terms.length) return [];
		const match = terms.map(() => "(situation_summary LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR outcome LIKE ? ESCAPE '\\')").join(" OR ");
		const termParams = terms.flatMap((term) => { const value = `%${escapeLike(term)}%`; return [value, value, value]; });
		const access = learningVisibilityAccessWhere("memory_episodes", input.scope);
		const rows = this.db.prepare(`SELECT id, objective_id, situation_summary, action, outcome, evidence, updated_at FROM memory_episodes
			WHERE profile_id = ? AND status = 'verified' AND ${access.where} AND (${match})
			ORDER BY updated_at DESC LIMIT 50`).all(this.profileId, ...access.params, ...termParams) as Array<{ id: string; objective_id: string; situation_summary: string; action: string; outcome: string; evidence: string | null; updated_at: number }>;
		return rows.map((row) => {
			const content = `${row.situation_summary}\nAction: ${row.action}\nVerified outcome: ${row.outcome}`;
			return { component: { kind: "episode", id: row.id, version: `updated:${row.updated_at}`, digest: sha256(content) }, content, relevance: lexicalRelevance(input.query, content), semanticConfidence: 1,
				evidenceQuality: row.evidence ? 1 : 0.7, freshness: input.situationFingerprint.freshnessClass === "live" ? 0.25 : 0.8, contextualUtility: 0.5,
				recency: recencyScore(now, row.updated_at), applicability: "eligible", evidenceRefs: [`episode:${row.id}`, ...(row.evidence ? [`episode-evidence:${sha256(row.evidence)}`] : [])] } satisfies MemoryRecallCandidate;
		}).filter((candidate) => candidate.relevance > 0);
	}

	private recallProjectionCandidates(input: MemoryCandidateRecallInput, now: number): MemoryRecallCandidate[] {
		const access = learningVisibilityAccessWhere("p", input.scope);
		const rows = this.db.prepare(`SELECT p.projection_id, p.version, p.content, p.content_digest, p.input_watermark FROM memory_projection_current c
			JOIN memory_projections p ON p.projection_id = c.projection_id
			WHERE p.profile_id = ? AND ${access.where} AND p.status = 'current' AND p.validation_result = 'valid' ORDER BY p.projection_kind LIMIT 20`)
			.all(this.profileId, ...access.params) as Array<{ projection_id: string; version: number; content: string | null; content_digest: string; input_watermark: number }>;
		return rows.flatMap((row): MemoryRecallCandidate[] => {
			if (!row.content || sha256(row.content) !== row.content_digest || containsCredentialMaterial(row.content)) return [];
			const relevance = lexicalRelevance(input.query, row.content);
			if (relevance <= 0) return [];
			const refs = this.db.prepare("SELECT input_kind, input_id, input_version FROM memory_projection_inputs WHERE projection_id = ? ORDER BY input_kind, input_id")
				.all(row.projection_id) as Array<{ input_kind: string; input_id: string; input_version: string }>;
			return [{ component: { kind: "projection", id: row.projection_id, version: `v${row.version}`, digest: row.content_digest }, content: row.content, relevance, semanticConfidence: 1, evidenceQuality: 1,
				freshness: input.situationFingerprint.freshnessClass === "live" ? 0.3 : 0.9, contextualUtility: 0.5, recency: recencyScore(now, row.input_watermark), applicability: "eligible",
				evidenceRefs: refs.map((ref) => `${ref.input_kind}:${ref.input_id}:${ref.input_version}`) }];
		});
	}

	private assessmentFor(component: MemoryComponentRef, fingerprint: string): { utility: number; applicability: MemoryRecallCandidate["applicability"] } {
		if (!this.adaptiveLearningEnabled()) return { utility: 0.5, applicability: "eligible" };
		const rows = this.db.prepare(`SELECT situation_fingerprint, posterior_mean, accepted_weight, failure_weight, state FROM memory_assessments
			WHERE profile_id = ? AND component_kind = ? AND component_id = ? AND component_version = ? AND situation_fingerprint IN (?, 'GLOBAL')`)
			.all(this.profileId, component.kind, component.id, component.version, fingerprint) as Array<{ situation_fingerprint: string; posterior_mean: number; accepted_weight: number; failure_weight: number; state: MemoryRecallCandidate["applicability"] }>;
		const specific = rows.find((row) => row.situation_fingerprint === fingerprint);
		const global = rows.find((row) => row.situation_fingerprint === "GLOBAL");
		if (!specific && !global) return { utility: 0.5, applicability: "eligible" };
		const specificWeight = specific ? (specific.accepted_weight + specific.failure_weight) / (specific.accepted_weight + specific.failure_weight + 5) : 0;
		const utility = specific ? specificWeight * specific.posterior_mean + (1 - specificWeight) * (global?.posterior_mean ?? 0.5) : global!.posterior_mean;
		const applicability = mostRestrictiveApplicability(specific?.state, global?.state);
		return { utility: boundedScore(utility), applicability };
	}

	private adaptiveLearningEnabled(): boolean {
		const rows = this.db.prepare("SELECT level, status FROM autonomy_rollout_states WHERE profile_id = ? AND level IN ('situation_context','episode_publication','adaptive_learning')")
			.all(this.profileId) as Array<{ level: string; status: string }>;
		const enabled = new Set(rows.filter((row) => row.status === "enabled").map((row) => row.level));
		return enabled.has("situation_context") && enabled.has("episode_publication") && enabled.has("adaptive_learning");
	}

	private reconcileManagedSkillCanaries(now: number): string[] {
		if (!this.adaptiveLearningEnabled()) return [];
		return this.db.transaction(() => {
			const pointers = this.db.prepare(`SELECT * FROM memory_managed_skill_pointers
				WHERE profile_id = ? AND status = 'canary' AND canary_version_sha256 IS NOT NULL
				ORDER BY skill_name`)
				.all(this.profileId) as ManagedSkillPointerRow[];
			const transitions: string[] = [];
			for (const pointer of pointers) {
				const canary = this.db.prepare(`SELECT artifact_sha256 FROM memory_managed_skill_versions
					WHERE profile_id = ? AND skill_name = ? AND version_sha256 = ?`)
					.get(this.profileId, pointer.skill_name, pointer.canary_version_sha256) as { artifact_sha256: string } | undefined;
				if (!canary) continue;
				const componentVersion = `sha256:${canary.artifact_sha256}`;
				const assessment = this.db.prepare(`SELECT posterior_mean, accepted_weight, failure_weight, state, revision
					FROM memory_assessments WHERE profile_id = ? AND component_kind = 'skill' AND component_id = ?
					AND component_version = ? AND situation_fingerprint = 'GLOBAL'`)
					.get(this.profileId, pointer.skill_name, componentVersion) as Pick<RoutingAssessmentRow, "posterior_mean" | "accepted_weight" | "failure_weight" | "state" | "revision"> | undefined;
				if (!assessment) continue;
				const automaticRollback = assessment.state === "suppressed";
				const canaryPromotion = assessment.state === "eligible"
					&& assessment.accepted_weight >= 10
					&& assessment.failure_weight === 0
					&& assessment.posterior_mean >= 0.9;
				if (!automaticRollback && !canaryPromotion) continue;
				const revision = pointer.revision + 1;
				const evidenceRef = `assessment:skill:${pointer.skill_name}:${componentVersion}:GLOBAL:${assessment.revision}`;
				if (automaticRollback) {
					const changed = this.db.prepare(`UPDATE memory_managed_skill_pointers
						SET canary_version_sha256 = NULL, canary_percentage = 0, status = 'rolled_back', revision = ?, updated_at = ?
						WHERE profile_id = ? AND skill_name = ? AND revision = ? AND canary_version_sha256 = ?`)
						.run(revision, now, this.profileId, pointer.skill_name, pointer.revision, pointer.canary_version_sha256).changes;
					if (changed !== 1) throw new Error("Managed Skill automatic rollback pointer revision fence was lost");
					this.recordManagedSkillEvent(pointer.skill_name, "automatic_rollback", pointer.canary_version_sha256!, pointer.stable_version_sha256,
						evidenceRef, pointer.policy_version, revision, now);
					transitions.push(`managed_skill:${pointer.skill_name}:automatic_rollback:${pointer.canary_version_sha256}->${pointer.stable_version_sha256}`);
					continue;
				}
				const changed = this.db.prepare(`UPDATE memory_managed_skill_pointers
					SET stable_version_sha256 = ?, canary_version_sha256 = NULL, canary_percentage = 0, status = 'stable', revision = ?, updated_at = ?
					WHERE profile_id = ? AND skill_name = ? AND revision = ? AND canary_version_sha256 = ?`)
					.run(pointer.canary_version_sha256, revision, now, this.profileId, pointer.skill_name, pointer.revision, pointer.canary_version_sha256).changes;
				if (changed !== 1) throw new Error("Managed Skill canary promotion pointer revision fence was lost");
				this.recordManagedSkillEvent(pointer.skill_name, "canary_promoted", pointer.stable_version_sha256, pointer.canary_version_sha256!,
					evidenceRef, pointer.policy_version, revision, now);
				transitions.push(`managed_skill:${pointer.skill_name}:canary_promoted:${pointer.stable_version_sha256}->${pointer.canary_version_sha256}`);
			}
			return transitions;
		})();
	}

	private managedSkillPointerRow(name: string): ManagedSkillPointerRow | undefined {
		return this.db.prepare("SELECT * FROM memory_managed_skill_pointers WHERE profile_id = ? AND skill_name = ?")
			.get(this.profileId, name) as ManagedSkillPointerRow | undefined;
	}

	private managedSkillPointer(name: string): ManagedSkillPointerSnapshot {
		const row = this.managedSkillPointerRow(name);
		if (!row) throw new Error("Managed Skill pointer is unavailable");
		const versions = this.db.prepare(`SELECT version_sha256, artifact_sha256 FROM memory_managed_skill_versions
			WHERE profile_id = ? AND skill_name = ? AND version_sha256 IN (?, ?)`)
			.all(this.profileId, name, row.stable_version_sha256, row.canary_version_sha256 ?? row.stable_version_sha256) as Array<{ version_sha256: string; artifact_sha256: string }>;
		const artifacts = new Map(versions.map((version) => [version.version_sha256, version.artifact_sha256]));
		const stableArtifactSha256 = artifacts.get(row.stable_version_sha256);
		if (!stableArtifactSha256) throw new Error("Managed Skill stable version is unavailable");
		const canaryArtifactSha256 = row.canary_version_sha256 ? artifacts.get(row.canary_version_sha256) : undefined;
		if (row.canary_version_sha256 && !canaryArtifactSha256) throw new Error("Managed Skill canary version is unavailable");
		return {
			name, stableVersionSha256: row.stable_version_sha256, stableArtifactSha256,
			...(row.canary_version_sha256 ? { canaryVersionSha256: row.canary_version_sha256, canaryArtifactSha256 } : {}),
			canaryPercentage: row.canary_percentage, status: row.status, revision: row.revision, updatedAt: row.updated_at,
		};
	}

	private recordManagedSkillEvent(name: string, kind: ManagedSkillEventKind, fromVersion: string | undefined, toVersion: string, evidenceRef: string, policyVersion: string, pointerRevision: number, createdAt: number): void {
		const eventId = `managed_skill_event:${sha256(canonicalJson([this.profileId, name, kind, fromVersion ?? null, toVersion, evidenceRef, pointerRevision]))}`;
		this.db.prepare(`INSERT OR IGNORE INTO memory_managed_skill_events
			(event_id, profile_id, skill_name, event_kind, from_version_sha256, to_version_sha256, evidence_ref, policy_version, pointer_revision, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(eventId, this.profileId, name, kind, fromVersion ?? null, toVersion, evidenceRef, policyVersion, pointerRevision, createdAt);
	}

	private resolveExtractionEvidence(row: ExtractionEvidenceRow): ResolvedExtractionEvidenceRow | undefined {
		if (row.content !== null) return { ...row, content: row.content };
		const eventId = memoryEventIdFromSourceRef(row.source_ref);
		if (!eventId) return undefined;
		const event = this.db.prepare(`SELECT content, platform, chat_id, user_id, thread_id FROM memory_events WHERE id = ?`)
			.get(eventId) as RetainedMemoryEventRow | undefined;
		if (!event || event.platform !== row.platform || event.chat_id !== row.chat_id || event.user_id !== row.user_id || event.thread_id !== row.thread_id
			|| !event.content.trim() || event.content.length > 20_000) return undefined;
		return { ...row, content: event.content };
	}

	private assertProfile(profileId: string): void {
		if (profileId !== this.profileId) throw new Error(`Memory Learning authority belongs to Profile '${this.profileId}', not '${profileId}'`);
	}
}

export function applyMemoryLearningMigrations(db: DatabaseType): void {
	db.exec(`CREATE TABLE IF NOT EXISTS memory_schema_migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		checksum TEXT NOT NULL,
		applied_at INTEGER NOT NULL
	)`);
	for (const migration of MEMORY_LEARNING_MIGRATIONS) {
		const checksum = sha256(migration.sql);
		const current = db.prepare("SELECT checksum FROM memory_schema_migrations WHERE version = ?").get(migration.version) as { checksum: string } | undefined;
		if (current) {
			if (current.checksum !== checksum) throw new Error(`Memory schema migration ${migration.version} checksum mismatch`);
			continue;
		}
		db.transaction(() => {
			db.exec(migration.sql);
			db.prepare("INSERT INTO memory_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(migration.version, migration.name, checksum, Date.now());
		}).immediate();
	}
	if (MEMORY_LEARNING_MIGRATIONS.at(-1)?.version !== MEMORY_LEARNING_SCHEMA_VERSION) throw new Error("Memory Learning schema version constant is stale");
	const integrity = db.pragma("quick_check", { simple: true });
	if (integrity !== "ok") throw new Error(`Memory Learning post-migration integrity check failed: ${String(integrity)}`);
	const foreignKeyFailures = db.pragma("foreign_key_check") as unknown[];
	if (foreignKeyFailures.length) throw new Error(`Memory Learning post-migration foreign-key check failed for ${foreignKeyFailures.length} row(s)`);
	const requiredTables = ["memory_context_packs", "memory_learning_observations", "memory_learning_signals", "memory_learning_settlements", "memory_attributions", "memory_assessments", "memory_projections", "memory_managed_skill_versions", "memory_learning_proposals", "memory_settlement_evidence_refs"];
	const present = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables.map(() => "?").join(",")})`).all(...requiredTables) as Array<{ name: string }>).map((row) => row.name));
	if (requiredTables.some((name) => !present.has(name))) throw new Error("Memory Learning post-migration schema smoke test failed");
}

const MEMORY_LEARNING_MIGRATIONS = [
	{
		version: 1,
		name: "l4_context_and_contributions",
		sql: `
			CREATE TABLE memory_context_packs (
				pack_id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				objective_id TEXT,
				task_id TEXT,
				task_run_id TEXT,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				chat_type TEXT,
				user_id TEXT,
				thread_id TEXT,
				project_id TEXT,
				organization_id TEXT,
				situation_fingerprint TEXT NOT NULL,
				situation_features TEXT NOT NULL,
				query_digest TEXT NOT NULL,
				work_contract_digest TEXT,
				policy_version TEXT NOT NULL,
				authority_watermark INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('prepared', 'degraded', 'invalidated')),
				revision INTEGER NOT NULL DEFAULT 1,
				required_chars INTEGER NOT NULL,
				optional_chars INTEGER NOT NULL,
				included_count INTEGER NOT NULL,
				omitted TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				invalidated_at INTEGER,
				invalidation_reason TEXT,
				UNIQUE(profile_id, execution_id, query_digest, policy_version, revision)
			);
			CREATE INDEX idx_memory_context_packs_execution ON memory_context_packs(profile_id, execution_id, created_at DESC);
			CREATE TABLE memory_contribution_receipts (
				receipt_id TEXT PRIMARY KEY,
				receipt_digest TEXT NOT NULL,
				pack_id TEXT NOT NULL REFERENCES memory_context_packs(pack_id) ON DELETE CASCADE,
				profile_id TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				component_kind TEXT NOT NULL CHECK (component_kind IN ('claim','episode','convention','workflow','projection','source','capability','tool','skill','artifact')),
				component_id TEXT NOT NULL,
				component_version TEXT NOT NULL,
				component_digest TEXT NOT NULL,
				phase TEXT NOT NULL CHECK (phase = 'prepare'),
				role TEXT NOT NULL CHECK (role = 'optional_memory'),
				rank INTEGER NOT NULL,
				score REAL NOT NULL,
				applicability TEXT NOT NULL CHECK (applicability IN ('eligible','cautious')),
				evidence_refs TEXT NOT NULL,
				ranker_version TEXT NOT NULL,
				policy_version TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				invalidated_at INTEGER,
				invalidation_reason TEXT,
				UNIQUE(profile_id, receipt_digest)
			);
			CREATE INDEX idx_memory_contributions_execution ON memory_contribution_receipts(profile_id, execution_id, rank);
		`,
	},
	{
		version: 2,
		name: "l4_observations_signals_and_settlements",
		sql: `
			CREATE TABLE memory_learning_observations (
				observation_id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				type TEXT NOT NULL CHECK (type IN ('evidence','execution')),
				evidence_kind TEXT,
				event_type TEXT,
				evidence_digest TEXT,
				source_ref TEXT,
				content TEXT,
				execution_id TEXT,
				status TEXT,
				component TEXT,
				occurred_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				identity_digest TEXT NOT NULL,
				UNIQUE(profile_id, identity_digest)
			);
			CREATE INDEX idx_memory_learning_observations_execution ON memory_learning_observations(profile_id, execution_id, occurred_at);
			CREATE TABLE memory_learning_signals (
				signal_id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				source_kind TEXT NOT NULL,
				source_id TEXT NOT NULL,
				source_revision INTEGER NOT NULL,
				source_digest TEXT NOT NULL,
				signal_type TEXT NOT NULL,
				priority INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending','leased','deferred','completed','quarantined')),
				attempts INTEGER NOT NULL,
				next_eligible_at INTEGER NOT NULL,
				lease_holder TEXT,
				lease_token TEXT,
				leased_at INTEGER,
				lease_expires_at INTEGER,
				input_digest TEXT NOT NULL,
				authority_watermark INTEGER NOT NULL,
				policy_version TEXT NOT NULL,
				completion_digest TEXT,
				last_reason_code TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				UNIQUE(profile_id, source_kind, source_id, source_revision, signal_type)
			);
			CREATE INDEX idx_memory_learning_signals_due ON memory_learning_signals(profile_id, status, next_eligible_at, priority DESC);
			CREATE TABLE memory_learning_settlements (
				settlement_id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task','objective')),
				subject_id TEXT NOT NULL,
				subject_revision INTEGER NOT NULL,
				verification_revision INTEGER NOT NULL,
				verification_digest TEXT NOT NULL,
				criteria_digest TEXT NOT NULL,
				outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected','unavailable','cancelled','mixed')),
				correlation_digest TEXT NOT NULL,
				attribution_status TEXT NOT NULL CHECK (attribution_status IN ('supported','partial','unknown')),
				policy_version TEXT NOT NULL,
				reason_codes TEXT NOT NULL,
				supersedes_settlement_id TEXT,
				created_at INTEGER NOT NULL,
				settled_at INTEGER,
				UNIQUE(profile_id, subject_kind, subject_id, subject_revision, verification_revision, policy_version)
			);
		`,
	},
	{
		version: 3,
		name: "l4_assessment_and_attribution",
		sql: `
			CREATE TABLE memory_attributions (
				attribution_id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				settlement_id TEXT NOT NULL REFERENCES memory_learning_settlements(settlement_id) ON DELETE CASCADE,
				criterion_id TEXT NOT NULL,
				component_kind TEXT NOT NULL,
				component_id TEXT NOT NULL,
				component_version TEXT NOT NULL,
				cause_code TEXT NOT NULL,
				contribution_strength REAL NOT NULL,
				positive_weight REAL NOT NULL,
				failure_weight REAL NOT NULL,
				supporting_receipts TEXT NOT NULL,
				attributor_version TEXT NOT NULL,
				validator_result TEXT NOT NULL,
				confidence_band TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX idx_memory_attributions_component ON memory_attributions(profile_id, component_kind, component_id, component_version, created_at DESC);
			CREATE TABLE memory_assessments (
				profile_id TEXT NOT NULL,
				component_kind TEXT NOT NULL,
				component_id TEXT NOT NULL,
				component_version TEXT NOT NULL,
				situation_fingerprint TEXT NOT NULL DEFAULT 'GLOBAL',
				alpha REAL NOT NULL DEFAULT 2,
				beta REAL NOT NULL DEFAULT 2,
				accepted_weight REAL NOT NULL DEFAULT 0,
				failure_weight REAL NOT NULL DEFAULT 0,
				consecutive_successes INTEGER NOT NULL DEFAULT 0,
				consecutive_failures INTEGER NOT NULL DEFAULT 0,
				posterior_mean REAL NOT NULL DEFAULT 0.5,
				state TEXT NOT NULL CHECK (state IN ('eligible','cautious','suppressed')),
				risk_tier TEXT NOT NULL CHECK (risk_tier IN ('low','medium','high')),
				revision INTEGER NOT NULL,
				last_outcome TEXT,
				transitioned_at INTEGER,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY(profile_id, component_kind, component_id, component_version, situation_fingerprint)
			);
			CREATE TABLE memory_assessment_events (
				event_id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				settlement_id TEXT NOT NULL,
				attribution_id TEXT,
				component_kind TEXT NOT NULL,
				component_id TEXT NOT NULL,
				component_version TEXT NOT NULL,
				situation_fingerprint TEXT NOT NULL,
				old_revision INTEGER NOT NULL,
				new_revision INTEGER NOT NULL,
				success_delta REAL NOT NULL,
				failure_delta REAL NOT NULL,
				prior_state TEXT NOT NULL,
				resulting_state TEXT NOT NULL,
				threshold_policy_version TEXT NOT NULL,
				reason_code TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`,
	},
	{
		version: 4,
		name: "l4_projections_and_watermarks",
		sql: `
			CREATE TABLE memory_projections (
				projection_id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				projection_kind TEXT NOT NULL,
				scope_key TEXT NOT NULL,
				version INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('candidate','validated','current','superseded','invalidated')),
				content_digest TEXT NOT NULL,
				content TEXT,
				generator_version TEXT NOT NULL,
				model_version TEXT,
				policy_version TEXT NOT NULL,
				input_watermark INTEGER NOT NULL,
				input_digest TEXT NOT NULL,
				validation_result TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				published_at INTEGER,
				superseded_at INTEGER,
				invalidated_at INTEGER,
				UNIQUE(profile_id, scope_key, projection_kind, version)
			);
			CREATE TABLE memory_projection_inputs (
				projection_id TEXT NOT NULL REFERENCES memory_projections(projection_id) ON DELETE CASCADE,
				input_kind TEXT NOT NULL,
				input_id TEXT NOT NULL,
				input_version TEXT NOT NULL,
				input_digest TEXT NOT NULL,
				assertion_ids TEXT NOT NULL,
				role TEXT NOT NULL,
				PRIMARY KEY(projection_id, input_kind, input_id, input_version)
			);
			CREATE INDEX idx_memory_projection_inputs_source ON memory_projection_inputs(input_kind, input_id, input_version);
			CREATE TABLE memory_projection_current (
				profile_id TEXT NOT NULL,
				scope_key TEXT NOT NULL,
				projection_kind TEXT NOT NULL,
				projection_id TEXT NOT NULL REFERENCES memory_projections(projection_id),
				updated_at INTEGER NOT NULL,
				PRIMARY KEY(profile_id, scope_key, projection_kind)
			);
			CREATE TABLE memory_maintenance_watermarks (
				profile_id TEXT NOT NULL,
				job_kind TEXT NOT NULL,
				last_sequence INTEGER NOT NULL,
				last_success_at INTEGER,
				lease_fence TEXT,
				failure_count INTEGER NOT NULL DEFAULT 0,
				last_reason_code TEXT,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY(profile_id, job_kind)
			);
		`,
	},
	{
		version: 5,
		name: "l4_observation_scope_and_execution_lineage",
		sql: `
			ALTER TABLE memory_learning_observations ADD COLUMN platform TEXT;
			ALTER TABLE memory_learning_observations ADD COLUMN chat_id TEXT;
			ALTER TABLE memory_learning_observations ADD COLUMN chat_type TEXT;
			ALTER TABLE memory_learning_observations ADD COLUMN user_id TEXT;
			ALTER TABLE memory_learning_observations ADD COLUMN thread_id TEXT;
			ALTER TABLE memory_learning_observations ADD COLUMN project_id TEXT;
			ALTER TABLE memory_learning_observations ADD COLUMN organization_id TEXT;
			ALTER TABLE memory_learning_observations ADD COLUMN objective_id TEXT;
			ALTER TABLE memory_learning_observations ADD COLUMN task_id TEXT;
			ALTER TABLE memory_learning_observations ADD COLUMN task_run_id TEXT;
			CREATE INDEX idx_memory_learning_observations_task_run ON memory_learning_observations(profile_id, task_run_id, occurred_at);
		`,
	},
	{
		version: 6,
		name: "l4_projection_scope",
		sql: `
			ALTER TABLE memory_projections ADD COLUMN platform TEXT;
			ALTER TABLE memory_projections ADD COLUMN chat_id TEXT;
			ALTER TABLE memory_projections ADD COLUMN chat_type TEXT;
			ALTER TABLE memory_projections ADD COLUMN user_id TEXT;
			ALTER TABLE memory_projections ADD COLUMN thread_id TEXT;
			ALTER TABLE memory_projections ADD COLUMN project_id TEXT;
			ALTER TABLE memory_projections ADD COLUMN organization_id TEXT;
			ALTER TABLE memory_projections ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
			CREATE INDEX idx_memory_projections_scope_current ON memory_projections(profile_id, platform, chat_id, user_id, thread_id, status, projection_kind);
		`,
	},
	{
		version: 7,
		name: "l4_operational_routing_receipts",
		sql: `
			CREATE TABLE memory_routing_receipts (
				receipt_id TEXT PRIMARY KEY,
				receipt_digest TEXT NOT NULL,
				pack_id TEXT NOT NULL REFERENCES memory_context_packs(pack_id) ON DELETE CASCADE,
				profile_id TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				component_kind TEXT NOT NULL CHECK (component_kind IN ('tool','skill','capability')),
				component_id TEXT NOT NULL,
				component_version TEXT NOT NULL,
				component_digest TEXT NOT NULL,
				applicability TEXT NOT NULL CHECK (applicability IN ('cautious','suppressed')),
				utility REAL NOT NULL CHECK (utility >= 0 AND utility <= 1),
				assessment_revision INTEGER NOT NULL,
				evidence_refs TEXT NOT NULL,
				situation_fingerprint TEXT NOT NULL,
				policy_version TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE(profile_id, receipt_digest)
			);
			CREATE INDEX idx_memory_routing_receipts_execution ON memory_routing_receipts(profile_id, execution_id, component_kind, component_id);
		`,
	},
	{
		version: 8,
		name: "l4_managed_skill_canary",
		sql: `
			CREATE TABLE memory_managed_skill_versions (
				profile_id TEXT NOT NULL,
				skill_name TEXT NOT NULL,
				version_sha256 TEXT NOT NULL,
				artifact_sha256 TEXT NOT NULL,
				signed_receipt_ref TEXT NOT NULL,
				accepted_trial_ids TEXT NOT NULL,
				risk_tier TEXT NOT NULL CHECK (risk_tier IN ('low','medium','high')),
				policy_version TEXT NOT NULL,
				registered_at INTEGER NOT NULL,
				PRIMARY KEY(profile_id, skill_name, version_sha256)
			);
			CREATE TABLE memory_managed_skill_pointers (
				profile_id TEXT NOT NULL,
				skill_name TEXT NOT NULL,
				stable_version_sha256 TEXT NOT NULL,
				canary_version_sha256 TEXT,
				canary_percentage INTEGER NOT NULL CHECK (canary_percentage >= 0 AND canary_percentage <= 100),
				status TEXT NOT NULL CHECK (status IN ('stable','canary','rolled_back')),
				policy_version TEXT NOT NULL,
				revision INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY(profile_id, skill_name)
			);
			CREATE TABLE memory_managed_skill_selection_receipts (
				receipt_id TEXT PRIMARY KEY,
				receipt_digest TEXT NOT NULL,
				profile_id TEXT NOT NULL,
				skill_name TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				channel TEXT NOT NULL CHECK (channel IN ('stable','canary')),
				version_sha256 TEXT NOT NULL,
				artifact_sha256 TEXT NOT NULL,
				bucket INTEGER NOT NULL CHECK (bucket >= 0 AND bucket < 100),
				canary_percentage INTEGER NOT NULL,
				pointer_revision INTEGER NOT NULL,
				policy_version TEXT NOT NULL,
				selected_at INTEGER NOT NULL,
				UNIQUE(profile_id, skill_name, execution_id, policy_version)
			);
			CREATE INDEX idx_memory_managed_skill_selections_execution ON memory_managed_skill_selection_receipts(profile_id, execution_id, skill_name);
			CREATE TABLE memory_managed_skill_events (
				event_id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				skill_name TEXT NOT NULL,
				event_kind TEXT NOT NULL CHECK (event_kind IN ('stable_initialized','canary_staged','canary_promoted','automatic_rollback','manual_rollback','pointer_reconciled')),
				from_version_sha256 TEXT,
				to_version_sha256 TEXT NOT NULL,
				evidence_ref TEXT NOT NULL,
				policy_version TEXT NOT NULL,
				pointer_revision INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
		`,
	},
	{
		version: 9,
		name: "l4_bounded_extraction_proposals",
		sql: `
			CREATE TABLE memory_learning_proposals (
				proposal_id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				observation_id TEXT NOT NULL REFERENCES memory_learning_observations(observation_id) ON DELETE CASCADE,
				evidence_digest TEXT NOT NULL,
				extractor_version TEXT NOT NULL,
				model_version TEXT,
				proposal_digest TEXT NOT NULL,
				proposal_kind TEXT NOT NULL CHECK (proposal_kind IN ('claim','preference','correction','exception','convention','workflow','source_observation','capability_gap','failure_shield')),
				statement TEXT NOT NULL,
				confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
				evidence_refs TEXT NOT NULL,
				source_spans TEXT NOT NULL,
				intended_verification TEXT,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				chat_type TEXT,
				user_id TEXT,
				thread_id TEXT,
				project_id TEXT,
				organization_id TEXT,
				status TEXT NOT NULL CHECK (status IN ('candidate','admitted','quarantined','rejected')),
				admission_reason TEXT NOT NULL,
				admitted_component_kind TEXT,
				admitted_component_id TEXT,
				admitted_component_version TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(profile_id, evidence_digest, extractor_version, proposal_digest)
			);
			CREATE INDEX idx_memory_learning_proposals_scope ON memory_learning_proposals(profile_id, platform, chat_id, user_id, thread_id, status, proposal_kind, created_at DESC);
			CREATE INDEX idx_memory_learning_proposals_observation ON memory_learning_proposals(profile_id, observation_id, extractor_version);
		`,
	},
	{
		version: 10,
		name: "l4_active_learning_objectives",
		sql: `
			ALTER TABLE memory_learning_proposals ADD COLUMN authority_watermark INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE memory_learning_proposals ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'l4.v1';
			ALTER TABLE memory_learning_proposals ADD COLUMN objective_state TEXT NOT NULL DEFAULT 'pending' CHECK (objective_state IN ('pending','leased','deferred','created','rejected'));
			ALTER TABLE memory_learning_proposals ADD COLUMN objective_id TEXT;
			ALTER TABLE memory_learning_proposals ADD COLUMN objective_attempts INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE memory_learning_proposals ADD COLUMN next_objective_at INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE memory_learning_proposals ADD COLUMN objective_lease_token TEXT;
			ALTER TABLE memory_learning_proposals ADD COLUMN objective_lease_expires_at INTEGER;
			ALTER TABLE memory_learning_proposals ADD COLUMN objective_reason TEXT;
			CREATE INDEX idx_memory_learning_objectives ON memory_learning_proposals(profile_id, objective_state, proposal_kind, next_objective_at, confidence DESC, created_at);
			CREATE UNIQUE INDEX idx_memory_learning_objective_identity ON memory_learning_proposals(profile_id, objective_id) WHERE objective_id IS NOT NULL;
		`,
	},
	{
		version: 11,
		name: "l4_settlement_external_evidence_refs",
		sql: `
			CREATE TABLE memory_settlement_evidence_refs (
				profile_id TEXT NOT NULL,
				settlement_id TEXT NOT NULL REFERENCES memory_learning_settlements(settlement_id) ON DELETE CASCADE,
				ref_kind TEXT NOT NULL CHECK (ref_kind IN ('artifact','delivery')),
				evidence_ref TEXT NOT NULL,
				evidence_digest TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(profile_id, settlement_id, ref_kind, evidence_ref)
			);
			CREATE INDEX idx_memory_settlement_evidence_ref ON memory_settlement_evidence_refs(profile_id, ref_kind, evidence_digest);
		`,
	},
] as const;

interface ContextPackRow {
	pack_id: string; profile_id: string; execution_id: string; objective_id: string | null; task_id: string | null; task_run_id: string | null; platform: string; chat_id: string; chat_type: string | null; user_id: string | null;
	thread_id: string | null; project_id: string | null; organization_id: string | null; situation_fingerprint: string; situation_features: string;
	query_digest: string; work_contract_digest: string | null; policy_version: string; authority_watermark: number; status: "prepared" | "degraded";
	required_chars: number; optional_chars: number; included_count: number; omitted: string; created_at: number;
}
interface ContributionReceiptRow {
	receipt_id: string; receipt_digest: string; pack_id: string; execution_id: string; component_kind: ContributionReceipt["component"]["kind"];
	component_id: string; component_version: string; component_digest: string; rank: number; score: number; applicability: ContributionReceipt["applicability"];
	evidence_refs: string; ranker_version: ContributionReceipt["rankerVersion"]; policy_version: string; created_at: number;
}
interface RoutingReceiptRow {
	receipt_id: string; receipt_digest: string; pack_id: string; execution_id: string; component_kind: "tool" | "skill" | "capability";
	component_id: string; component_version: string; component_digest: string; applicability: "cautious" | "suppressed"; utility: number;
	assessment_revision: number; evidence_refs: string; situation_fingerprint: string; policy_version: string; created_at: number;
}
interface RoutingAssessmentRow {
	component_kind: "tool" | "skill" | "capability";
	component_id: string;
	component_version: string;
	situation_fingerprint: string;
	posterior_mean: number;
	accepted_weight: number;
	failure_weight: number;
	state: "eligible" | "cautious" | "suppressed";
	revision: number;
}
type ManagedSkillEventKind = "stable_initialized" | "canary_staged" | "canary_promoted" | "automatic_rollback" | "manual_rollback" | "pointer_reconciled";
interface ManagedSkillPointerRow {
	profile_id: string;
	skill_name: string;
	stable_version_sha256: string;
	canary_version_sha256: string | null;
	canary_percentage: number;
	status: "stable" | "canary" | "rolled_back";
	policy_version: string;
	revision: number;
	updated_at: number;
}
interface ManagedSkillSelectionRow {
	receipt_id: string;
	receipt_digest: string;
	skill_name: string;
	execution_id: string;
	channel: "stable" | "canary";
	version_sha256: string;
	artifact_sha256: string;
	bucket: number;
	canary_percentage: number;
	pointer_revision: number;
	policy_version: string;
	selected_at: number;
}
interface SettlementRow {
	settlement_id: string;
	outcome: LearningSettlement["outcome"];
	attribution_status: LearningSettlement["attributionStatus"];
	reason_codes: string;
	settled_at: number;
	verification_digest: string;
	criteria_digest: string;
}
interface ExecutionObservationRow {
	observation_id: string;
	event_type: string | null;
	status: string | null;
	component: string | null;
	source_ref: string | null;
	occurred_at: number;
	platform: string | null;
	chat_id: string | null;
	chat_type: string | null;
	user_id: string | null;
	thread_id: string | null;
	project_id: string | null;
	organization_id: string | null;
}
interface AttributionDraft {
	criterionId: string;
	component: MemoryComponentRef;
	causeCode: string;
	contributionStrength: number;
	positiveWeight: number;
	failureWeight: number;
	supportingReceiptIds: string[];
	confidenceBand: "medium" | "high";
}
interface SettlementEvidenceRefs { artifact: string[]; delivery: string[]; }
interface AssessmentDelta { component: MemoryComponentRef; positiveWeight: number; failureWeight: number; attributionIds: string[]; }
interface AssessmentRow {
	alpha: number;
	beta: number;
	accepted_weight: number;
	failure_weight: number;
	consecutive_successes: number;
	consecutive_failures: number;
	posterior_mean: number;
	state: "eligible" | "cautious" | "suppressed";
	risk_tier: "low" | "medium" | "high";
	revision: number;
}
interface ApplyAssessmentDeltaInput {
	settlementId: string;
	attributionId?: string;
	component: MemoryComponentRef;
	situationFingerprint: string;
	riskTier: "low" | "medium" | "high";
	successDelta: number;
	failureDelta: number;
	policyVersion: string;
	reasonCode: string;
	createdAt: number;
}
interface AssessmentEventResultRow {
	event_id: string;
	component_kind: MemoryComponentKind;
	component_id: string;
	component_version: string;
	situation_fingerprint: string;
	prior_state: string;
	resulting_state: string;
}
interface LearningSignalRow {
	signal_id: string;
	source_kind: "observation" | "task_run" | "objective" | "verification" | "claim";
	source_id: string;
	source_revision: number;
	source_digest: string;
	signal_type: "observation" | "terminal_outcome" | "verification" | "reconcile";
	attempts: number;
	input_digest: string;
	authority_watermark: number;
	policy_version: string;
}
type ProcessLearningSignalResult =
	| { status: "completed"; reasonCode: string; transitions: string[]; projection?: ProjectionPlan; correction?: ClaimCorrectionAdmissionInput }
	| { status: "deferred"; reasonCode: string }
	| { status: "quarantined"; reasonCode: string };
interface ProjectionPlan {
	kind: "recent_outcomes" | "user_preferences";
	scope: { platform: string; chatId: string; chatType?: "dm" | "group" | "channel" | "thread"; userId?: string; threadId?: string; projectId?: string; organizationId?: string };
	scopeKey: string;
	visibility: "private" | "conversation" | "project" | "organization";
	content: string;
	contentDigest: string;
	policyVersion: string;
	inputWatermark: number;
	inputs: Array<{ kind: "episode" | "claim"; id: string; version: string; digest: string; assertionIds: string[]; role: string }>;
}
interface EpisodeProjectionRow {
	id: string;
	profile_id: string;
	platform: string;
	chat_id: string;
	chat_type: string | null;
	user_id: string | null;
	thread_id: string | null;
	project_id: string | null;
	organization_id: string | null;
	visibility: "private" | "conversation" | "project" | "organization";
	objective_id: string;
	situation_summary: string;
	action: string;
	outcome: string;
	evidence: string | null;
	status: string;
	updated_at: number;
}
interface TaskRunLearningRow {
	run_id: string;
	run_status: string;
	run_output: string | null;
	run_error: string | null;
	run_finished_at: number | null;
	task_id: string;
	task_kind: "objective" | "delegated" | "automation";
	parent_id: string | null;
	task_status: string;
	execution_scope: string | null;
	verification_outcome: "accepted" | "rejected" | "unavailable" | "pending" | null;
	criterion_verifications: string | null;
	verification_attempts: number;
	evidence: string | null;
	artifacts: string | null;
	updated_at: number;
}
interface EvidenceLearningObservationRow {
	observation_id: string;
	type: "evidence" | "execution";
	evidence_kind: string | null;
	evidence_digest: string | null;
	source_ref: string | null;
	content: string | null;
	platform: string | null;
	chat_id: string | null;
	chat_type: string | null;
	user_id: string | null;
	thread_id: string | null;
	project_id: string | null;
	organization_id: string | null;
}
interface ExtractionClaimRow {
	signal_id: string;
	input_digest: string;
	authority_watermark: number;
	policy_version: string;
	observation_id: string;
	evidence_kind: "conversation" | "source" | "feedback" | "skill";
	evidence_digest: string;
	source_ref: string | null;
	content: string | null;
	platform: string;
	chat_id: string;
	chat_type: string | null;
	user_id: string | null;
	thread_id: string | null;
	project_id: string | null;
	organization_id: string | null;
}
interface ExtractionEvidenceRow extends Omit<ExtractionClaimRow, "signal_id" | "input_digest" | "authority_watermark" | "policy_version"> {}
interface ResolvedExtractionEvidenceRow extends Omit<ExtractionEvidenceRow, "content"> { content: string; }
interface RetainedMemoryEventRow { content: string; platform: string; chat_id: string; user_id: string | null; thread_id: string | null; }
interface LearningObjectiveRow {
	proposal_id: string;
	observation_id: string;
	evidence_digest: string;
	proposal_digest: string;
	statement: string;
	confidence: number;
	intended_verification: string | null;
	evidence_refs: string;
	platform: string;
	chat_id: string;
	chat_type: string | null;
	user_id: string | null;
	thread_id: string | null;
	project_id: string | null;
	organization_id: string | null;
	authority_watermark: number;
	policy_version: string;
}
interface LearningObjectiveCommitRow extends LearningObjectiveRow {
	status: "candidate" | "admitted" | "quarantined" | "rejected";
	objective_state: "pending" | "leased" | "deferred" | "created" | "rejected";
	objective_id: string | null;
	objective_lease_token: string | null;
	objective_lease_expires_at: number | null;
}
interface ValidatedExtractionProposal extends LearningProposal {
	proposalDigest: string;
	sourceExcerpt: string;
	persistedSpans: Array<{ start: number; end: number; quoteDigest: string }>;
}
interface ClaimProjectionRow {
	id: string;
	profile_id: string;
	platform: string;
	chat_id: string;
	user_id: string | null;
	thread_id: string | null;
	project_id: string | null;
	organization_id: string | null;
	visibility: "private" | "conversation" | "team" | "organization";
	kind: string;
	statement: string;
	source_ref: string | null;
	status: string;
	updated_at: number;
}

function mapContextPack(row: ContextPackRow): PersistedContextPack {
	return {
		packId: row.pack_id, executionId: row.execution_id,
		...(row.objective_id ? { objectiveId: row.objective_id } : {}), ...(row.task_id ? { taskId: row.task_id } : {}), ...(row.task_run_id ? { taskRunId: row.task_run_id } : {}),
		scope: { profileId: row.profile_id, platform: row.platform, chatId: row.chat_id, ...(row.chat_type ? { chatType: row.chat_type as PersistedContextPack["scope"]["chatType"] } : {}), ...(row.user_id ? { userId: row.user_id } : {}), ...(row.thread_id ? { threadId: row.thread_id } : {}), ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.organization_id ? { organizationId: row.organization_id } : {}) },
		situationFingerprint: parseFingerprint(row.situation_features, row.situation_fingerprint), queryDigest: row.query_digest,
		...(row.work_contract_digest ? { workContractDigest: row.work_contract_digest } : {}), policyVersion: row.policy_version,
		authorityWatermark: row.authority_watermark, status: row.status, requiredChars: row.required_chars, optionalChars: row.optional_chars,
		includedCount: row.included_count, omitted: parseOmitted(row.omitted), createdAt: row.created_at,
	};
}

function mapContributionReceipt(row: ContributionReceiptRow): ContributionReceipt {
	return {
		receiptId: row.receipt_id, receiptDigest: row.receipt_digest, packId: row.pack_id, executionId: row.execution_id,
		component: { kind: row.component_kind, id: row.component_id, version: row.component_version, digest: row.component_digest },
		phase: "prepare", role: "optional_memory", rank: row.rank, score: row.score, applicability: row.applicability,
		evidenceRefs: parseStringList(row.evidence_refs), rankerVersion: row.ranker_version, policyVersion: row.policy_version, createdAt: row.created_at,
	};
}

function mapRoutingReceipt(row: RoutingReceiptRow): OperationalRoutingReceipt {
	return {
		receiptId: row.receipt_id, receiptDigest: row.receipt_digest, packId: row.pack_id, executionId: row.execution_id,
		component: { kind: row.component_kind, id: row.component_id, version: row.component_version, digest: row.component_digest },
		applicability: row.applicability, utility: row.utility, assessmentRevision: row.assessment_revision,
		evidenceRefs: parseStringList(row.evidence_refs), situationFingerprint: row.situation_fingerprint,
		policyVersion: row.policy_version, createdAt: row.created_at,
	};
}

function parseFingerprint(value: string, digest: string): SituationFingerprint {
	const parsed = JSON.parse(value) as SituationFingerprint;
	if (parsed?.version !== 1 || parsed.digest !== digest) throw new Error("Stored Situation Fingerprint is invalid");
	return parsed;
}

function parseOmitted(value: string): PersistedContextPack["omitted"] {
	const parsed = JSON.parse(value) as PersistedContextPack["omitted"];
	for (const key of ["budget", "suppressed", "invalid", "persistence_unavailable"] as const) if (!Number.isSafeInteger(parsed?.[key]) || parsed[key] < 0) throw new Error("Stored Context Pack omissions are invalid");
	return parsed;
}

function validateContextPackCommit(input: ContextPackCommit): void {
	if (containsCredentialMaterial(JSON.stringify(input))) throw new Error("Context Pack metadata cannot contain credential material");
	if (!/^[a-f0-9]{64}$/i.test(input.pack.queryDigest)) throw new Error("Context Pack query digest is invalid");
	for (const receipt of input.receipts) {
		if (receipt.packId !== input.pack.packId || receipt.executionId !== input.pack.executionId || receipt.policyVersion !== input.pack.policyVersion) throw new Error("Contribution Receipt does not belong to its Context Pack");
	}
	for (const receipt of input.routingReceipts) {
		if (receipt.packId !== input.pack.packId || receipt.executionId !== input.pack.executionId || receipt.policyVersion !== input.pack.policyVersion || receipt.situationFingerprint !== input.pack.situationFingerprint.digest) throw new Error("Operational Routing Receipt does not belong to its Context Pack");
		const { receiptDigest: _digest, ...unsigned } = receipt;
		if (receipt.receiptDigest !== sha256(canonicalJson(unsigned))) throw new Error("Operational Routing Receipt digest is invalid");
	}
}

function learningOutcome(input: SettleLearningInput): LearningSettlement["outcome"] {
	const statuses = new Set(input.criteria.map((criterion) => criterion.status));
	if (statuses.size === 1 && statuses.has("accepted")) return "accepted";
	if (statuses.size === 1 && statuses.has("rejected")) return "rejected";
	if (statuses.size === 1 && statuses.has("unavailable")) return "unavailable";
	return "mixed";
}

function validateSettlementIdentity(input: SettleLearningInput): string | undefined {
	if (!input.envelope.executionId.trim() || !input.subject.id.trim() || !input.policyVersion.trim()) return "invalid_identity";
	if (input.subject.kind === "task" && input.envelope.taskId && input.envelope.taskId !== input.subject.id) return "execution_subject_mismatch";
	if (input.subject.kind === "objective" && input.envelope.objectiveId && input.envelope.objectiveId !== input.subject.id) return "execution_subject_mismatch";
	const criterionIds = new Set<string>();
	for (const criterion of input.criteria) {
		if (!criterion.criterionId.trim() || criterionIds.has(criterion.criterionId) || criterion.evidenceRefs.some((ref) => !ref.trim() || ref.length > 2_000)) return "invalid_criterion_evidence";
		criterionIds.add(criterion.criterionId);
	}
	if (input.deliveryReceiptRefs.length > 100 || input.artifactReceiptRefs.length > 100 || [...input.deliveryReceiptRefs, ...input.artifactReceiptRefs].some((ref) => !ref.trim() || ref.length > 2_000)) return "invalid_receipt_reference";
	if (containsCredentialMaterial(JSON.stringify(input))) return "credential_rejected";
	return undefined;
}

function normalizedSettlementEvidenceRefs(input: SettleLearningInput): SettlementEvidenceRefs {
	return {
		artifact: [...new Set(input.artifactReceiptRefs)].sort(),
		delivery: [...new Set(input.deliveryReceiptRefs)].sort(),
	};
}

function scopeMatches(scope: SettleLearningInput["scope"], row: { platform: string | null; chat_id: string | null; chat_type: string | null; user_id: string | null; thread_id: string | null; project_id: string | null; organization_id: string | null }): boolean {
	return row.platform === scope.platform && row.chat_id === scope.chatId && row.chat_type === (scope.chatType ?? null) && row.user_id === (scope.userId ?? null)
		&& row.thread_id === (scope.threadId ?? null) && row.project_id === (scope.projectId ?? null) && row.organization_id === (scope.organizationId ?? null);
}

function attributionDrafts(input: SettleLearningInput, receipts: readonly ContributionReceiptRow[], observations: readonly ExecutionObservationRow[], settledAt: number): AttributionDraft[] {
	const accepted = input.criteria.filter((criterion) => criterion.status === "accepted");
	const rejected = input.criteria.filter((criterion) => criterion.status === "rejected");
	const drafts: AttributionDraft[] = [];
	if (accepted.length) {
		const perCriterionExposure = 0.1 / accepted.length;
		for (const receipt of receipts) for (const criterion of accepted) drafts.push({
			criterionId: criterion.criterionId,
			component: { kind: receipt.component_kind, id: receipt.component_id, version: receipt.component_version, digest: receipt.component_digest },
			causeCode: "correlated_context", contributionStrength: 0.1, positiveWeight: perCriterionExposure, failureWeight: 0,
			supportingReceiptIds: [receipt.receipt_id], confidenceBand: "medium",
		});
		const successful = correlatedCriterionObservations(accepted, observations.filter((observation) => observation.status === "succeeded"), settledAt);
		const perCriterionUse = successful.length ? 1 / successful.length : 0;
		for (const { criterion, observation } of successful) {
			const component = parseComponentRef(observation.component);
			if (!component) continue;
			drafts.push({ criterionId: criterion.criterionId, component, causeCode: "correlated_execution", contributionStrength: 1, positiveWeight: perCriterionUse, failureWeight: 0, supportingReceiptIds: [observation.observation_id], confidenceBand: "high" });
		}
	}
	if (rejected.length) {
		const failed = correlatedCriterionObservations(rejected, observations.filter((observation) => observation.status === "failed" && observation.event_type === "tool.settled"), settledAt);
		const divisor = Math.max(1, failed.length);
		for (const { criterion, observation } of failed) {
			const component = parseComponentRef(observation.component);
			if (!component) continue;
			drafts.push({
				criterionId: criterion.criterionId, component, causeCode: failureCause(component.kind), contributionStrength: 1,
				positiveWeight: 0, failureWeight: 1 / divisor, supportingReceiptIds: [observation.observation_id], confidenceBand: "high",
			});
		}
	}
	return drafts;
}

function correlatedCriterionObservations(criteria: readonly CriterionOutcome[], observations: readonly ExecutionObservationRow[], settledAt: number): Array<{ criterion: CriterionOutcome; observation: ExecutionObservationRow }> {
	return observations.flatMap((observation) => {
		if (!observation.source_ref || !Number.isSafeInteger(observation.occurred_at) || observation.occurred_at > settledAt) return [];
		return criteria.filter((criterion) => criterion.evidenceRefs.includes(observation.source_ref!) || criterion.evidenceRefs.includes(observation.observation_id))
			.map((criterion) => ({ criterion, observation }));
	});
}

const MEMORY_COMPONENT_KINDS = new Set<MemoryComponentKind>(["claim", "episode", "convention", "workflow", "projection", "source", "capability", "tool", "skill", "artifact"]);
function parseComponentRef(value: string | null): MemoryComponentRef | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as Partial<MemoryComponentRef>;
		if (!parsed.kind || !MEMORY_COMPONENT_KINDS.has(parsed.kind) || typeof parsed.id !== "string" || !parsed.id.trim() || typeof parsed.version !== "string" || !parsed.version.trim() || typeof parsed.digest !== "string" || !/^[a-f0-9]{64}$/i.test(parsed.digest)) return undefined;
		return { kind: parsed.kind, id: parsed.id, version: parsed.version, digest: parsed.digest };
	} catch { return undefined; }
}

function failureCause(kind: MemoryComponentKind): string {
	if (kind === "tool") return "tool_execution";
	if (kind === "skill") return "skill_deviation";
	if (kind === "capability") return "capability_mismatch";
	if (kind === "artifact") return "artifact_invalid";
	if (kind === "source") return "source_stale";
	return "unknown";
}

function assessmentState(input: {
	priorState: AssessmentRow["state"];
	acceptedWeight: number;
	failureWeight: number;
	consecutiveSuccesses: number;
	consecutiveFailures: number;
	posteriorMean: number;
	riskTier: AssessmentRow["risk_tier"];
	compensation: boolean;
}): AssessmentRow["state"] {
	const observations = input.acceptedWeight + input.failureWeight;
	if (input.compensation && observations <= 0) return "eligible";
	if (input.compensation) {
		if (observations >= 5 && input.posteriorMean < 0.45) return "suppressed";
		const floor = input.riskTier === "high" ? 0.9 : input.riskTier === "medium" ? 0.75 : 0.6;
		return observations >= 3 && input.posteriorMean < floor ? "cautious" : "eligible";
	}
	if (input.priorState === "eligible") {
		const floor = input.riskTier === "high" ? 0.9 : input.riskTier === "medium" ? 0.75 : 0.6;
		if (input.riskTier === "high" && input.consecutiveFailures >= 1 || input.consecutiveFailures >= 2 || observations >= 3 && input.posteriorMean < floor) return "cautious";
		return "eligible";
	}
	if (input.priorState === "cautious") {
		if (input.riskTier === "high" && input.consecutiveFailures >= 2 || input.consecutiveFailures >= 3 || observations >= 5 && input.posteriorMean < 0.45) return "suppressed";
		const recoveryMean = input.riskTier === "high" ? 0.9 : 0.7;
		if (input.consecutiveSuccesses >= 3 && input.posteriorMean >= recoveryMean) return "eligible";
		return "cautious";
	}
	const requiredRevalidations = input.riskTier === "high" ? 3 : 2;
	return input.consecutiveSuccesses >= requiredRevalidations ? "cautious" : "suppressed";
}

function strongerRisk(current: AssessmentRow["risk_tier"] | undefined, incoming: AssessmentRow["risk_tier"]): AssessmentRow["risk_tier"] {
	if (!current) return incoming;
	const order = { low: 0, medium: 1, high: 2 } as const;
	return order[current] >= order[incoming] ? current : incoming;
}

function assessmentTransitionRef(event: AssessmentEventResultRow): string {
	return `${event.component_kind}:${event.component_id}:${event.component_version}@${event.situation_fingerprint}:${event.prior_state}->${event.resulting_state}`;
}

function learningScopeFromExecution(value: string | null, profileId: string): SettleLearningInput["scope"] | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (typeof parsed.platform !== "string" || !parsed.platform.trim() || typeof parsed.chatId !== "string" || !parsed.chatId.trim()) return undefined;
		const chatType = parsed.chatType === "dm" || parsed.chatType === "group" || parsed.chatType === "channel" || parsed.chatType === "thread" ? parsed.chatType : undefined;
		return {
			profileId, platform: parsed.platform, chatId: parsed.chatId,
			...(chatType ? { chatType } : {}), ...(typeof parsed.userId === "string" && parsed.userId ? { userId: parsed.userId } : {}),
			...(typeof parsed.threadId === "string" && parsed.threadId ? { threadId: parsed.threadId } : {}),
		};
	} catch { return undefined; }
}

function learningScopeFromObservation(row: EvidenceLearningObservationRow, profileId: string): SettleLearningInput["scope"] | undefined {
	if (!row.platform?.trim() || !row.chat_id?.trim()) return undefined;
	const chatType = row.chat_type === "dm" || row.chat_type === "group" || row.chat_type === "channel" || row.chat_type === "thread" ? row.chat_type : undefined;
	return { profileId, platform: row.platform, chatId: row.chat_id, ...(chatType ? { chatType } : {}), ...(row.user_id ? { userId: row.user_id } : {}), ...(row.thread_id ? { threadId: row.thread_id } : {}), ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.organization_id ? { organizationId: row.organization_id } : {}) };
}

function learningScopeFromExtractionRow(row: ExtractionEvidenceRow, profileId: string): SettleLearningInput["scope"] {
	const scope = learningScopeFromObservation({ ...row, type: "evidence" }, profileId);
	if (!scope) throw new Error("Learning extraction evidence scope is invalid");
	return scope;
}

function memoryEventIdFromSourceRef(sourceRef: string | null): string | undefined {
	const prefix = "memory-event:";
	if (!sourceRef?.startsWith(prefix)) return undefined;
	const eventId = sourceRef.slice(prefix.length);
	return eventId && eventId.length <= 512 ? eventId : undefined;
}

function learningScopeFromObjectiveRow(row: LearningObjectiveRow, profileId: string): SettleLearningInput["scope"] {
	if (!row.platform.trim() || !row.chat_id.trim()) throw new Error("Learning Objective scope is invalid");
	const chatType = row.chat_type === "dm" || row.chat_type === "group" || row.chat_type === "channel" || row.chat_type === "thread" ? row.chat_type : undefined;
	if (!chatType) throw new Error("Learning Objective requires a routable conversation scope");
	return {
		profileId,
		platform: row.platform,
		chatId: row.chat_id,
		chatType,
		...(row.user_id ? { userId: row.user_id } : {}),
		...(row.thread_id ? { threadId: row.thread_id } : {}),
		...(row.project_id ? { projectId: row.project_id } : {}),
		...(row.organization_id ? { organizationId: row.organization_id } : {}),
	};
}

function learningVisibilityAccessWhere(alias: string, scope: MemoryCandidateRecallInput["scope"]): { where: string; params: unknown[] } {
	return {
		where: `(
			(${alias}.visibility = 'private' AND ${alias}.platform = ? AND ${alias}.chat_id = ? AND ${alias}.chat_type IS ? AND ${alias}.user_id IS ? AND ${alias}.thread_id IS ? AND ${alias}.project_id IS ? AND ${alias}.organization_id IS ?)
			OR (${alias}.visibility = 'conversation' AND ${alias}.platform = ? AND ${alias}.chat_id = ? AND ${alias}.chat_type IS ? AND ${alias}.thread_id IS ? AND ${alias}.project_id IS ? AND ${alias}.organization_id IS ?)
			OR (${alias}.visibility = 'project' AND ? IS NOT NULL AND ${alias}.project_id = ? AND ${alias}.organization_id IS ?)
			OR (${alias}.visibility = 'organization' AND ? IS NOT NULL AND ${alias}.organization_id = ?)
		)`,
		params: [
			scope.platform, scope.chatId, scope.chatType ?? null, scope.userId ?? null, scope.threadId ?? null, scope.projectId ?? null, scope.organizationId ?? null,
			scope.platform, scope.chatId, scope.chatType ?? null, scope.threadId ?? null, scope.projectId ?? null, scope.organizationId ?? null,
			scope.projectId ?? null, scope.projectId ?? null, scope.organizationId ?? null, scope.organizationId ?? null, scope.organizationId ?? null,
		],
	};
}

function sameVisibilityScopeWhere(alias: string, source: EpisodeProjectionRow): { where: string; params: unknown[] } {
	if (source.visibility === "project") {
		if (!source.project_id) throw new Error("Project-visible Episode is missing its project scope");
		return { where: `${alias}.project_id = ? AND ${alias}.organization_id IS ?`, params: [source.project_id, source.organization_id] };
	}
	if (source.visibility === "organization") {
		if (!source.organization_id) throw new Error("Organization-visible Episode is missing its organization scope");
		return { where: `${alias}.organization_id = ?`, params: [source.organization_id] };
	}
	if (source.visibility === "conversation") return {
		where: `${alias}.platform = ? AND ${alias}.chat_id = ? AND ${alias}.chat_type IS ? AND ${alias}.thread_id IS ? AND ${alias}.project_id IS ? AND ${alias}.organization_id IS ?`,
		params: [source.platform, source.chat_id, source.chat_type, source.thread_id, source.project_id, source.organization_id],
	};
	return {
		where: `${alias}.platform = ? AND ${alias}.chat_id = ? AND ${alias}.chat_type IS ? AND ${alias}.user_id IS ? AND ${alias}.thread_id IS ? AND ${alias}.project_id IS ? AND ${alias}.organization_id IS ?`,
		params: [source.platform, source.chat_id, source.chat_type, source.user_id, source.thread_id, source.project_id, source.organization_id],
	};
}

function projectionScopeKey(scope: ProjectionPlan["scope"], visibility: ProjectionPlan["visibility"]): string {
	const identity = visibility === "organization" ? { visibility, organizationId: scope.organizationId ?? null }
		: visibility === "project" ? { visibility, projectId: scope.projectId ?? null, organizationId: scope.organizationId ?? null }
			: visibility === "conversation" ? { visibility, platform: scope.platform, chatId: scope.chatId, chatType: scope.chatType ?? null, threadId: scope.threadId ?? null, projectId: scope.projectId ?? null, organizationId: scope.organizationId ?? null }
				: { visibility, platform: scope.platform, chatId: scope.chatId, chatType: scope.chatType ?? null, userId: scope.userId ?? null, threadId: scope.threadId ?? null, projectId: scope.projectId ?? null, organizationId: scope.organizationId ?? null };
	return sha256(canonicalJson(identity));
}

function learningObjectiveClaimMatches(claim: LearningObjectiveClaim, row: LearningObjectiveRow, profileId: string): boolean {
	let scope: SettleLearningInput["scope"];
	try { scope = learningScopeFromObjectiveRow(row, profileId); }
	catch { return false; }
	return claim.profileId === profileId
		&& claim.proposalId === row.proposal_id
		&& claim.observationId === row.observation_id
		&& claim.evidenceDigest === row.evidence_digest
		&& claim.proposalDigest === row.proposal_digest
		&& claim.statement === row.statement
		&& claim.confidence === row.confidence
		&& claim.intendedVerification === row.intended_verification
		&& claim.authorityWatermark === row.authority_watermark
		&& claim.policyVersion === row.policy_version
		&& canonicalJson([...claim.evidenceRefs]) === canonicalJson(parseStringList(row.evidence_refs))
		&& canonicalJson(claim.scope) === canonicalJson(scope);
}

function validateExtractionBundle(bundle: LearningExtractionBundle, claim: LearningExtractionClaim): ValidatedExtractionProposal[] {
	const extractorVersion = requiredText(bundle.extractorVersion, "Learning extractor version", 256);
	if (bundle.modelVersion !== undefined) requiredText(bundle.modelVersion, "Learning extraction model version", 512);
	if (!Number.isSafeInteger(bundle.generatedAt) || bundle.generatedAt < 0 || bundle.proposals.length > 20) throw new Error("Learning extraction bundle is invalid");
	if (containsCredentialMaterial(JSON.stringify(bundle))) throw new Error("Learning extraction proposal contains credential material");
	const allowedRefs = new Set([claim.observationId, `evidence:${claim.evidenceDigest}`, ...(claim.sourceRef ? [claim.sourceRef] : [])]);
	return bundle.proposals.map((proposal): ValidatedExtractionProposal => {
		const kinds = new Set(["claim", "preference", "correction", "exception", "convention", "workflow", "source_observation", "capability_gap", "failure_shield"]);
		if (!kinds.has(proposal.kind)) throw new Error("Learning extraction proposal kind is invalid");
		const statement = requiredText(proposal.statement, "Learning extraction statement", 5_000);
		if (instructionLikeEvidence(statement)) throw new Error("Learning extraction proposal contains instruction-like evidence");
		if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) throw new Error("Learning extraction confidence is invalid");
		if (!Array.isArray(proposal.evidenceRefs) || !proposal.evidenceRefs.length || proposal.evidenceRefs.length > 10 || !proposal.evidenceRefs.includes(claim.observationId)
			|| proposal.evidenceRefs.some((ref) => typeof ref !== "string" || !allowedRefs.has(ref))) throw new Error("Learning extraction evidence references are invalid");
		if (!Array.isArray(proposal.sourceSpans) || !proposal.sourceSpans.length || proposal.sourceSpans.length > 10) throw new Error("Learning extraction source spans are invalid");
		const persistedSpans = proposal.sourceSpans.map((span) => {
			if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > claim.content.length
				|| claim.content.slice(span.start, span.end) !== span.quote || !span.quote.trim()) throw new Error("Learning extraction source span does not match retained evidence");
			return { start: span.start, end: span.end, quoteDigest: sha256(span.quote) };
		});
		const intendedVerification = proposal.intendedVerification === undefined ? undefined : requiredText(proposal.intendedVerification, "Learning extraction intended Verification", 2_000);
		const normalized = { kind: proposal.kind, statement, confidence: proposal.confidence, evidenceRefs: [...new Set(proposal.evidenceRefs)], persistedSpans, ...(intendedVerification ? { intendedVerification } : {}) };
		return { ...proposal, statement, evidenceRefs: normalized.evidenceRefs, ...(intendedVerification ? { intendedVerification } : {}), proposalDigest: sha256(canonicalJson({ extractorVersion, ...normalized })), sourceExcerpt: proposal.sourceSpans[0]!.quote, persistedSpans };
	});
}

function instructionLikeEvidence(value: string): boolean {
	return /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|system\s+prompt|developer\s+message|<\/?(?:system|assistant|tool)>/iu.test(value);
}

function correctionTargetId(sourceRef: string | null): string | undefined {
	if (!sourceRef?.startsWith("claim:")) return undefined;
	const target = sourceRef.slice("claim:".length).trim();
	return target && target.length <= 512 ? target : undefined;
}

function taskLearningCriteria(row: TaskRunLearningRow): SettleLearningInput["criteria"] {
	if (row.criterion_verifications) {
		try {
			const parsed = JSON.parse(row.criterion_verifications) as unknown;
			if (Array.isArray(parsed) && parsed.length && parsed.every((item) => {
				if (!item || typeof item !== "object") return false;
				const candidate = item as Record<string, unknown>;
				return typeof candidate.criterionId === "string" && (candidate.status === "accepted" || candidate.status === "rejected" || candidate.status === "unavailable")
					&& Array.isArray(candidate.evidenceRefs) && candidate.evidenceRefs.every((ref) => typeof ref === "string");
			})) return parsed.map((item) => {
				const candidate = item as { criterionId: string; status: "accepted" | "rejected" | "unavailable"; evidenceRefs: string[] };
				return { criterionId: candidate.criterionId, status: candidate.status, evidenceRefs: [...candidate.evidenceRefs] };
			});
		} catch { /* deterministic fallback below */ }
	}
	const status = row.verification_outcome === "accepted" || row.verification_outcome === "rejected" || row.verification_outcome === "unavailable" ? row.verification_outcome : "unavailable";
	return [{ criterionId: "task_outcome", status, evidenceRefs: row.evidence ? [`task-evidence:${sha256(row.evidence)}`] : [] }];
}

function taskLearningArtifactReceiptRefs(row: TaskRunLearningRow): string[] {
	if (!row.artifacts) return [];
	try {
		const parsed = JSON.parse(row.artifacts) as unknown;
		if (!Array.isArray(parsed)) return [];
		const refs = parsed.flatMap((item): string[] => {
			if (!item || typeof item !== "object") return [];
			const artifact = item as { manifest?: unknown; verificationReceipt?: unknown };
			const values = [
				artifact.manifest && typeof artifact.manifest === "object" ? (artifact.manifest as { id?: unknown }).id : undefined,
				artifact.verificationReceipt && typeof artifact.verificationReceipt === "object" ? (artifact.verificationReceipt as { id?: unknown }).id : undefined,
			];
			return values.filter((value): value is string => typeof value === "string" && /^(?:artifact|artifact-verification):sha256:[a-f0-9]{64}$/i.test(value));
		});
		return [...new Set(refs)].sort().slice(0, 100);
	} catch { return []; }
}

function episodeProjectionDigest(row: EpisodeProjectionRow): string {
	return sha256(canonicalJson({ profileId: row.profile_id, platform: row.platform, chatId: row.chat_id, chatType: row.chat_type, userId: row.user_id, threadId: row.thread_id,
		projectId: row.project_id, organizationId: row.organization_id, visibility: row.visibility, objectiveId: row.objective_id, situation: row.situation_summary, action: row.action, outcome: row.outcome, evidence: row.evidence, status: row.status }));
}

function claimProjectionDigest(row: ClaimProjectionRow): string {
	return sha256(canonicalJson({ profileId: row.profile_id, platform: row.platform, chatId: row.chat_id, userId: row.user_id, threadId: row.thread_id, projectId: row.project_id,
		organizationId: row.organization_id, visibility: row.visibility, kind: row.kind, statement: row.statement, sourceRef: row.source_ref, status: row.status }));
}

function claimProjectionScope(row: ClaimProjectionRow): SettleLearningInput["scope"] {
	return { profileId: row.profile_id, platform: row.platform, chatId: row.chat_id, ...(row.visibility === "private" ? { chatType: "dm" as const } : {}), ...(row.user_id ? { userId: row.user_id } : {}),
		...(row.thread_id ? { threadId: row.thread_id } : {}), ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.organization_id ? { organizationId: row.organization_id } : {}) };
}

function projectionVisibility(values: ClaimProjectionRow["visibility"][]): ProjectionPlan["visibility"] {
	if (values.includes("private")) return "private";
	if (values.includes("conversation")) return "conversation";
	if (values.includes("team")) return "project";
	return "organization";
}

function safeProjectionText(value: string, maxLength: number): string {
	return value.trim().slice(0, maxLength).replaceAll("<", "＜").replaceAll(">", "＞");
}

function lexicalTerms(value: string): string[] {
	const normalized = value.normalize("NFKC").toLocaleLowerCase();
	const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
	const terms = new Set<string>();
	for (const word of words) {
		if (word.length > 1) terms.add(word);
		if (/^[\u3400-\u9fff]+$/u.test(word) && word.length > 2) for (let index = 0; index < word.length - 1; index++) terms.add(word.slice(index, index + 2));
	}
	return [...terms].slice(0, 32);
}

function lexicalRelevance(query: string, content: string): number {
	const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase().trim();
	const normalizedContent = content.normalize("NFKC").toLocaleLowerCase();
	if (normalizedQuery && normalizedContent.includes(normalizedQuery)) return 1;
	const terms = lexicalTerms(normalizedQuery);
	if (!terms.length) return 0;
	const matched = terms.filter((term) => normalizedContent.includes(term)).length;
	return boundedScore(matched / terms.length);
}

function escapeLike(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"); }
function recencyScore(now: number, at: number): number { return boundedScore(1 / (1 + Math.max(0, now - at) / (30 * 24 * 60 * 60 * 1_000))); }
function safeReasonCode(_error: unknown): string { return "maintenance_processing_failed"; }
function mostRestrictiveApplicability(...values: Array<MemoryRecallCandidate["applicability"] | undefined>): MemoryRecallCandidate["applicability"] {
	if (values.includes("suppressed")) return "suppressed";
	if (values.includes("cautious")) return "cautious";
	return "eligible";
}
function routingSeverity(value: "cautious" | "suppressed"): number { return value === "suppressed" ? 2 : 1; }

function validateManagedSkillVersionInput(input: RegisterManagedSkillVersionInput): void {
	managedSkillName(input.name);
	assertSha256Digest(input.versionSha256, "Managed Skill version");
	assertSha256Digest(input.artifactSha256, "Managed Skill artifact");
	requiredText(input.signedReceiptRef, "Managed Skill signed receipt", 1_000);
	requiredText(input.policyVersion, "Managed Skill policy version", 128);
	if (input.riskTier !== "low" && input.riskTier !== "medium" && input.riskTier !== "high") throw new Error("Managed Skill risk tier is invalid");
	const trials = [...new Set(input.acceptedTrialIds.map((trial) => requiredText(trial, "Managed Skill accepted trial", 256)))];
	if (trials.length < 3 || trials.length !== input.acceptedTrialIds.length) throw new Error("Managed Skill automatic registration requires three distinct accepted trials");
	if (!Number.isSafeInteger(input.registeredAt) || input.registeredAt < 0) throw new Error("Managed Skill registration time is invalid");
	if (containsCredentialMaterial(JSON.stringify(input))) throw new Error("Managed Skill registration metadata cannot contain credential material");
}

function managedSkillName(value: string): string {
	const name = requiredText(value, "Managed Skill name", 64);
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Managed Skill name is invalid");
	return name;
}

function assertSha256Digest(value: string, label: string): void { if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} SHA-256 is invalid`); }

function deterministicCanaryBucket(profileId: string, name: string, executionId: string, policyVersion: string): number {
	return Number.parseInt(sha256(canonicalJson([profileId, name, executionId, policyVersion])).slice(0, 8), 16) % 100;
}

function mapManagedSkillSelection(row: ManagedSkillSelectionRow): ManagedSkillSelectionReceipt {
	const unsigned = {
		name: row.skill_name, executionId: row.execution_id, channel: row.channel, versionSha256: row.version_sha256, artifactSha256: row.artifact_sha256,
		bucket: row.bucket, canaryPercentage: row.canary_percentage, pointerRevision: row.pointer_revision, policyVersion: row.policy_version, selectedAt: row.selected_at,
	};
	if (row.receipt_digest !== sha256(canonicalJson(unsigned))) throw new Error("Managed Skill selection receipt digest is invalid");
	return { receiptId: row.receipt_id, receiptDigest: row.receipt_digest, ...unsigned };
}

function parseStringList(value: string): string[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("Stored Memory Learning string list is invalid");
	return parsed;
}

function boundedScore(value: number): number { return Number(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)).toFixed(6)); }
function boundedInteger(value: number, label: string, min: number, max: number): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Memory Learning ${label} must be between ${min} and ${max}`); return value; }
function requiredText(value: string, label: string, max: number): string { const normalized = value.trim(); if (!normalized || normalized.length > max) throw new Error(`Memory Learning ${label} is invalid`); return normalized; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { return JSON.stringify(canonical(value)); }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])); }

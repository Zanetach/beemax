/**
 * Long-term memory store backed by SQLite + FTS5.
 *
 * This is the BeeMax analogue of Hermes' memory_manager + FTS5 session search.
 * Two tables:
 *   - memories: curated facts/preferences the agent chose to remember.
 *   - exchanges: full user<->assistant turns, FTS5-indexed for cross-session
 *     recall ("what did I ask last week about X?").
 *
 * We start with FTS5 only (zero extra deps beyond better-sqlite3). Vector
 * embeddings can be layered on later without changing the recall API.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { AUTONOMY_LEVELS, containsCredentialMaterial, createAccessScopeRef, createEnterprisePolicyPublisher, createSituation, multilingualLexicalTerms, parseTaskCheckpoint, redactCredentialMaterial, renderTaskCheckpoint, unavailableTaskCriterionVerifications, type AutonomyLevel, type AutonomyRolloutEvidence, type AutonomyRolloutRecord, type AutonomyRolloutStateStore, type CompensationProof, type ConversationMemoryPort, type DeliveryTarget, type DurableInitiativeTrigger, type DurableInitiativeTriggerInput, type EmergencyStopRecord, type EnterprisePolicyPublisher, type InitiativeObservation, type InitiativeObservationInput, type InitiativeObservationStore, type InitiativeScope, type InitiativeTriggerInbox, type OrganizationKnowledgeHit, type OrganizationKnowledgeRecall, type ReversibleActionControlPort, type Situation, type TaskCandidateVerificationResolution, type TaskCheckpoint, type TaskDependency, type TaskLedger, type TaskPlanCompletionNotice, type TaskPlanNoticeOutbox, type TaskPlanQuery, type TaskPlanRecord, type TaskPlanTransition, type TaskQuery, type TaskRecord as RuntimeTaskRecord, type TaskRecoveryResult, type TaskRunEffectStateReader, type TaskRunRecord, type TaskRunTransition, type TaskTransition } from "@beemax/core";

export const MEMORY_CLAIM_KINDS = ["preference", "fact", "decision", "goal", "project", "relationship", "workflow", "exception"] as const;
const EPISODE_STATUSES = new Set<OrganizationMemoryEpisodeStatus>(["candidate", "verified", "conflicted", "superseded"]);
export type MemoryClaimKind = typeof MEMORY_CLAIM_KINDS[number];
export interface BusinessEntityRef { type: string; id: string; }
export const MEMORY_CLAIM_KIND_LABELS: Record<MemoryClaimKind, string> = { preference: "沟通与偏好", fact: "稳定事实", decision: "关键决策", goal: "长期目标", project: "项目", relationship: "重要关系", workflow: "工作方式", exception: "工作例外" };

export interface MemoryRecord {
	id: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	role: "user" | "assistant" | "memory";
	content: string;
	createdAt: number;
	subject?: BusinessEntityRef;
	object?: BusinessEntityRef;
	/** Provenance used by context assembly to keep unconfirmed evidence distinguishable from durable facts. */
	memoryType?: "curated" | "claim" | "candidate";
	confidence?: number;
}

export interface MemoryRecallHit extends MemoryRecord {
	memoryType: "curated" | "claim" | "candidate";
	confidence: number;
	status: MemoryClaim["status"] | "active" | "pending";
	score: number;
	matchReasons: string[];
	subject?: BusinessEntityRef;
	object?: BusinessEntityRef;
}
export interface MemoryRecallEvaluationCase { query: string; options: RecallOptions; expectedIds: string[]; forbiddenIds?: string[]; }
export interface MemoryRecallEvaluation { cases: number; hitCases: number; hitRateAtK: number; expected: number; expectedRetrieved: number; recallAtK: number; forbiddenRetrieved: number; forbiddenRetrievalRate: number; }

export interface RecallOptions {
	profileId?: string;
	limit?: number;
	platform?: string;
	chatId?: string;
	userId?: string;
	threadId?: string;
	/** Disclosure surface. Omitted preserves trusted programmatic compatibility; runtime callers always set it. */
	chatType?: "dm" | "group" | "channel" | "thread";
	projectId?: string;
	organizationId?: string;
	subject?: BusinessEntityRef;
	object?: BusinessEntityRef;
	/** Pending conversation evidence is excluded unless the caller explicitly opts in. */
	includeCandidates?: boolean;
}

export interface MemoryCandidate extends MemoryRecord {
	status: "pending" | "promoted" | "rejected";
}

/** A durable, explainable statement about the user or their work. */
export interface MemoryClaim {
	profileId?: string;
	id: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	projectId?: string;
	organizationId?: string;
	kind: MemoryClaimKind;
	statement: string;
	confidence: number;
	stability: "low" | "medium" | "high";
	status: "candidate" | "active" | "superseded" | "conflicted" | "rejected" | "archived";
	subject?: BusinessEntityRef;
	object?: BusinessEntityRef;
	source?: { type: "message" | "document" | "meeting" | "tool" | "manual" | "import"; ref?: string };
	visibility: "private" | "conversation" | "team" | "organization";
	validFrom?: number;
	validUntil?: number;
	conflictsWith: string[];
	supersededBy?: string;
	firstObservedAt: number;
	lastConfirmedAt: number;
	expiresAt?: number;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryEvidence {
	id: string;
	claimId: string;
	kind: "conversation" | "manual" | "correction" | "conflict" | "exception" | "revocation";
	eventId?: string;
	sourceRef?: string;
	event?: MemoryEvent;
	excerpt: string;
	createdAt: number;
}

export interface MemoryEvent {
	id: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	kind: "user" | "assistant" | "import" | "feedback";
	content: string;
	occurredAt: number;
	createdAt: number;
}

export interface MemoryBrief {
	claims: MemoryClaim[];
	records: MemoryRecord[];
}

export type OrganizationMemoryEpisodeStatus = "candidate" | "verified" | "conflicted" | "superseded";
export interface OrganizationMemoryEpisode {
	id: string;
	profileId: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	objectiveId: string;
	situation: Situation;
	action: string;
	outcome: string;
	evidence?: string;
	status: OrganizationMemoryEpisodeStatus;
	createdAt: number;
	updatedAt: number;
}
export interface OrganizationMemoryEpisodeInput {
	profileId?: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	objectiveId: string;
	situation: Situation;
	action: string;
	outcome: string;
	evidence?: string;
	status?: OrganizationMemoryEpisodeStatus;
}

export type ConventionCandidateStatus = "candidate" | "confirmed" | "rejected" | "superseded" | "rolled_back";
export interface ConventionCandidate {
	id: string;
	profileId: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	statement: string;
	rationale: string;
	confidence: number;
	promotionBlocked: boolean;
	observedFrom: number;
	observedUntil: number;
	status: ConventionCandidateStatus;
	supportingEpisodeIds: string[];
	contradictoryEpisodeIds: string[];
	exceptionClaimIds: string[];
	supersededBy?: string;
	createdAt: number;
	updatedAt: number;
}

export interface ConventionCandidateInput extends Omit<RecallOptions, "limit" | "includeCandidates" | "projectId" | "organizationId" | "subject" | "object"> {
	statement: string;
	rationale: string;
	confidence: number;
	supportingEpisodeIds: string[];
	contradictoryEpisodeIds?: string[];
	exceptionClaimIds?: string[];
}

export interface ConventionCandidateEvent {
	id: string;
	candidateId: string;
	kind: "confirmed" | "rejected" | "superseded" | "rollback";
	excerpt: string;
	sourceRef?: string;
	createdAt: number;
}

export interface ConventionTransitionEvidence { excerpt: string; sourceRef?: string; }

export type WorkflowCandidateStatus = "candidate" | "rejected" | "superseded" | "archived";
export interface WorkflowCandidate {
	id: string; profileId: string; platform: string; chatId: string; userId?: string; threadId?: string;
	title: string; summary: string; conditions: string[]; exceptions: string[]; inputs: string[]; instructions: string[];
	expectedOutcomes: string[]; verification: string[]; sourceConventionIds: string[]; supportingEpisodeIds: string[];
	contradictoryEpisodeIds: string[]; status: WorkflowCandidateStatus; revision: number; supersededBy?: string; createdAt: number; updatedAt: number;
}
export interface WorkflowCandidateInput extends Pick<RecallOptions, "profileId" | "platform" | "chatId" | "userId" | "threadId"> {
	title: string; summary: string; conditions: string[]; exceptions: string[]; inputs: string[]; instructions: string[];
	expectedOutcomes: string[]; verification: string[]; sourceConventionIds: string[];
}
export interface WorkflowCandidateEdit { title?: string; summary?: string; conditions?: string[]; exceptions?: string[]; inputs?: string[]; instructions?: string[]; expectedOutcomes?: string[]; verification?: string[]; }
export interface WorkflowCandidateEvent { id: string; candidateId: string; kind: "edited" | "rejected" | "superseded" | "archived"; excerpt: string; sourceRef?: string; createdAt: number; }
export interface WorkflowTransitionEvidence { excerpt: string; sourceRef?: string; }
export interface WorkflowSkillCandidateDraft { name: string; description: string; instructions: string; source: string; }

export interface ClaimInput {
	profileId?: string;
	platform: string;
	chatId: string;
	userId?: string;
	threadId?: string;
	projectId?: string;
	organizationId?: string;
	kind: MemoryClaim["kind"];
	statement: string;
	confidence?: number;
	stability?: MemoryClaim["stability"];
	expiresAt?: number;
	subject?: MemoryClaim["subject"];
	object?: MemoryClaim["object"];
	source?: MemoryClaim["source"];
	visibility?: MemoryClaim["visibility"];
	validFrom?: number;
	validUntil?: number;
	evidence?: { kind?: MemoryEvidence["kind"]; eventId?: string; sourceRef?: string; excerpt: string };
}

/** Durable, verifiable work state. Unlike chat memory, this is a current fact source. */
export interface TaskFactRecord {
	id: string;
	title: string;
	status: "open" | "in_progress" | "done" | "cancelled";
	evidence?: string;
	completedAt?: number;
	updatedAt: number;
}

export class MemoryStore {
	private readonly db: DatabaseType;
	private readonly profileId: string;

	constructor(dbPath: string, profileId = "default") {
		this.profileId = profileId;
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
				subject_type TEXT,
				subject_id TEXT,
				object_type TEXT,
				object_id TEXT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
				content,
				content='memories',
				content_rowid='rowid',
				tokenize='unicode61 remove_diacritics 2'
			);

			CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
				INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
				INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
			END;

			CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(platform, chat_id);
			CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(platform, user_id);
			CREATE INDEX IF NOT EXISTS idx_memories_scope_created ON memories(platform, chat_id, user_id, created_at DESC);

			CREATE TABLE IF NOT EXISTS memory_candidates (
				id TEXT PRIMARY KEY,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				created_at INTEGER NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_candidates_fts USING fts5(
				content,
				content='memory_candidates',
				content_rowid='rowid',
				tokenize='unicode61 remove_diacritics 2'
			);
			CREATE TRIGGER IF NOT EXISTS memory_candidates_ai AFTER INSERT ON memory_candidates BEGIN
				INSERT INTO memory_candidates_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memory_candidates_ad AFTER DELETE ON memory_candidates BEGIN
				INSERT INTO memory_candidates_fts(memory_candidates_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memory_candidates_au AFTER UPDATE ON memory_candidates BEGIN
				INSERT INTO memory_candidates_fts(memory_candidates_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			END;
			CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope ON memory_candidates(platform, chat_id, user_id, status);
			CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_created ON memory_candidates(platform, chat_id, user_id, created_at DESC);

			CREATE TABLE IF NOT EXISTS task_ledger (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				description TEXT,
				status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
				evidence TEXT,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS task_plans (
				id TEXT PRIMARY KEY,
				owner_key TEXT NOT NULL,
				title TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
				task_count INTEGER NOT NULL,
				succeeded INTEGER NOT NULL DEFAULT 0,
				failed INTEGER NOT NULL DEFAULT 0,
				cancelled INTEGER NOT NULL DEFAULT 0,
				verified INTEGER NOT NULL DEFAULT 0,
				corrective_attempts INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER
				,paused_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_task_plans_owner_created ON task_plans(owner_key, created_at DESC);
			CREATE TABLE IF NOT EXISTS task_plan_execution_claims (
				plan_id TEXT PRIMARY KEY REFERENCES task_plans(id) ON DELETE CASCADE,
				owner_key TEXT NOT NULL,
				holder_id TEXT NOT NULL,
				lease_expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_task_plan_execution_claims_expiry ON task_plan_execution_claims(lease_expires_at);
			CREATE TABLE IF NOT EXISTS task_plan_completion_notices (
				id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, owner_key TEXT NOT NULL,
				platform TEXT NOT NULL, channel_instance_id TEXT, chat_id TEXT NOT NULL, chat_type TEXT, user_id TEXT, thread_id TEXT,
				plan_status TEXT NOT NULL CHECK (plan_status IN ('succeeded', 'failed', 'cancelled')),
				title TEXT NOT NULL, task_count INTEGER NOT NULL, succeeded INTEGER NOT NULL,
				failed INTEGER NOT NULL, cancelled INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'delivered')), claim_token TEXT,
				attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, abandoned_at INTEGER, last_error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_task_plan_completion_notices_due ON task_plan_completion_notices(status, next_attempt_at);
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				owner_key TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('objective', 'delegated', 'automation')),
				title TEXT NOT NULL,
				description TEXT,
				acceptance_criteria TEXT,
				recovery_policy TEXT NOT NULL DEFAULT 'never' CHECK (recovery_policy IN ('never', 'safe_retry')),
				idempotency_key TEXT,
				execution_scope TEXT,
				situation TEXT,
				access_scope_ref TEXT,
				business_context TEXT,
				status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
				parent_id TEXT,
				plan_id TEXT,
				evidence TEXT,
				artifacts TEXT,
				unresolved_issues TEXT,
				verification_status TEXT CHECK (verification_status IN ('pending', 'accepted', 'rejected')),
				verification_outcome TEXT CHECK (verification_outcome IN ('pending', 'accepted', 'rejected', 'unavailable')),
				verification_feedback TEXT,
				verification_requirements TEXT,
				criterion_verifications TEXT,
				verification_attempts INTEGER NOT NULL DEFAULT 0,
				verification_retry_at INTEGER,
				corrective_attempts INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				result TEXT,
				candidate_result TEXT,
				error TEXT,
				checkpoint TEXT,
				checkpoint_at INTEGER,
				routes TEXT,
				route_index INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_tasks_owner_created ON tasks(owner_key, created_at DESC);
			CREATE INDEX IF NOT EXISTS idx_tasks_owner_parent ON tasks(owner_key, parent_id);
			CREATE TABLE IF NOT EXISTS task_runs (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				executor TEXT NOT NULL CHECK (executor IN ('agent', 'subagent', 'automation')),
				status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
				started_at INTEGER NOT NULL,
				lease_expires_at INTEGER,
				finished_at INTEGER,
				output TEXT,
				error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_task_runs_task_started ON task_runs(task_id, started_at DESC);
			CREATE TABLE IF NOT EXISTS task_dependencies (
				task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
				PRIMARY KEY (task_id, depends_on)
			);
			CREATE INDEX IF NOT EXISTS idx_task_dependencies_upstream ON task_dependencies(depends_on);
			CREATE TABLE IF NOT EXISTS task_verification_claims (
				task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
				owner_key TEXT NOT NULL,
				holder_id TEXT NOT NULL,
				lease_expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_task_verification_claims_expiry ON task_verification_claims(lease_expires_at);

			CREATE TABLE IF NOT EXISTS memory_events (
				id TEXT PRIMARY KEY,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
				kind TEXT NOT NULL,
				content TEXT NOT NULL,
				occurred_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_events_scope_time ON memory_events(platform, user_id, chat_id, occurred_at DESC);

			CREATE TABLE IF NOT EXISTS memory_claims (
				id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL DEFAULT 'default',
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
				project_id TEXT,
				organization_id TEXT,
				kind TEXT NOT NULL,
				statement TEXT NOT NULL,
				subject_type TEXT,
				subject_id TEXT,
				object_type TEXT,
				object_id TEXT,
				source_type TEXT,
				source_ref TEXT,
				visibility TEXT NOT NULL DEFAULT 'private',
				valid_from INTEGER,
				valid_until INTEGER,
				confidence REAL NOT NULL,
				stability TEXT NOT NULL,
				status TEXT NOT NULL,
				superseded_by TEXT REFERENCES memory_claims(id),
				first_observed_at INTEGER NOT NULL,
				last_confirmed_at INTEGER NOT NULL,
				expires_at INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_claims_fts USING fts5(
				statement,
				content='memory_claims',
				content_rowid='rowid',
				tokenize='unicode61 remove_diacritics 2'
			);
			CREATE TRIGGER IF NOT EXISTS memory_claims_ai AFTER INSERT ON memory_claims BEGIN
				INSERT INTO memory_claims_fts(rowid, statement) VALUES (new.rowid, new.statement);
			END;
			CREATE TRIGGER IF NOT EXISTS memory_claims_ad AFTER DELETE ON memory_claims BEGIN
				INSERT INTO memory_claims_fts(memory_claims_fts, rowid, statement) VALUES('delete', old.rowid, old.statement);
			END;
			CREATE TRIGGER IF NOT EXISTS memory_claims_au AFTER UPDATE ON memory_claims BEGIN
				INSERT INTO memory_claims_fts(memory_claims_fts, rowid, statement) VALUES('delete', old.rowid, old.statement);
				INSERT INTO memory_claims_fts(rowid, statement) VALUES (new.rowid, new.statement);
			END;
			CREATE INDEX IF NOT EXISTS idx_memory_claims_scope_status ON memory_claims(platform, user_id, chat_id, status, updated_at DESC);

			CREATE TABLE IF NOT EXISTS memory_episodes (
				id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
				objective_id TEXT NOT NULL,
				situation TEXT NOT NULL,
				situation_summary TEXT NOT NULL,
				action TEXT NOT NULL,
				outcome TEXT NOT NULL,
				evidence TEXT,
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(profile_id, objective_id)
			);
			CREATE INDEX IF NOT EXISTS idx_memory_episodes_scope_status ON memory_episodes(profile_id, platform, chat_id, user_id, thread_id, status, updated_at DESC);
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_episodes_fts USING fts5(
				situation_summary, action, outcome,
				content='memory_episodes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
			);
			CREATE TRIGGER IF NOT EXISTS memory_episodes_ai AFTER INSERT ON memory_episodes BEGIN
				INSERT INTO memory_episodes_fts(rowid, situation_summary, action, outcome) VALUES (new.rowid, new.situation_summary, new.action, new.outcome);
			END;
			CREATE TRIGGER IF NOT EXISTS memory_episodes_ad AFTER DELETE ON memory_episodes BEGIN
				INSERT INTO memory_episodes_fts(memory_episodes_fts, rowid, situation_summary, action, outcome) VALUES('delete', old.rowid, old.situation_summary, old.action, old.outcome);
			END;
			CREATE TRIGGER IF NOT EXISTS memory_episodes_au AFTER UPDATE ON memory_episodes BEGIN
				INSERT INTO memory_episodes_fts(memory_episodes_fts, rowid, situation_summary, action, outcome) VALUES('delete', old.rowid, old.situation_summary, old.action, old.outcome);
				INSERT INTO memory_episodes_fts(rowid, situation_summary, action, outcome) VALUES (new.rowid, new.situation_summary, new.action, new.outcome);
			END;

			CREATE TABLE IF NOT EXISTS memory_convention_candidates (
				id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
				scope_key TEXT NOT NULL,
				canonical_statement TEXT NOT NULL,
				statement TEXT NOT NULL,
				rationale TEXT NOT NULL,
				confidence REAL NOT NULL,
				promotion_blocked INTEGER NOT NULL,
				observed_from INTEGER NOT NULL,
				observed_until INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'rejected', 'superseded', 'rolled_back')),
				superseded_by TEXT REFERENCES memory_convention_candidates(id),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(profile_id, scope_key, canonical_statement)
			);
			CREATE INDEX IF NOT EXISTS idx_memory_conventions_scope_status ON memory_convention_candidates(profile_id, platform, chat_id, user_id, thread_id, status, updated_at DESC);
			CREATE TABLE IF NOT EXISTS memory_convention_episode_evidence (
				candidate_id TEXT NOT NULL REFERENCES memory_convention_candidates(id) ON DELETE CASCADE,
				episode_id TEXT NOT NULL REFERENCES memory_episodes(id) ON DELETE CASCADE,
				relation TEXT NOT NULL CHECK (relation IN ('support', 'contradiction')),
				PRIMARY KEY (candidate_id, episode_id, relation)
			);
			CREATE TABLE IF NOT EXISTS memory_convention_exceptions (
				candidate_id TEXT NOT NULL REFERENCES memory_convention_candidates(id) ON DELETE CASCADE,
				claim_id TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
				PRIMARY KEY (candidate_id, claim_id)
			);
			CREATE TABLE IF NOT EXISTS memory_convention_events (
				id TEXT PRIMARY KEY,
				candidate_id TEXT NOT NULL REFERENCES memory_convention_candidates(id) ON DELETE CASCADE,
				kind TEXT NOT NULL CHECK (kind IN ('confirmed', 'rejected', 'superseded', 'rollback')),
				excerpt TEXT NOT NULL,
				source_ref TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_convention_events_candidate ON memory_convention_events(candidate_id, created_at DESC);

			CREATE TABLE IF NOT EXISTS memory_workflow_candidates (
				id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				platform TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
				scope_key TEXT NOT NULL,
				canonical_title TEXT NOT NULL,
				title TEXT NOT NULL,
				summary TEXT NOT NULL,
				conditions TEXT NOT NULL,
				exceptions TEXT NOT NULL,
				inputs TEXT NOT NULL,
				instructions TEXT NOT NULL,
				expected_outcomes TEXT NOT NULL,
				verification TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('candidate', 'rejected', 'superseded', 'archived')),
				revision INTEGER NOT NULL,
				superseded_by TEXT REFERENCES memory_workflow_candidates(id),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(profile_id, scope_key, canonical_title)
			);
			CREATE INDEX IF NOT EXISTS idx_memory_workflows_scope_status ON memory_workflow_candidates(profile_id, platform, chat_id, user_id, thread_id, status, updated_at DESC);
			CREATE TABLE IF NOT EXISTS memory_workflow_conventions (
				candidate_id TEXT NOT NULL REFERENCES memory_workflow_candidates(id) ON DELETE CASCADE,
				convention_id TEXT NOT NULL REFERENCES memory_convention_candidates(id) ON DELETE RESTRICT,
				PRIMARY KEY(candidate_id, convention_id)
			);
			CREATE TABLE IF NOT EXISTS memory_workflow_episode_evidence (
				candidate_id TEXT NOT NULL REFERENCES memory_workflow_candidates(id) ON DELETE CASCADE,
				episode_id TEXT NOT NULL REFERENCES memory_episodes(id) ON DELETE RESTRICT,
				relation TEXT NOT NULL CHECK (relation IN ('support', 'contradiction')),
				PRIMARY KEY(candidate_id, episode_id, relation)
			);
			CREATE TABLE IF NOT EXISTS memory_workflow_events (
				id TEXT PRIMARY KEY,
				candidate_id TEXT NOT NULL REFERENCES memory_workflow_candidates(id) ON DELETE CASCADE,
				kind TEXT NOT NULL CHECK (kind IN ('edited', 'rejected', 'superseded', 'archived')),
				excerpt TEXT NOT NULL,
				source_ref TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_workflow_events_candidate ON memory_workflow_events(candidate_id, created_at DESC);

			CREATE TABLE IF NOT EXISTS memory_evidence (
				id TEXT PRIMARY KEY,
				claim_id TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
				event_id TEXT REFERENCES memory_events(id),
				source_ref TEXT,
				kind TEXT NOT NULL,
				excerpt TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_evidence_claim ON memory_evidence(claim_id, created_at DESC);
			CREATE TABLE IF NOT EXISTS memory_claim_conflicts (
				claim_id TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
				conflicts_with TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (claim_id, conflicts_with),
				CHECK (claim_id <> conflicts_with)
			);

			CREATE TABLE IF NOT EXISTS initiative_observations (
				id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				platform TEXT NOT NULL,
				channel_instance_id TEXT,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
				dedupe_key TEXT NOT NULL,
				trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('heartbeat', 'message', 'task_transition', 'enterprise_event')),
				trigger_id TEXT NOT NULL,
				situation TEXT NOT NULL,
				action TEXT NOT NULL,
				expected_value REAL NOT NULL,
				risk TEXT NOT NULL CHECK (risk IN ('none', 'low', 'medium', 'high')),
				rationale TEXT NOT NULL,
				intended_verification TEXT NOT NULL,
				evidence_refs TEXT NOT NULL,
				confidence REAL NOT NULL,
				mode TEXT NOT NULL CHECK (mode = 'observe_only'),
				disposition TEXT NOT NULL CHECK (disposition IN ('new_candidate', 'relates_to_active_objective')),
				related_objective_id TEXT,
				notification_emitted INTEGER NOT NULL DEFAULT 0 CHECK (notification_emitted IN (0, 1)),
				feedback TEXT NOT NULL DEFAULT 'unreviewed' CHECK (feedback IN ('unreviewed', 'accepted', 'rejected')),
				repeat_count INTEGER NOT NULL DEFAULT 1,
				created_at INTEGER NOT NULL,
				last_observed_at INTEGER NOT NULL,
				reviewed_at INTEGER,
				UNIQUE(profile_id, dedupe_key)
			);
			CREATE INDEX IF NOT EXISTS idx_initiative_observations_scope ON initiative_observations(profile_id, platform, chat_id, user_id, thread_id, created_at DESC);

			CREATE TABLE IF NOT EXISTS initiative_triggers (
				id TEXT PRIMARY KEY,
				profile_id TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('task_transition', 'enterprise_event')),
				trigger_id TEXT NOT NULL,
				occurred_at INTEGER NOT NULL,
				platform TEXT NOT NULL,
				channel_instance_id TEXT,
				chat_id TEXT NOT NULL,
				user_id TEXT,
				thread_id TEXT,
				prompt TEXT NOT NULL,
				evidence_ref TEXT NOT NULL,
				notification_required INTEGER NOT NULL CHECK (notification_required IN (0, 1)),
				delivery_target TEXT,
				execution_scope TEXT,
				status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'awaiting_route', 'notification_queued')),
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER NOT NULL,
				claim_token TEXT,
				claim_holder TEXT,
				claim_expires_at INTEGER,
				observation_id TEXT,
				decision TEXT CHECK (decision IN ('observed', 'ignored')),
				last_error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(profile_id, kind, trigger_id)
			);
			CREATE INDEX IF NOT EXISTS idx_initiative_triggers_due ON initiative_triggers(profile_id, status, next_attempt_at, claim_expires_at);

			CREATE TABLE IF NOT EXISTS proactive_mutation_controls (
				profile_id TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('running', 'stopped')),
				revision INTEGER NOT NULL,
				changed_at INTEGER NOT NULL,
				publisher_id TEXT NOT NULL,
				evidence_ref TEXT NOT NULL,
				PRIMARY KEY (profile_id, scope_id)
			);

			CREATE TABLE IF NOT EXISTS compensation_exercises (
				id TEXT NOT NULL,
				profile_id TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				forward_capability TEXT NOT NULL,
				compensation_capability TEXT NOT NULL,
				receipt_proof_provider TEXT,
				exercised_at INTEGER NOT NULL,
				valid_until INTEGER NOT NULL,
				evidence_refs TEXT NOT NULL,
				publisher_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(profile_id, id),
				UNIQUE(profile_id, scope_id, forward_capability, id)
			);
			CREATE INDEX IF NOT EXISTS idx_compensation_exercises_active ON compensation_exercises(profile_id, scope_id, forward_capability, exercised_at DESC, valid_until);

			CREATE TABLE IF NOT EXISTS autonomy_rollout_states (
				profile_id TEXT NOT NULL,
				level TEXT NOT NULL CHECK (level IN ('situation_context', 'episode_publication', 'initiative_observation', 'read_only_investigation', 'reversible_action')),
				status TEXT NOT NULL CHECK (status IN ('disabled', 'enabled', 'stopped')),
				revision INTEGER NOT NULL CHECK (revision > 0),
				updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
				actor TEXT NOT NULL CHECK (actor IN ('operator', 'enterprise')),
				publisher TEXT,
				evidence_ref TEXT NOT NULL,
				enterprise_disposition TEXT CHECK (enterprise_disposition IN ('allow', 'deny')),
				reasons TEXT NOT NULL,
				evidence TEXT,
				PRIMARY KEY (profile_id, level)
			);
		`);
		this.migrateCompensationExerciseIdentity();
		this.addColumnIfMissing("tasks", "evidence", "TEXT");
		this.addColumnIfMissing("memory_evidence", "source_ref", "TEXT");
		this.addColumnIfMissing("tasks", "description", "TEXT");
		this.addColumnIfMissing("tasks", "acceptance_criteria", "TEXT");
		this.addColumnIfMissing("tasks", "recovery_policy", "TEXT NOT NULL DEFAULT 'never'");
		this.addColumnIfMissing("tasks", "idempotency_key", "TEXT");
		this.addColumnIfMissing("tasks", "execution_scope", "TEXT");
		this.addColumnIfMissing("initiative_triggers", "execution_scope", "TEXT");
		this.addColumnIfMissing("initiative_triggers", "channel_instance_id", "TEXT");
		this.addColumnIfMissing("initiative_observations", "channel_instance_id", "TEXT");
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_initiative_observations_route_scope ON initiative_observations(profile_id, platform, channel_instance_id, chat_id, user_id, thread_id, created_at DESC)");
		this.addColumnIfMissing("autonomy_rollout_states", "publisher", "TEXT");
		this.addColumnIfMissing("tasks", "situation", "TEXT");
		this.addColumnIfMissing("tasks", "access_scope_ref", "TEXT");
		this.addColumnIfMissing("tasks", "business_context", "TEXT");
		this.addColumnIfMissing("tasks", "artifacts", "TEXT");
		this.addColumnIfMissing("tasks", "unresolved_issues", "TEXT");
		this.addColumnIfMissing("tasks", "plan_id", "TEXT");
		this.addColumnIfMissing("tasks", "verification_status", "TEXT");
		this.addColumnIfMissing("tasks", "verification_outcome", "TEXT");
		this.addColumnIfMissing("tasks", "verification_feedback", "TEXT");
		this.addColumnIfMissing("tasks", "verification_requirements", "TEXT");
		this.addColumnIfMissing("tasks", "criterion_verifications", "TEXT");
		this.addColumnIfMissing("tasks", "verification_attempts", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("tasks", "verification_retry_at", "INTEGER");
		this.addColumnIfMissing("tasks", "candidate_result", "TEXT");
		this.addColumnIfMissing("tasks", "corrective_attempts", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("tasks", "updated_at", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("tasks", "checkpoint", "TEXT");
		this.addColumnIfMissing("tasks", "checkpoint_at", "INTEGER");
		this.addColumnIfMissing("tasks", "effect_receipts", "TEXT");
		this.addColumnIfMissing("tasks", "routes", "TEXT");
		this.addColumnIfMissing("tasks", "route_index", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("task_plans", "paused_at", "INTEGER");
		this.addColumnIfMissing("task_runs", "lease_expires_at", "INTEGER");
		this.addColumnIfMissing("task_plan_completion_notices", "claim_token", "TEXT");
		this.addColumnIfMissing("task_plan_completion_notices", "channel_instance_id", "TEXT");
		this.addColumnIfMissing("task_plan_completion_notices", "chat_type", "TEXT");
		this.addColumnIfMissing("task_plan_completion_notices", "abandoned_at", "INTEGER");
		this.addColumnIfMissing("task_plan_completion_notices", "last_error", "TEXT");
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_verification_due ON tasks(verification_outcome, verification_retry_at)");
		this.backfillTaskPlans();
		this.addColumnIfMissing("memory_claims", "superseded_by", "TEXT REFERENCES memory_claims(id)");
		this.addColumnIfMissing("memories", "thread_id", "TEXT");
		this.addColumnIfMissing("memory_candidates", "thread_id", "TEXT");
		this.addColumnIfMissing("memory_candidates", "subject_type", "TEXT");
		this.addColumnIfMissing("memory_candidates", "subject_id", "TEXT");
		this.addColumnIfMissing("memory_candidates", "object_type", "TEXT");
		this.addColumnIfMissing("memory_candidates", "object_id", "TEXT");
		this.addColumnIfMissing("memory_events", "thread_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "thread_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "profile_id", "TEXT NOT NULL DEFAULT 'default'");
		this.addColumnIfMissing("memory_claims", "project_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "organization_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "subject_type", "TEXT");
		this.addColumnIfMissing("memory_claims", "subject_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "object_type", "TEXT");
		this.addColumnIfMissing("memory_claims", "object_id", "TEXT");
		this.addColumnIfMissing("memory_claims", "source_type", "TEXT");
		this.addColumnIfMissing("memory_claims", "source_ref", "TEXT");
		this.addColumnIfMissing("memory_claims", "visibility", "TEXT NOT NULL DEFAULT 'private'");
		this.addColumnIfMissing("memory_claims", "valid_from", "INTEGER");
		this.addColumnIfMissing("memory_claims", "valid_until", "INTEGER");
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_memories_exact_scope ON memories(platform, chat_id, user_id, thread_id, created_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_candidates_exact_scope ON memory_candidates(platform, chat_id, user_id, thread_id, status, created_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_candidates_business_scope ON memory_candidates(subject_type, subject_id, object_type, object_id, status, created_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_events_exact_scope ON memory_events(platform, chat_id, user_id, thread_id, occurred_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_claims_exact_scope ON memory_claims(profile_id, platform, chat_id, user_id, thread_id, status, valid_from, valid_until, updated_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_claims_object ON memory_claims(object_type, object_id, status, updated_at DESC);
			CREATE INDEX IF NOT EXISTS idx_memory_claims_business_scope ON memory_claims(profile_id, organization_id, project_id, visibility, status, updated_at DESC);
		`);
		this.addColumnIfMissing("memory_evidence", "event_id", "TEXT REFERENCES memory_events(id)");
		this.db.exec("CREATE TABLE IF NOT EXISTS memory_store_identity (id INTEGER PRIMARY KEY CHECK (id = 1), profile_id TEXT NOT NULL)");
		this.db.prepare("INSERT OR IGNORE INTO memory_store_identity (id, profile_id) VALUES (1, ?)").run(this.profileId);
		const identity = this.db.prepare("SELECT profile_id FROM memory_store_identity WHERE id = 1").get() as { profile_id: string };
		if (identity.profile_id === "default" && this.profileId !== "default") {
			this.db.prepare("UPDATE memory_store_identity SET profile_id = ? WHERE id = 1 AND profile_id = 'default'").run(this.profileId);
			identity.profile_id = this.profileId;
		}
		if (identity.profile_id !== this.profileId) {
			this.db.close();
			throw new Error(`Memory database belongs to Profile '${identity.profile_id}', not '${this.profileId}'`);
		}
		this.db.prepare("UPDATE memory_claims SET profile_id = ? WHERE profile_id = 'default'").run(this.profileId);
		this.db.exec("UPDATE tasks SET verification_outcome = verification_status WHERE verification_outcome IS NULL AND verification_status IS NOT NULL");
		this.db.exec(`INSERT OR IGNORE INTO tasks (id, owner_key, kind, title, status, evidence, created_at, finished_at, updated_at)
			SELECT id, 'profile', 'objective', title,
				CASE status WHEN 'open' THEN 'pending' WHEN 'in_progress' THEN 'running' WHEN 'done' THEN 'succeeded' ELSE 'cancelled' END,
				evidence, updated_at, completed_at, updated_at FROM task_ledger`);
	}

	private addColumnIfMissing(table: string, column: string, definition: string): void {
		const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
		if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}

	private migrateCompensationExerciseIdentity(): void {
		const columns = this.db.prepare("PRAGMA table_info(compensation_exercises)").all() as Array<{ name: string; pk: number }>;
		const id = columns.find((column) => column.name === "id");
		const profile = columns.find((column) => column.name === "profile_id");
		if (id?.pk !== 1 || profile?.pk === 2) return;
		this.db.transaction(() => this.db.exec(`
			ALTER TABLE compensation_exercises RENAME TO compensation_exercises_legacy_identity;
			CREATE TABLE compensation_exercises (
				id TEXT NOT NULL,
				profile_id TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				forward_capability TEXT NOT NULL,
				compensation_capability TEXT NOT NULL,
				receipt_proof_provider TEXT,
				exercised_at INTEGER NOT NULL,
				valid_until INTEGER NOT NULL,
				evidence_refs TEXT NOT NULL,
				publisher_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(profile_id, id),
				UNIQUE(profile_id, scope_id, forward_capability, id)
			);
			INSERT INTO compensation_exercises SELECT * FROM compensation_exercises_legacy_identity;
			DROP TABLE compensation_exercises_legacy_identity;
			CREATE INDEX idx_compensation_exercises_active ON compensation_exercises(profile_id, scope_id, forward_capability, exercised_at DESC, valid_until);
		`))();
	}

	/** Persist a source record as immutable evidence while retained; unreferenced raw events use a bounded per-conversation retention window. */
	recordEvent(record: { platform: string; chatId: string; userId?: string; threadId?: string; kind: "user" | "assistant" | "import" | "feedback"; content: string; occurredAt?: number }): string {
		const id = cryptoRandom();
		const now = Date.now();
		this.db.prepare("INSERT INTO memory_events (id, platform, chat_id, user_id, thread_id, kind, content, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(id, record.platform, record.chatId, record.userId ?? null, record.threadId ?? null, record.kind, record.content, record.occurredAt ?? now, now);
		this.db.prepare(`DELETE FROM memory_events WHERE platform = ? AND chat_id = ? AND user_id IS ? AND id NOT IN (SELECT event_id FROM memory_evidence WHERE event_id IS NOT NULL) AND id NOT IN
			(SELECT id FROM memory_events WHERE platform = ? AND chat_id = ? AND user_id IS ? ORDER BY occurred_at DESC LIMIT 5000)`)
			.run(record.platform, record.chatId, record.userId ?? null, record.platform, record.chatId, record.userId ?? null);
		return id;
	}

	latestEvent(opts: Omit<RecallOptions, "limit">, kind: MemoryEvent["kind"] = "user"): MemoryEvent | undefined {
		const { where, params } = scopeWhere(opts, "e");
		const row = this.db.prepare(`SELECT * FROM memory_events e WHERE e.kind = ? ${where} ORDER BY e.occurred_at DESC LIMIT 1`).get(kind, ...params) as EventRow | undefined;
		return row ? mapEvent(row) : undefined;
	}

	/** Store or reinforce a named understanding with optional provenance. */
	upsertClaim(input: ClaimInput): MemoryClaim {
		if ((input.profileId ?? this.profileId) !== this.profileId) throw new Error("Memory claim is outside this Profile store");
		const statement = input.statement.trim();
		if (!statement) throw new Error("Memory claim statement cannot be empty");
		const now = Date.now();
		const scope = [input.profileId ?? this.profileId, input.platform, input.chatId, input.userId ?? null, input.threadId ?? null, input.kind, statement,
			input.subject?.type ?? null, input.subject?.id ?? null, input.object?.type ?? null, input.object?.id ?? null,
			input.projectId ?? null, input.organizationId ?? null, input.visibility ?? "private"];
		const existing = this.db.prepare(`SELECT * FROM memory_claims
			WHERE profile_id = ? AND platform = ? AND chat_id = ? AND user_id IS ? AND thread_id IS ? AND kind = ? AND statement = ?
			AND subject_type IS ? AND subject_id IS ? AND object_type IS ? AND object_id IS ? AND status = 'active'
			AND project_id IS ? AND organization_id IS ? AND visibility = ?
			ORDER BY updated_at DESC LIMIT 1`).get(...scope) as ClaimRow | undefined;
		let id: string;
		if (existing) {
			id = existing.id;
			this.db.prepare(`UPDATE memory_claims SET confidence = MAX(confidence, ?), stability = ?, last_confirmed_at = ?,
				source_type = COALESCE(?, source_type), source_ref = COALESCE(?, source_ref), visibility = COALESCE(?, visibility),
				valid_from = COALESCE(?, valid_from), valid_until = COALESCE(?, valid_until), expires_at = COALESCE(?, expires_at), updated_at = ? WHERE id = ?`)
				.run(clampConfidence(input.confidence ?? existing.confidence), strongerStability(existing.stability, input.stability ?? "low"), now,
					input.source?.type ?? null, input.source?.ref ?? null, input.visibility ?? null, input.validFrom ?? null,
					input.validUntil ?? input.expiresAt ?? null, input.validUntil ?? input.expiresAt ?? null, now, id);
		} else {
			id = cryptoRandom();
			this.db.prepare(`INSERT INTO memory_claims (id, profile_id, platform, chat_id, user_id, thread_id, project_id, organization_id, kind, statement, subject_type, subject_id, object_type, object_id, source_type, source_ref, visibility, valid_from, valid_until, confidence, stability, status, first_observed_at, last_confirmed_at, expires_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
				.run(id, input.profileId ?? this.profileId, input.platform, input.chatId, input.userId ?? null, input.threadId ?? null, input.projectId ?? null, input.organizationId ?? null, input.kind, statement,
					input.subject?.type ?? null, input.subject?.id ?? null, input.object?.type ?? null, input.object?.id ?? null,
					input.source?.type ?? null, input.source?.ref ?? null, input.visibility ?? "private", input.validFrom ?? null,
					input.validUntil ?? input.expiresAt ?? null, clampConfidence(input.confidence ?? 0.7), input.stability ?? "low", now, now,
					input.validUntil ?? input.expiresAt ?? null, now, now);
		}
		if (input.evidence?.eventId && !this.eventMatchesScope(input.evidence.eventId, input)) throw new Error("Memory evidence event is outside this memory scope");
		if (input.evidence?.excerpt.trim()) this.addEvidence(id, input.evidence.kind ?? "manual", input.evidence.excerpt, input.evidence.eventId, input.evidence.sourceRef);
		return this.getClaim(id, input)!;
	}

	recordException(input: Omit<ClaimInput, "kind"> & { source: NonNullable<ClaimInput["source"]>; evidence: NonNullable<ClaimInput["evidence"]> }): MemoryClaim {
		if (!input.evidence.excerpt.trim()) throw new Error("Organization Memory exception requires evidence");
		return this.upsertClaim({ ...input, kind: "exception", confidence: input.confidence ?? 1, stability: input.stability ?? "medium" });
	}

	/** Persist one Situation → Action → Outcome account in the existing Memory authority. */
	upsertEpisode(input: OrganizationMemoryEpisodeInput): OrganizationMemoryEpisode {
		const profileId = input.profileId ?? this.profileId;
		if (profileId !== this.profileId) throw new Error("Organization Memory Episode is outside this Profile store");
		const objectiveId = boundedEpisodeText(input.objectiveId, "objectiveId", 512);
		const action = boundedEpisodeText(input.action, "action", 5_000);
		const outcome = boundedEpisodeText(input.outcome, "outcome", 50_000);
		const evidence = input.evidence === undefined ? undefined : boundedEpisodeText(input.evidence, "evidence", 5_000);
		const situation = createSituation(structuredClone(input.situation));
		const status = input.status ?? "verified";
		if (!EPISODE_STATUSES.has(status)) throw new Error("Organization Memory Episode status is invalid");
		const sensitive = JSON.stringify({ objectiveId, situation, action, outcome, evidence });
		if (containsCredentialMaterial(sensitive)) throw new Error("Organization Memory Episode cannot contain credential material");
		const now = Date.now();
		const id = `episode:${cryptoRandom()}`;
		this.db.prepare(`INSERT INTO memory_episodes (id, profile_id, platform, chat_id, user_id, thread_id, objective_id, situation, situation_summary, action, outcome, evidence, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(profile_id, objective_id) DO UPDATE SET
				situation = excluded.situation, situation_summary = excluded.situation_summary, action = excluded.action,
				outcome = excluded.outcome, evidence = excluded.evidence,
				status = CASE WHEN memory_episodes.status = 'verified' AND excluded.status = 'candidate' THEN memory_episodes.status ELSE excluded.status END,
				updated_at = excluded.updated_at`)
			.run(id, profileId, input.platform, input.chatId, input.userId ?? null, input.threadId ?? null, objectiveId, JSON.stringify(situation), situation.summary, action, outcome, evidence ?? null, status, now, now);
		const persisted = this.episodeForObjective(objectiveId, { profileId });
		if (!persisted) throw new Error("Organization Memory Episode could not be persisted");
		return persisted;
	}

	episodeForObjective(objectiveId: string, opts: Omit<RecallOptions, "limit"> = {}): OrganizationMemoryEpisode | undefined {
		const scope = episodeScopeWhere({ ...opts, profileId: opts.profileId ?? this.profileId }, "e");
		const row = this.db.prepare(`SELECT * FROM memory_episodes e WHERE e.objective_id = ? ${scope.where}`).get(objectiveId, ...scope.params) as EpisodeRow | undefined;
		return row ? mapEpisode(row) : undefined;
	}

	listEpisodes(opts: RecallOptions & { statuses?: OrganizationMemoryEpisodeStatus[] } = {}): OrganizationMemoryEpisode[] {
		const statuses = validEpisodeStatuses(opts.statuses ?? ["verified", "conflicted"]);
		const scope = episodeScopeWhere({ ...opts, profileId: opts.profileId ?? this.profileId }, "e");
		const rows = this.db.prepare(`SELECT * FROM memory_episodes e WHERE e.status IN (${statuses.map(() => "?").join(",")}) ${scope.where} ORDER BY e.updated_at DESC LIMIT ?`)
			.all(...statuses, ...scope.params, limitOf(opts.limit, 50)) as EpisodeRow[];
		return rows.map(mapEpisode);
	}

	recallEpisodes(query: string, opts: RecallOptions & { statuses?: OrganizationMemoryEpisodeStatus[] } = {}): OrganizationMemoryEpisode[] {
		const match = toFtsQuery(query);
		if (!match) return [];
		const statuses = validEpisodeStatuses(opts.statuses ?? ["verified", "conflicted"]);
		const scope = episodeScopeWhere({ ...opts, profileId: opts.profileId ?? this.profileId }, "e");
		let rows = this.db.prepare(`SELECT e.* FROM memory_episodes_fts f JOIN memory_episodes e ON e.rowid = f.rowid
			WHERE memory_episodes_fts MATCH ? AND e.status IN (${statuses.map(() => "?").join(",")}) ${scope.where}
			ORDER BY rank, e.updated_at DESC LIMIT ?`).all(match, ...statuses, ...scope.params, limitOf(opts.limit, 5)) as EpisodeRow[];
		if (!rows.length) {
			const lexical = lexicalWhere(query, "e.situation_summary || ' ' || e.action || ' ' || e.outcome");
			if (lexical) rows = this.db.prepare(`SELECT e.* FROM memory_episodes e WHERE ${lexical.where} AND e.status IN (${statuses.map(() => "?").join(",")}) ${scope.where} ORDER BY e.updated_at DESC LIMIT ?`)
				.all(...lexical.params, ...statuses, ...scope.params, limitOf(opts.limit, 5)) as EpisodeRow[];
		}
		return rows.map(mapEpisode);
	}

	/** Persist a reviewable pattern derived from repeated Episodes; never creates Policy authority. */
	upsertConventionCandidate(input: ConventionCandidateInput): ConventionCandidate {
		const profileId = input.profileId ?? this.profileId;
		if (profileId !== this.profileId) throw new Error("Convention Candidate is outside this Profile store");
		const platform = boundedEpisodeText(input.platform ?? "", "platform", 100);
		const chatId = boundedEpisodeText(input.chatId ?? "", "chatId", 500);
		const statement = boundedEpisodeText(input.statement, "statement", 5_000);
		const rationale = boundedEpisodeText(input.rationale, "rationale", 5_000);
		if (containsCredentialMaterial(`${statement}\n${rationale}`)) throw new Error("Convention Candidate cannot contain credential material");
		const supportingIds = [...new Set(input.supportingEpisodeIds)];
		const contradictoryIds = [...new Set(input.contradictoryEpisodeIds ?? [])];
		const exceptionIds = [...new Set(input.exceptionClaimIds ?? [])];
		if (supportingIds.length < 2) throw new Error("Convention Candidate requires at least two supporting Episodes");
		if (supportingIds.some((id) => contradictoryIds.includes(id))) throw new Error("One Episode cannot both support and contradict a Convention Candidate");
		const episodeIds = [...supportingIds, ...contradictoryIds];
		const placeholders = episodeIds.map(() => "?").join(",");
		const episodes = this.db.prepare(`SELECT * FROM memory_episodes WHERE id IN (${placeholders})`).all(...episodeIds) as EpisodeRow[];
		if (episodes.length !== episodeIds.length || episodes.some((row) => !sameEpisodeInputScope(row, { ...input, profileId, platform, chatId }))) throw new Error("Convention Episode evidence is outside this memory scope");
		const byId = new Map(episodes.map((row) => [row.id, row]));
		if (supportingIds.some((id) => byId.get(id)?.status !== "verified")) throw new Error("Convention support requires verified Episodes");
		for (const id of exceptionIds) {
			const claim = this.getClaim(id, { ...input, profileId, platform, chatId });
			if (!claim || claim.kind !== "exception" || (claim.status !== "active" && claim.status !== "conflicted")) throw new Error("Convention exception is outside this memory scope or is not effective");
		}
		const observed = episodes.map((row) => row.created_at);
		const promotionBlocked = contradictoryIds.length > 0;
		const confidence = clampConfidence(input.confidence) * supportingIds.length / (supportingIds.length + contradictoryIds.length);
		const scopeKey = JSON.stringify([platform, chatId, input.userId ?? null, input.threadId ?? null]);
		const canonical = statement.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
		const now = Date.now();
		const proposedId = `convention:${cryptoRandom()}`;
		this.db.transaction(() => {
			this.db.prepare(`INSERT INTO memory_convention_candidates (id, profile_id, platform, chat_id, user_id, thread_id, scope_key, canonical_statement, statement, rationale, confidence, promotion_blocked, observed_from, observed_until, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
				ON CONFLICT(profile_id, scope_key, canonical_statement) DO UPDATE SET
					rationale = excluded.rationale, confidence = excluded.confidence, promotion_blocked = excluded.promotion_blocked,
					observed_from = MIN(memory_convention_candidates.observed_from, excluded.observed_from), observed_until = MAX(memory_convention_candidates.observed_until, excluded.observed_until), updated_at = excluded.updated_at`)
				.run(proposedId, profileId, platform, chatId, input.userId ?? null, input.threadId ?? null, scopeKey, canonical, statement, rationale,
					confidence, promotionBlocked ? 1 : 0, Math.min(...observed), Math.max(...observed), now, now);
			const row = this.db.prepare("SELECT id FROM memory_convention_candidates WHERE profile_id = ? AND scope_key = ? AND canonical_statement = ?").get(profileId, scopeKey, canonical) as { id: string };
			if (promotionBlocked) {
				const rolledBack = this.db.prepare("UPDATE memory_convention_candidates SET status = 'rolled_back', updated_at = ? WHERE id = ? AND status = 'confirmed'").run(now, row.id).changes;
				if (rolledBack) this.db.prepare("INSERT INTO memory_convention_events (id, candidate_id, kind, excerpt, source_ref, created_at) VALUES (?, ?, 'rollback', ?, ?, ?)")
					.run(cryptoRandom(), row.id, "New contradictory Episode evidence invalidated the confirmed convention", contradictoryIds.join(",").slice(0, 1_000), now);
			}
			this.db.prepare("DELETE FROM memory_convention_episode_evidence WHERE candidate_id = ?").run(row.id);
			this.db.prepare("DELETE FROM memory_convention_exceptions WHERE candidate_id = ?").run(row.id);
			const addEpisode = this.db.prepare("INSERT INTO memory_convention_episode_evidence (candidate_id, episode_id, relation) VALUES (?, ?, ?)");
			for (const id of supportingIds) addEpisode.run(row.id, id, "support");
			for (const id of contradictoryIds) addEpisode.run(row.id, id, "contradiction");
			const workflows = this.db.prepare("SELECT candidate_id FROM memory_workflow_conventions WHERE convention_id = ?").all(row.id) as Array<{ candidate_id: string }>;
			const attachWorkflowEpisode = this.db.prepare("INSERT OR IGNORE INTO memory_workflow_episode_evidence (candidate_id, episode_id, relation) VALUES (?, ?, ?)");
			for (const workflow of workflows) {
				for (const id of supportingIds) attachWorkflowEpisode.run(workflow.candidate_id, id, "support");
				for (const id of contradictoryIds) attachWorkflowEpisode.run(workflow.candidate_id, id, "contradiction");
			}
			const addException = this.db.prepare("INSERT INTO memory_convention_exceptions (candidate_id, claim_id) VALUES (?, ?)");
			for (const id of exceptionIds) addException.run(row.id, id);
		})();
		const persisted = this.getConventionCandidateByCanonical(profileId, scopeKey, canonical);
		if (!persisted) throw new Error("Convention Candidate could not be persisted");
		return persisted;
	}

	getConventionCandidate(id: string, opts: Omit<RecallOptions, "limit">): ConventionCandidate | undefined {
		const access = conventionScopeWhere(opts, "c");
		const row = this.db.prepare(`SELECT * FROM memory_convention_candidates c WHERE c.id = ? ${access.where}`).get(id, ...access.params) as ConventionCandidateRow | undefined;
		return row ? this.hydrateConventionCandidate(row) : undefined;
	}

	listConventionCandidates(opts: Omit<RecallOptions, "includeCandidates"> & { status?: ConventionCandidateStatus; limit?: number }): ConventionCandidate[] {
		const access = conventionScopeWhere(opts, "c");
		const status = opts.status ?? "candidate";
		const rows = this.db.prepare(`SELECT * FROM memory_convention_candidates c WHERE c.status = ? ${access.where} ORDER BY c.updated_at DESC LIMIT ?`)
			.all(status, ...access.params, limitOf(opts.limit, 50)) as ConventionCandidateRow[];
		return rows.map((row) => this.hydrateConventionCandidate(row));
	}

	confirmConventionCandidate(id: string, opts: Omit<RecallOptions, "limit">, evidence: ConventionTransitionEvidence): boolean {
		const candidate = this.getConventionCandidate(id, opts);
		if (!candidate || candidate.status !== "candidate" || candidate.promotionBlocked) return false;
		return this.transitionConventionCandidate(id, "candidate", "confirmed", evidence, undefined, true);
	}

	rejectConventionCandidate(id: string, opts: Omit<RecallOptions, "limit">, evidence: ConventionTransitionEvidence): boolean {
		const candidate = this.getConventionCandidate(id, opts);
		return Boolean(candidate?.status === "candidate" && this.transitionConventionCandidate(id, "candidate", "rejected", evidence));
	}

	supersedeConventionCandidate(id: string, replacementId: string, opts: Omit<RecallOptions, "limit">, evidence: ConventionTransitionEvidence): boolean {
		if (id === replacementId) return false;
		const current = this.getConventionCandidate(id, opts);
		const replacement = this.getConventionCandidate(replacementId, opts);
		if (!current || current.status !== "confirmed" || !replacement || replacement.status !== "candidate") return false;
		return this.transitionConventionCandidate(id, "confirmed", "superseded", evidence, replacementId);
	}

	rollbackConventionCandidate(id: string, opts: Omit<RecallOptions, "limit">, evidence: ConventionTransitionEvidence): boolean {
		const candidate = this.getConventionCandidate(id, opts);
		return Boolean(candidate?.status === "confirmed" && this.transitionConventionCandidate(id, "confirmed", "rolled_back", evidence));
	}

	explainConventionCandidate(id: string, opts: Omit<RecallOptions, "limit">): { candidate: ConventionCandidate; events: ConventionCandidateEvent[] } | undefined {
		const candidate = this.getConventionCandidate(id, opts);
		if (!candidate) return undefined;
		const rows = this.db.prepare("SELECT * FROM memory_convention_events WHERE candidate_id = ? ORDER BY created_at DESC").all(id) as ConventionCandidateEventRow[];
		return { candidate, events: rows.map(mapConventionEvent) };
	}

	/** Persist a reviewable instruction draft. It has no execution or Policy authority. */
	upsertWorkflowCandidate(input: WorkflowCandidateInput): WorkflowCandidate {
		const profileId = input.profileId ?? this.profileId;
		if (profileId !== this.profileId) throw new Error("Workflow Candidate is outside this Profile store");
		const platform = boundedEpisodeText(input.platform ?? "", "platform", 100);
		const chatId = boundedEpisodeText(input.chatId ?? "", "chatId", 500);
		const content = normalizeWorkflowContent(input);
		if (containsCredentialMaterial(JSON.stringify(content))) throw new Error("Workflow Candidate cannot contain credential material or Secrets");
		const conventionIds = [...new Set(input.sourceConventionIds.map((id) => boundedEpisodeText(id, "Convention id", 500)))];
		if (!conventionIds.length || conventionIds.length > 20) throw new Error("Workflow Candidate requires between 1 and 20 confirmed Conventions");
		const conventions = conventionIds.map((id) => this.getConventionCandidate(id, { ...input, profileId, platform, chatId }));
		if (conventions.some((candidate) => !candidate || candidate.status !== "confirmed")) throw new Error("Workflow Candidate sources must be confirmed Conventions in the same scope");
		const supportingIds = [...new Set(conventions.flatMap((candidate) => candidate!.supportingEpisodeIds))];
		const contradictoryIds = [...new Set(conventions.flatMap((candidate) => candidate!.contradictoryEpisodeIds))];
		const scopeKey = JSON.stringify([platform, chatId, input.userId ?? null, input.threadId ?? null]);
		const canonical = content.title.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
		const proposedId = `workflow:${cryptoRandom()}`;
		const now = Date.now();
		this.db.transaction(() => {
			this.db.prepare(`INSERT OR IGNORE INTO memory_workflow_candidates
				(id, profile_id, platform, chat_id, user_id, thread_id, scope_key, canonical_title, title, summary, conditions, exceptions, inputs, instructions, expected_outcomes, verification, status, revision, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?, ?)`)
				.run(proposedId, profileId, platform, chatId, input.userId ?? null, input.threadId ?? null, scopeKey, canonical, content.title, content.summary,
					JSON.stringify(content.conditions), JSON.stringify(content.exceptions), JSON.stringify(content.inputs), JSON.stringify(content.instructions), JSON.stringify(content.expectedOutcomes), JSON.stringify(content.verification), now, now);
			const row = this.db.prepare("SELECT id FROM memory_workflow_candidates WHERE profile_id = ? AND scope_key = ? AND canonical_title = ?").get(profileId, scopeKey, canonical) as { id: string };
			const addConvention = this.db.prepare("INSERT OR IGNORE INTO memory_workflow_conventions (candidate_id, convention_id) VALUES (?, ?)");
			for (const id of conventionIds) addConvention.run(row.id, id);
			const addEpisode = this.db.prepare("INSERT OR IGNORE INTO memory_workflow_episode_evidence (candidate_id, episode_id, relation) VALUES (?, ?, ?)");
			for (const id of supportingIds) addEpisode.run(row.id, id, "support");
			for (const id of contradictoryIds) addEpisode.run(row.id, id, "contradiction");
		})();
		const row = this.db.prepare("SELECT * FROM memory_workflow_candidates WHERE profile_id = ? AND scope_key = ? AND canonical_title = ?").get(profileId, scopeKey, canonical) as WorkflowCandidateRow;
		return this.hydrateWorkflowCandidate(row);
	}

	getWorkflowCandidate(id: string, opts: Omit<RecallOptions, "limit">): WorkflowCandidate | undefined {
		const access = conventionScopeWhere(opts, "w");
		const row = this.db.prepare(`SELECT * FROM memory_workflow_candidates w WHERE w.id = ? ${access.where}`).get(id, ...access.params) as WorkflowCandidateRow | undefined;
		return row ? this.hydrateWorkflowCandidate(row) : undefined;
	}

	listWorkflowCandidates(opts: Omit<RecallOptions, "includeCandidates"> & { status?: WorkflowCandidateStatus; limit?: number }): WorkflowCandidate[] {
		const access = conventionScopeWhere(opts, "w");
		const status = opts.status ?? "candidate";
		const rows = this.db.prepare(`SELECT * FROM memory_workflow_candidates w WHERE w.status = ? ${access.where} ORDER BY w.updated_at DESC LIMIT ?`).all(status, ...access.params, limitOf(opts.limit, 50)) as WorkflowCandidateRow[];
		return rows.map((row) => this.hydrateWorkflowCandidate(row));
	}

	editWorkflowCandidate(id: string, opts: Omit<RecallOptions, "limit">, edit: WorkflowCandidateEdit, evidence: WorkflowTransitionEvidence): boolean {
		const current = this.getWorkflowCandidate(id, opts);
		if (!current || current.status !== "candidate") return false;
		const content = normalizeWorkflowContent({ ...current, ...edit });
		if (containsCredentialMaterial(JSON.stringify(content))) throw new Error("Workflow Candidate cannot contain credential material or Secrets");
		return this.db.transaction(() => {
			const changed = this.db.prepare(`UPDATE memory_workflow_candidates SET title = ?, summary = ?, conditions = ?, exceptions = ?, inputs = ?, instructions = ?, expected_outcomes = ?, verification = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'candidate'`)
				.run(content.title, content.summary, JSON.stringify(content.conditions), JSON.stringify(content.exceptions), JSON.stringify(content.inputs), JSON.stringify(content.instructions), JSON.stringify(content.expectedOutcomes), JSON.stringify(content.verification), Date.now(), id).changes;
			if (!changed) return false;
			this.recordWorkflowEvent(id, "edited", evidence);
			return true;
		})();
	}

	rejectWorkflowCandidate(id: string, opts: Omit<RecallOptions, "limit">, evidence: WorkflowTransitionEvidence): boolean { return this.transitionWorkflowCandidate(id, opts, "rejected", evidence); }
	archiveWorkflowCandidate(id: string, opts: Omit<RecallOptions, "limit">, evidence: WorkflowTransitionEvidence): boolean { return this.transitionWorkflowCandidate(id, opts, "archived", evidence); }

	supersedeWorkflowCandidate(id: string, replacementId: string, opts: Omit<RecallOptions, "limit">, evidence: WorkflowTransitionEvidence): boolean {
		if (id === replacementId) return false;
		const current = this.getWorkflowCandidate(id, opts);
		const replacement = this.getWorkflowCandidate(replacementId, opts);
		if (!current || current.status !== "candidate" || !replacement || replacement.status !== "candidate") return false;
		return this.db.transaction(() => {
			const changed = this.db.prepare("UPDATE memory_workflow_candidates SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'candidate'").run(replacementId, Date.now(), id).changes;
			if (!changed) return false;
			this.recordWorkflowEvent(id, "superseded", evidence);
			return true;
		})();
	}

	explainWorkflowCandidate(id: string, opts: Omit<RecallOptions, "limit">): { candidate: WorkflowCandidate; events: WorkflowCandidateEvent[] } | undefined {
		const candidate = this.getWorkflowCandidate(id, opts);
		if (!candidate) return undefined;
		const rows = this.db.prepare("SELECT * FROM memory_workflow_events WHERE candidate_id = ? ORDER BY created_at DESC").all(id) as WorkflowCandidateEventRow[];
		return { candidate, events: rows.map(mapWorkflowEvent) };
	}

	stageWorkflowSkillCandidate(id: string, opts: Omit<RecallOptions, "limit">, name: string): WorkflowSkillCandidateDraft {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error("Workflow Skill candidate name is invalid");
		const candidate = this.currentWorkflowForSkill(id, opts);
		const sections: Array<[string, string[]]> = [
			["Conditions", candidate.conditions], ["Exceptions", candidate.exceptions], ["Inputs", candidate.inputs],
			["Instructions", candidate.instructions.map((step, index) => `${index + 1}. ${step}`)], ["Expected outcomes", candidate.expectedOutcomes], ["Verification", candidate.verification],
		];
		const renderedSections = sections.filter(([, values]) => values.length).map(([title, values]) => `## ${title}\n\n${values.map((value) => `- ${value}`).join("\n")}`);
		const instructions = `${candidate.summary}\n\n${renderedSections.join("\n\n")}`;
		if (containsCredentialMaterial(instructions)) throw new Error("Workflow Skill candidate cannot contain credential material");
		return { name, description: candidate.summary.slice(0, 1_024), instructions, source: `workflow-candidate:${candidate.id}@${candidate.revision}` };
	}

	authorizeWorkflowSkillPromotion(source: string, opts: Omit<RecallOptions, "limit">, staged?: { name: string; sha256: string }): { allowed: boolean; evidenceRef?: string; reason?: string } {
		const match = /^workflow-candidate:(workflow:[^@]+)@(\d+)$/.exec(source);
		if (!match) return { allowed: false, reason: "Skill candidate has no valid Workflow provenance" };
		try {
			const candidate = this.currentWorkflowForSkill(match[1]!, opts);
			if (candidate.revision !== Number(match[2])) return { allowed: false, reason: "Workflow Candidate changed after Skill staging" };
			if (!staged) return { allowed: false, reason: "Workflow Skill promotion is missing its staged content identity" };
			const expected = this.stageWorkflowSkillCandidate(candidate.id, opts, staged.name);
			if (createHash("sha256").update(expected.instructions.trim()).digest("hex") !== staged.sha256) return { allowed: false, reason: "Workflow Skill instructions changed after staging" };
			return { allowed: true, evidenceRef: `workflow:${candidate.id}:revision:${candidate.revision}` };
		} catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : String(error) }; }
	}

	/** Bounded Situation-driven projection across the existing Organization Memory authorities. */
	recallOrganizationKnowledge(situation: Situation, opts: Omit<RecallOptions, "limit">, limit = 10): OrganizationKnowledgeRecall {
		const started = performance.now();
		const query = situationKnowledgeQuery(situation);
		const terms = multilingualLexicalTerms(query).slice(0, 40);
		const hits: OrganizationKnowledgeHit[] = [];
		const activeClaims = [...this.listClaims({ ...opts, status: "active", limit: 100 }), ...this.listClaims({ ...opts, status: "conflicted", limit: 100 })];
		const selectedClaims = activeClaims.flatMap((claim) => {
			const relevance = knowledgeRelevance(claim.statement, terms);
			if (relevance < 0.55) return [];
			const explanation = this.explainClaim(claim.id, opts);
			const evidenceQuality = Math.min(0.2, (explanation?.evidence.length ?? 0) * 0.04 + (claim.source ? 0.08 : 0));
			const kind: OrganizationKnowledgeHit["kind"] = claim.status === "conflicted" ? "conflict" : claim.kind === "exception" ? "exception" : "claim";
			const score = boundedKnowledgeScore(relevance * 0.55 + claim.confidence * 0.2 + evidenceQuality + recencyScore(claim.updatedAt) * 0.1 + (kind === "conflict" ? 0.25 : 0));
			const sourceRefs = explanation?.evidence.flatMap((item) => [item.sourceRef, item.eventId].filter((value): value is string => Boolean(value))) ?? [];
			return [{ id: claim.id, kind, content: claim.statement, status: claim.status, confidence: claim.confidence, score, reasons: ["situation-relevance", ...(evidenceQuality ? ["evidence-quality"] : []), ...(kind === "conflict" ? ["conflict-visible"] : [])], occurredAt: claim.updatedAt, ...(sourceRefs.length ? { sourceRefs: [...new Set(sourceRefs)] } : {}) } satisfies OrganizationKnowledgeHit];
		});
		hits.push(...selectedClaims);
		for (const current of selectedClaims.filter((hit) => hit.kind === "claim" || hit.kind === "exception")) {
			const access = claimReadWhere(opts, "c");
			const priorRows = this.db.prepare(`SELECT * FROM memory_claims c WHERE c.superseded_by = ? ${access.where} ORDER BY c.updated_at DESC LIMIT 5`).all(current.id, ...access.params) as ClaimRow[];
			for (const row of priorRows) {
				const prior = mapClaim(row);
				const explanation = this.explainClaim(prior.id, opts);
				hits.push({ id: prior.id, kind: "correction", content: `${prior.statement} → ${current.content}`, status: prior.status, confidence: prior.confidence, score: boundedKnowledgeScore(Math.max(0.82, current.score + 0.03)), reasons: ["correction-chain", "attached-to-current-claim"], occurredAt: prior.updatedAt, sourceRefs: [...new Set(explanation?.evidence.flatMap((item) => [item.sourceRef, item.eventId].filter((value): value is string => Boolean(value))) ?? [])] });
			}
		}
		for (const episode of this.listEpisodes({ ...opts, statuses: ["verified", "conflicted"], limit: 100 })) {
			const content = `${episode.situation.summary}\n${episode.action}\n${episode.outcome}`;
			const relevance = knowledgeRelevance(content, terms);
			if (relevance < 0.55) continue;
			const kind: OrganizationKnowledgeHit["kind"] = episode.status === "conflicted" ? "conflict" : "episode";
			hits.push({ id: episode.id, kind, content, status: episode.status, confidence: episode.situation.confidence, score: boundedKnowledgeScore(relevance * 0.55 + episode.situation.confidence * 0.15 + recencyScore(episode.updatedAt) * 0.1 + (kind === "conflict" ? 0.25 : 0.12)), reasons: ["situation-relevance", "precedent", ...(kind === "conflict" ? ["conflict-visible"] : [])], occurredAt: episode.updatedAt, ...(episode.evidence ? { sourceRefs: [episode.evidence] } : {}) });
		}
		for (const status of ["confirmed", "candidate", "rolled_back"] as const) {
			for (const convention of this.listConventionCandidates({ ...opts, status, limit: 100 })) {
				const relevance = knowledgeRelevance(`${convention.statement}\n${convention.rationale}`, terms);
				if (relevance < 0.55) continue;
				const kind: OrganizationKnowledgeHit["kind"] = convention.status === "rolled_back" ? "correction" : "convention";
				const stateWeight = convention.status === "confirmed" ? 0.2 : convention.status === "rolled_back" ? 0.12 : 0.05;
				hits.push({ id: convention.id, kind, content: convention.statement, status: convention.status, confidence: convention.confidence, score: boundedKnowledgeScore(relevance * 0.5 + convention.confidence * 0.15 + stateWeight + Math.min(0.1, convention.supportingEpisodeIds.length * 0.03) - (convention.promotionBlocked ? 0.2 : 0)), reasons: ["situation-relevance", "convention", `${convention.supportingEpisodeIds.length}-episode-precedent`, ...(convention.promotionBlocked ? ["promotion-blocked"] : [])], occurredAt: convention.updatedAt, sourceRefs: [...convention.supportingEpisodeIds, ...convention.contradictoryEpisodeIds, ...convention.exceptionClaimIds] });
			}
		}
		const boundedLimit = Math.max(1, Math.min(limit, 50));
		const ranked = [...new Map(hits.sort((left, right) => right.score - left.score || right.occurredAt - left.occurredAt).map((hit) => [`${hit.kind}:${hit.id}`, hit])).values()].slice(0, boundedLimit);
		return { hits: ranked, metrics: { elapsedMs: Math.max(0, performance.now() - started), considered: hits.length, returned: ranked.length, conflictsVisible: ranked.filter((hit) => hit.kind === "conflict").length, correctionsRetained: ranked.filter((hit) => hit.kind === "correction").length } };
	}

	/** Preserve contradictory facts and their provenance instead of silently choosing one. */
	markClaimsConflicted(firstId: string, secondId: string, opts: Omit<RecallOptions, "limit">, evidence: { excerpt: string; eventId?: string; sourceRef?: string } = { excerpt: `Conflict recorded between ${firstId} and ${secondId}` }): boolean {
		if (firstId === secondId) return false;
		const first = this.getClaim(firstId, opts);
		const second = this.getClaim(secondId, opts);
		if (!first || !second || first.status === "superseded" || second.status === "superseded") return false;
		if (!sameClaimScope(first, second)) return false;
		if (!evidence.excerpt.trim()) throw new Error("Organization Memory conflict requires evidence");
		if (evidence.eventId && (!this.eventMatchesScope(evidence.eventId, first) || !this.eventMatchesScope(evidence.eventId, second))) {
			throw new Error("Memory conflict evidence event is outside this memory scope");
		}
		const now = Date.now();
		this.db.transaction(() => {
			this.db.prepare("INSERT OR IGNORE INTO memory_claim_conflicts (claim_id, conflicts_with, created_at) VALUES (?, ?, ?), (?, ?, ?)")
				.run(firstId, secondId, now, secondId, firstId, now);
			this.db.prepare("UPDATE memory_claims SET status = 'conflicted', updated_at = ? WHERE id IN (?, ?)").run(now, firstId, secondId);
			this.addEvidence(firstId, "conflict", evidence.excerpt, evidence.eventId, evidence.sourceRef);
			this.addEvidence(secondId, "conflict", evidence.excerpt, evidence.eventId, evidence.sourceRef);
		})();
		return true;
	}

	correctClaim(id: string, replacement: Pick<ClaimInput, "statement" | "confidence" | "stability" | "expiresAt" | "evidence">, opts: Omit<RecallOptions, "limit"> = {}): MemoryClaim | undefined {
		const current = this.getClaim(id, opts);
		if (!current || (current.status !== "active" && current.status !== "conflicted")) return undefined;
		const evidence = replacement.evidence ?? { kind: "correction" as const, excerpt: `Corrects claim ${id}: ${current.statement}` };
		const corrected = this.upsertClaim({
			profileId: current.profileId, platform: current.platform, chatId: current.chatId, userId: current.userId, threadId: current.threadId,
			projectId: current.projectId, organizationId: current.organizationId, kind: current.kind,
			subject: current.subject, object: current.object, source: current.source, visibility: current.visibility,
			validFrom: current.validFrom, validUntil: replacement.expiresAt ?? current.validUntil,
			statement: replacement.statement, confidence: replacement.confidence ?? Math.max(current.confidence, 0.8),
			stability: replacement.stability ?? current.stability, expiresAt: replacement.expiresAt,
			evidence: { ...evidence, kind: "correction" },
		});
		this.addEvidence(id, "correction", evidence.excerpt, evidence.eventId, evidence.sourceRef);
		this.db.prepare("UPDATE memory_claims SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(corrected.id, Date.now(), id);
		return corrected;
	}

	/** Stop a Claim from governing recall while retaining why and when it was withdrawn. */
	revokeClaim(id: string, opts: Omit<RecallOptions, "limit">, evidence: { excerpt: string; eventId?: string; sourceRef?: string }): boolean {
		const current = this.getClaim(id, opts);
		if (!current || (current.status !== "active" && current.status !== "conflicted")) return false;
		if (!evidence.excerpt.trim()) throw new Error("Organization Memory revocation requires evidence");
		if (evidence.eventId && !this.eventMatchesScope(evidence.eventId, current)) throw new Error("Memory revocation evidence event is outside this memory scope");
		this.db.transaction(() => {
			this.addEvidence(id, "revocation", evidence.excerpt, evidence.eventId, evidence.sourceRef);
			this.db.prepare("UPDATE memory_claims SET status = 'archived', updated_at = ? WHERE id = ?").run(Date.now(), id);
		})();
		return true;
	}

	forgetClaim(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const access = claimReadWhere(opts, "memory_claims");
		return this.db.prepare(`DELETE FROM memory_claims WHERE memory_claims.id = ? ${access.where}`).run(id, ...access.params).changes > 0;
	}

	listClaims(opts: RecallOptions & { status?: MemoryClaim["status"]; limit?: number } = {}): MemoryClaim[] {
		const access = claimReadWhere(opts, "c");
		const status = opts.status ?? "active";
		const rows = this.db.prepare(`SELECT * FROM memory_claims c WHERE c.status = ? ${access.where}
			AND (c.valid_from IS NULL OR c.valid_from <= ?) AND (c.valid_until IS NULL OR c.valid_until > ?)
			ORDER BY CASE c.stability WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, c.confidence DESC, c.updated_at DESC LIMIT ?`)
			.all(status, ...access.params, Date.now(), Date.now(), limitOf(opts.limit, 50)) as ClaimRow[];
		return rows.map(mapClaim);
	}

	recallBrief(query: string, opts: RecallOptions = {}): MemoryBrief {
		const match = toFtsQuery(query);
		const claims = match ? this.searchClaims(match, opts) : [];
		if (claims.length === 0 && query.trim()) claims.push(...this.searchClaimsLike(query.trim(), opts));
		return { claims, records: this.recall(query, { ...opts, limit: Math.min(opts.limit ?? 5, 8) }) };
	}

	explainClaim(id: string, opts: Omit<RecallOptions, "limit"> = {}): { claim: MemoryClaim; evidence: MemoryEvidence[] } | undefined {
		const claim = this.getClaim(id, opts);
		if (!claim) return undefined;
		const evidence = this.db.prepare(`SELECT v.id, v.claim_id, v.event_id, v.source_ref, v.kind, v.excerpt, v.created_at,
			e.id AS event_id_value, e.platform AS event_platform, e.chat_id AS event_chat_id, e.user_id AS event_user_id, e.kind AS event_kind, e.content AS event_content, e.occurred_at AS event_occurred_at, e.created_at AS event_created_at
			FROM memory_evidence v LEFT JOIN memory_events e ON e.id = v.event_id WHERE v.claim_id = ? ORDER BY v.created_at DESC`).all(id) as EvidenceRow[];
		return { claim, evidence: evidence.map(mapEvidence) };
	}

	/** Compile a small, deterministic long-term snapshot. The SQLite ledger remains the source of truth. */
	compileLongTermMemory(opts: RecallOptions & { maxChars?: number } = {}): string {
		const limit = Math.max(300, Math.min(opts.maxChars ?? 2200, 8000));
		const claims = this.listClaims({ ...opts, limit: 100 })
			.filter((claim) => opts.subject || opts.object || (!claim.subject && !claim.object))
			.filter((claim) => claim.stability !== "low" || claim.confidence >= 0.85);
		const grouped = new Map<MemoryClaim["kind"], MemoryClaim[]>();
		for (const claim of claims) grouped.set(claim.kind, [...(grouped.get(claim.kind) ?? []), claim]);
		const lines = ["# BeeMax 长期记忆", "", "此文件由记忆账本生成；原始证据与可纠正版本保存在 SQLite。"];
		for (const kind of MEMORY_CLAIM_KINDS) {
			const entries = grouped.get(kind);
			if (!entries?.length) continue;
			lines.push("", `## ${MEMORY_CLAIM_KIND_LABELS[kind]}`);
			for (const claim of entries) {
				const candidate = `- ${claim.statement}`;
				if ([...lines, candidate].join("\n").length > limit) return `${lines.join("\n")}\n\n[已按大小截断；请使用记忆检索获取更多内容]`;
				lines.push(candidate);
			}
		}
		return lines.join("\n");
	}

	private addEvidence(claimId: string, kind: MemoryEvidence["kind"], excerpt: string, eventId?: string, sourceRef?: string): void {
		this.db.prepare("INSERT INTO memory_evidence (id, claim_id, event_id, source_ref, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(cryptoRandom(), claimId, eventId ?? null, sourceRef?.trim().slice(0, 1_000) ?? null, kind, excerpt.trim().slice(0, 4000), Date.now());
	}

	private eventMatchesScope(eventId: string, input: Pick<ClaimInput, "platform" | "chatId" | "userId" | "threadId">): boolean {
		const row = this.db.prepare("SELECT id FROM memory_events WHERE id = ? AND platform = ? AND chat_id = ? AND user_id IS ? AND thread_id IS ?")
			.get(eventId, input.platform, input.chatId, input.userId ?? null, input.threadId ?? null) as { id: string } | undefined;
		return Boolean(row);
	}

	private getClaim(id: string, opts: Omit<RecallOptions, "limit"> = {}): MemoryClaim | undefined {
		const access = claimReadWhere(opts, "c");
		const row = this.db.prepare(`SELECT * FROM memory_claims c WHERE c.id = ? ${access.where}`).get(id, ...access.params) as ClaimRow | undefined;
		if (!row) return undefined;
		const conflicts = this.db.prepare("SELECT conflicts_with FROM memory_claim_conflicts WHERE claim_id = ? ORDER BY conflicts_with").all(id) as Array<{ conflicts_with: string }>;
		return { ...mapClaim(row), conflictsWith: conflicts.map((item) => item.conflicts_with) };
	}

	private getConventionCandidateByCanonical(profileId: string, scopeKey: string, canonical: string): ConventionCandidate | undefined {
		const row = this.db.prepare("SELECT * FROM memory_convention_candidates WHERE profile_id = ? AND scope_key = ? AND canonical_statement = ?")
			.get(profileId, scopeKey, canonical) as ConventionCandidateRow | undefined;
		return row ? this.hydrateConventionCandidate(row) : undefined;
	}

	private hydrateConventionCandidate(row: ConventionCandidateRow): ConventionCandidate {
		const episodeRows = this.db.prepare("SELECT episode_id, relation FROM memory_convention_episode_evidence WHERE candidate_id = ? ORDER BY episode_id")
			.all(row.id) as Array<{ episode_id: string; relation: "support" | "contradiction" }>;
		const exceptionRows = this.db.prepare("SELECT claim_id FROM memory_convention_exceptions WHERE candidate_id = ? ORDER BY claim_id").all(row.id) as Array<{ claim_id: string }>;
		return {
			id: row.id, profileId: row.profile_id, platform: row.platform, chatId: row.chat_id,
			...(row.user_id ? { userId: row.user_id } : {}), ...(row.thread_id ? { threadId: row.thread_id } : {}),
			statement: row.statement, rationale: row.rationale, confidence: row.confidence, promotionBlocked: Boolean(row.promotion_blocked),
			observedFrom: row.observed_from, observedUntil: row.observed_until, status: row.status,
			supportingEpisodeIds: episodeRows.filter((item) => item.relation === "support").map((item) => item.episode_id),
			contradictoryEpisodeIds: episodeRows.filter((item) => item.relation === "contradiction").map((item) => item.episode_id),
			exceptionClaimIds: exceptionRows.map((item) => item.claim_id), ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
			createdAt: row.created_at, updatedAt: row.updated_at,
		};
	}

	private hydrateWorkflowCandidate(row: WorkflowCandidateRow): WorkflowCandidate {
		const conventions = this.db.prepare("SELECT convention_id FROM memory_workflow_conventions WHERE candidate_id = ? ORDER BY convention_id").all(row.id) as Array<{ convention_id: string }>;
		const episodes = this.db.prepare("SELECT episode_id, relation FROM memory_workflow_episode_evidence WHERE candidate_id = ? ORDER BY episode_id").all(row.id) as Array<{ episode_id: string; relation: "support" | "contradiction" }>;
		return {
			id: row.id, profileId: row.profile_id, platform: row.platform, chatId: row.chat_id,
			...(row.user_id ? { userId: row.user_id } : {}), ...(row.thread_id ? { threadId: row.thread_id } : {}),
			title: row.title, summary: row.summary, conditions: parseWorkflowStrings(row.conditions), exceptions: parseWorkflowStrings(row.exceptions), inputs: parseWorkflowStrings(row.inputs), instructions: parseWorkflowStrings(row.instructions),
			expectedOutcomes: parseWorkflowStrings(row.expected_outcomes), verification: parseWorkflowStrings(row.verification),
			sourceConventionIds: conventions.map((item) => item.convention_id), supportingEpisodeIds: episodes.filter((item) => item.relation === "support").map((item) => item.episode_id), contradictoryEpisodeIds: episodes.filter((item) => item.relation === "contradiction").map((item) => item.episode_id),
			status: row.status, revision: row.revision, ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}), createdAt: row.created_at, updatedAt: row.updated_at,
		};
	}

	private currentWorkflowForSkill(id: string, opts: Omit<RecallOptions, "limit">): WorkflowCandidate {
		const candidate = this.getWorkflowCandidate(id, opts);
		if (!candidate || candidate.status !== "candidate") throw new Error("Workflow Candidate is unavailable for Skill staging or promotion");
		if (candidate.contradictoryEpisodeIds.length) throw new Error("Workflow Candidate has contradictory Episode evidence");
		for (const conventionId of candidate.sourceConventionIds) {
			const convention = this.getConventionCandidate(conventionId, opts);
			if (!convention || convention.status !== "confirmed") throw new Error("Workflow Candidate source Convention is no longer confirmed");
		}
		return candidate;
	}

	private transitionWorkflowCandidate(id: string, opts: Omit<RecallOptions, "limit">, status: "rejected" | "archived", evidence: WorkflowTransitionEvidence): boolean {
		const current = this.getWorkflowCandidate(id, opts);
		if (!current || current.status !== "candidate") return false;
		return this.db.transaction(() => {
			const changed = this.db.prepare("UPDATE memory_workflow_candidates SET status = ?, updated_at = ? WHERE id = ? AND status = 'candidate'").run(status, Date.now(), id).changes;
			if (!changed) return false;
			this.recordWorkflowEvent(id, status, evidence);
			return true;
		})();
	}

	private recordWorkflowEvent(id: string, kind: WorkflowCandidateEvent["kind"], evidence: WorkflowTransitionEvidence): void {
		const excerpt = boundedEpisodeText(evidence.excerpt, "Workflow review evidence", 4_000);
		const sourceRef = evidence.sourceRef ? boundedEpisodeText(evidence.sourceRef, "Workflow review source", 1_000) : undefined;
		if (containsCredentialMaterial(`${excerpt}\n${sourceRef ?? ""}`)) throw new Error("Workflow review evidence cannot contain credential material");
		this.db.prepare("INSERT INTO memory_workflow_events (id, candidate_id, kind, excerpt, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(cryptoRandom(), id, kind, excerpt, sourceRef ?? null, Date.now());
	}

	private transitionConventionCandidate(id: string, expected: ConventionCandidateStatus, status: "confirmed" | "rejected" | "superseded" | "rolled_back", evidence: ConventionTransitionEvidence, supersededBy?: string, requireUnblocked = false): boolean {
		if (!evidence.excerpt.trim()) throw new Error("Convention transition requires evidence");
		const kind: ConventionCandidateEvent["kind"] = status === "rolled_back" ? "rollback" : status;
		const now = Date.now();
		return this.db.transaction(() => {
			if (supersededBy) {
				const replacement = this.db.prepare("SELECT status FROM memory_convention_candidates WHERE id = ?").get(supersededBy) as { status: ConventionCandidateStatus } | undefined;
				if (replacement?.status !== "candidate") return false;
			}
			const changed = this.db.prepare(`UPDATE memory_convention_candidates SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND status = ?${requireUnblocked ? " AND promotion_blocked = 0" : ""}`)
				.run(status, supersededBy ?? null, now, id, expected).changes;
			if (!changed) return false;
			this.db.prepare("INSERT INTO memory_convention_events (id, candidate_id, kind, excerpt, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)")
				.run(cryptoRandom(), id, kind, evidence.excerpt.trim().slice(0, 4_000), evidence.sourceRef?.trim().slice(0, 1_000) ?? null, now);
			return true;
		})();
	}

	private searchClaims(match: string, opts: RecallOptions): MemoryClaim[] {
		const access = claimRecallWhere(opts, "c");
		const rows = this.db.prepare(`SELECT c.* FROM memory_claims_fts f JOIN memory_claims c ON c.rowid = f.rowid
			WHERE memory_claims_fts MATCH ? AND c.status IN ('active', 'conflicted') ${access.where}
			AND (c.valid_from IS NULL OR c.valid_from <= ?) AND (c.valid_until IS NULL OR c.valid_until > ?)
			ORDER BY rank, c.confidence DESC, c.updated_at DESC LIMIT ?`)
			.all(match, ...access.params, Date.now(), Date.now(), limitOf(opts.limit, 5)) as ClaimRow[];
		return rows.map(mapClaim);
	}

	private searchClaimsLike(query: string, opts: RecallOptions): MemoryClaim[] {
		const access = claimRecallWhere(opts, "c");
		const rows = this.db.prepare(`SELECT c.* FROM memory_claims c
			WHERE c.statement LIKE ? AND c.status IN ('active', 'conflicted') ${access.where}
			AND (c.valid_from IS NULL OR c.valid_from <= ?) AND (c.valid_until IS NULL OR c.valid_until > ?)
			ORDER BY c.confidence DESC, c.updated_at DESC LIMIT ?`)
			.all(`%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, ...access.params, Date.now(), Date.now(), limitOf(opts.limit, 5)) as ClaimRow[];
		return rows.map(mapClaim);
	}

	remember(record: Omit<MemoryRecord, "id" | "createdAt">): string {
		const id = cryptoRandom();
		const createdAt = Date.now();
		this.db
			.prepare(
				"INSERT INTO memories (id, platform, chat_id, user_id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
				.run(id, record.platform, record.chatId, record.userId ?? null, record.threadId ?? null, record.role, record.content, createdAt);
		this.db.prepare(`DELETE FROM memories WHERE platform = ? AND chat_id = ? AND user_id IS ? AND id NOT IN
			(SELECT id FROM memories WHERE platform = ? AND chat_id = ? AND user_id IS ? ORDER BY created_at DESC LIMIT 5000)`)
			.run(record.platform, record.chatId, record.userId ?? null, record.platform, record.chatId, record.userId ?? null);
		return id;
	}

	/** Store a raw turn as a retrievable candidate, not as curated long-term memory. */
	recordCandidate(record: Omit<MemoryRecord, "id" | "createdAt" | "role"> & { role: "user" | "assistant" }): string {
		const existing = this.db.prepare(
			"SELECT id FROM memory_candidates WHERE platform = ? AND chat_id = ? AND user_id IS ? AND thread_id IS ? AND subject_type IS ? AND subject_id IS ? AND object_type IS ? AND object_id IS ? AND role = ? AND content = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
		).get(record.platform, record.chatId, record.userId ?? null, record.threadId ?? null, record.subject?.type ?? null, record.subject?.id ?? null, record.object?.type ?? null, record.object?.id ?? null, record.role, record.content) as { id: string } | undefined;
		if (existing) return existing.id;
		const id = cryptoRandom();
		this.db.prepare(
			"INSERT INTO memory_candidates (id, platform, chat_id, user_id, thread_id, subject_type, subject_id, object_type, object_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
		).run(id, record.platform, record.chatId, record.userId ?? null, record.threadId ?? null, record.subject?.type ?? null, record.subject?.id ?? null, record.object?.type ?? null, record.object?.id ?? null, record.role, record.content, Date.now());
		this.db.prepare(`DELETE FROM memory_candidates WHERE platform = ? AND chat_id = ? AND user_id IS ? AND id NOT IN
			(SELECT id FROM memory_candidates WHERE platform = ? AND chat_id = ? AND user_id IS ? ORDER BY created_at DESC LIMIT 5000)`)
			.run(record.platform, record.chatId, record.userId ?? null, record.platform, record.chatId, record.userId ?? null);
		return id;
	}

	/**
	 * Full-text recall. Returns matching rows ranked by FTS5 relevance, filtered
	 * to the requesting scope (same chat, or same user across chats).
	 */
	recall(query: string, opts: RecallOptions = {}): MemoryRecord[] {
		return this.recallRanked(query, opts);
	}

	recallRanked(query: string, opts: RecallOptions = {}): MemoryRecallHit[] {
		const match = toFtsQuery(query);
		if (!match) return [];
		const limit = Math.max(1, Math.min(opts.limit ?? 5, 100));
		const hasBusinessObjectScope = Boolean(opts.subject || opts.object);
		const conditions: string[] = [];
		const params: unknown[] = [match];
		if (opts.platform) {
			conditions.push("m.platform = ?");
			params.push(opts.platform);
		}
		if (opts.chatId) {
			conditions.push("m.chat_id = ?");
			params.push(opts.chatId);
		}
		if (opts.userId) {
			conditions.push("m.user_id = ?");
			params.push(opts.userId);
		}
		if (opts.chatId) {
			conditions.push("m.thread_id IS ?");
			params.push(opts.threadId ?? null);
		}
		const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";
		const ftsRows = hasBusinessObjectScope ? [] : this.db
			.prepare(
				`SELECT m.id, m.platform, m.chat_id, m.user_id, m.thread_id, m.role, m.content, m.created_at
				 FROM memories_fts f
				 JOIN memories m ON m.rowid = f.rowid
				 WHERE memories_fts MATCH ?
				 ${where}
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(...params, limit) as MemoryRow[];
		const likeRows = hasBusinessObjectScope ? [] : this.searchMemoryRowsLike(query, opts, limit);
		const records: MemoryRecallHit[] = uniqueById([...ftsRows, ...likeRows]).map((row) => rankMemoryHit({ ...mapRow(row), memoryType: "curated", confidence: 1, status: "active", matchReasons: [] }, query, opts));
		const claims = this.searchClaims(match, opts);
		if (claims.length === 0) claims.push(...this.searchClaimsLike(query.trim(), opts));
		const claimRecords: MemoryRecallHit[] = claims.map((claim) => rankMemoryHit({
			id: claim.id, platform: claim.platform, chatId: claim.chatId, userId: claim.userId,
			role: "memory", content: claim.statement, createdAt: claim.updatedAt, memoryType: "claim", confidence: claim.confidence,
			status: claim.status, matchReasons: [], subject: claim.subject, object: claim.object,
		}, query, opts));
		const candidates: MemoryRecallHit[] = opts.includeCandidates ? this.searchCandidateRowsLike(query, opts, limit).map((row) => rankMemoryHit({
			...mapRow(row), memoryType: "candidate", confidence: 0.35, status: "pending", matchReasons: [],
		}, query, opts)) : [];
		return uniqueById([...claimRecords, ...records, ...candidates]).sort((a, b) => b.score - a.score || b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, limit);
	}

	evaluateRecall(cases: readonly MemoryRecallEvaluationCase[], k = 5): MemoryRecallEvaluation {
		const boundedK = Math.max(1, Math.min(Math.trunc(k), 100));
		let hitCases = 0; let expected = 0; let expectedRetrieved = 0; let forbiddenRetrieved = 0; let forbiddenTotal = 0;
		for (const sample of cases) {
			const ids = new Set(this.recallRanked(sample.query, { ...sample.options, limit: boundedK }).map((hit) => hit.id));
			const retrieved = sample.expectedIds.filter((id) => ids.has(id)).length;
			expected += sample.expectedIds.length; expectedRetrieved += retrieved;
			if (retrieved > 0) hitCases++;
			for (const id of sample.forbiddenIds ?? []) { forbiddenTotal++; if (ids.has(id)) forbiddenRetrieved++; }
		}
		return {
			cases: cases.length, hitCases, hitRateAtK: cases.length ? hitCases / cases.length : 0,
			expected, expectedRetrieved, recallAtK: expected ? expectedRetrieved / expected : 0,
			forbiddenRetrieved, forbiddenRetrievalRate: forbiddenTotal ? forbiddenRetrieved / forbiddenTotal : 0,
		};
	}

	private searchMemoryRowsLike(query: string, opts: RecallOptions, limit: number): MemoryRow[] {
		const lexical = lexicalWhere(query, "m.content");
		if (!lexical) return [];
		const scope = scopeWhere(opts, "m");
		return this.db.prepare(`SELECT m.id, m.platform, m.chat_id, m.user_id, m.thread_id, m.role, m.content, m.created_at
			FROM memories m WHERE ${lexical.where} ${scope.where} ORDER BY m.created_at DESC LIMIT ?`)
			.all(...lexical.params, ...scope.params, limit) as MemoryRow[];
	}

	private searchCandidateRowsLike(query: string, opts: RecallOptions, limit: number): MemoryRow[] {
		const lexical = lexicalWhere(query, "c.content");
		if (!lexical) return [];
		const scope = scopeWhere(opts, "c");
		const entityConditions: string[] = [];
		const entityParams: unknown[] = [];
		if (opts.subject) { entityConditions.push("c.subject_type = ? AND c.subject_id = ?"); entityParams.push(opts.subject.type, opts.subject.id); }
		if (opts.object) { entityConditions.push("c.object_type = ? AND c.object_id = ?"); entityParams.push(opts.object.type, opts.object.id); }
		if (!opts.subject && !opts.object) entityConditions.push("c.subject_type IS NULL AND c.object_type IS NULL");
		const entityWhere = entityConditions.length ? `AND ${entityConditions.join(" AND ")}` : "";
		return this.db.prepare(`SELECT c.id, c.platform, c.chat_id, c.user_id, c.thread_id, c.subject_type, c.subject_id, c.object_type, c.object_id, c.role, c.content, c.created_at
			FROM memory_candidates c WHERE c.status = 'pending' AND ${lexical.where} ${scope.where} ${entityWhere} ORDER BY c.created_at DESC LIMIT ?`)
			.all(...lexical.params, ...scope.params, ...entityParams, limit) as MemoryRow[];
	}

	list(opts: RecallOptions = {}): MemoryRecord[] {
		const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
		const conditions = ["role = 'memory'"];
		const params: unknown[] = [];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
		const rows = this.db.prepare(
			`SELECT id, platform, chat_id, user_id, thread_id, role, content, created_at
			 FROM memories WHERE ${conditions.join(" AND ")}
			 ORDER BY created_at DESC LIMIT ?`,
		).all(...params, limit) as MemoryRow[];
		return rows.map(mapRow);
	}

	listCandidates(opts: RecallOptions = {}): MemoryCandidate[] {
		const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
		const conditions = ["status = 'pending'"];
		const params: unknown[] = [];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
		const entity = candidateEntityWhere(opts);
		conditions.push(...entity.conditions); params.push(...entity.params);
		const rows = this.db.prepare(
			`SELECT id, platform, chat_id, user_id, thread_id, subject_type, subject_id, object_type, object_id, role, content, status, created_at FROM memory_candidates WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
		).all(...params, limit) as CandidateRow[];
		return rows.map(mapCandidate);
	}

	promoteCandidate(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const conditions = ["id = ?", "status = 'pending'"];
		const params: unknown[] = [id];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
		const entity = candidateEntityWhere(opts);
		conditions.push(...entity.conditions); params.push(...entity.params);
		const row = this.db.prepare(
			`SELECT id, platform, chat_id, user_id, thread_id, subject_type, subject_id, object_type, object_id, content FROM memory_candidates WHERE ${conditions.join(" AND ")}`,
		).get(...params) as Pick<MemoryRow, "id" | "platform" | "chat_id" | "user_id" | "thread_id" | "subject_type" | "subject_id" | "object_type" | "object_id" | "content"> | undefined;
		if (!row) return false;
		const candidate = mapRow({ ...row, role: "memory", created_at: Date.now() });
		this.db.transaction(() => {
			if (candidate.subject || candidate.object) this.upsertClaim({
				profileId: opts.profileId, platform: candidate.platform, chatId: candidate.chatId, userId: candidate.userId, threadId: candidate.threadId,
				projectId: opts.projectId, organizationId: opts.organizationId, kind: "fact", statement: candidate.content,
				subject: candidate.subject, object: candidate.object, source: { type: "manual", ref: candidate.id }, visibility: "conversation",
				confidence: 0.8, stability: "medium", evidence: { kind: "manual", excerpt: candidate.content },
			});
			else this.remember({ platform: candidate.platform, chatId: candidate.chatId, userId: candidate.userId, threadId: candidate.threadId, role: "memory", content: candidate.content });
			this.db.prepare("UPDATE memory_candidates SET status = 'promoted' WHERE id = ?").run(id);
		})();
		return true;
	}

	rejectCandidate(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const conditions = ["id = ?", "status = 'pending'"];
		const params: unknown[] = [id];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
		const entity = candidateEntityWhere(opts);
		conditions.push(...entity.conditions); params.push(...entity.params);
		return this.db.prepare(`UPDATE memory_candidates SET status = 'rejected' WHERE ${conditions.join(" AND ")}`).run(...params).changes > 0;
	}

	stats(opts: Omit<RecallOptions, "limit"> = {}): { curated: number; pending: number; promoted: number; rejected: number } {
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const curatedWhere = ["role = 'memory'", ...conditions].join(" AND ");
		const curated = (this.db.prepare(`SELECT count(*) AS value FROM memories WHERE ${curatedWhere}`).get(...params) as { value: number }).value;
		const rows = this.db.prepare(`SELECT status, count(*) AS value FROM memory_candidates ${where} GROUP BY status`).all(...params) as Array<{ status: string; value: number }>;
		const result = { curated, pending: 0, promoted: 0, rejected: 0 };
		for (const row of rows) if (row.status in result) result[row.status as "pending" | "promoted" | "rejected"] = row.value;
		return result;
	}

	upsertTask(task: Pick<TaskFactRecord, "id" | "title" | "status"> & { evidence?: string; completedAt?: number }): void {
		const now = Date.now();
		const completedAt = task.status === "done" ? task.completedAt ?? now : null;
		this.db.prepare(`
			INSERT INTO tasks (id, owner_key, kind, title, status, evidence, created_at, finished_at, updated_at)
			VALUES (?, 'profile', 'objective', ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				title = excluded.title,
				status = excluded.status,
				evidence = excluded.evidence,
				finished_at = CASE WHEN excluded.status = 'succeeded' THEN COALESCE(tasks.finished_at, excluded.finished_at) ELSE NULL END,
				updated_at = excluded.updated_at
		`).run(task.id, task.title, legacyTaskStatus(task.status), task.evidence ?? null, now, completedAt, now);
	}

	listTasks(): TaskFactRecord[] {
		const rows = this.db.prepare("SELECT id, title, status, evidence, finished_at AS completed_at, updated_at FROM tasks WHERE kind = 'objective' ORDER BY updated_at DESC, id").all() as TaskRow[];
		return rows.map((row) => ({
			id: row.id,
			title: row.title,
			status: legacyTaskFactStatus(row.status),
			evidence: row.evidence ?? undefined,
			completedAt: row.completed_at ?? undefined,
			updatedAt: row.updated_at,
		}));
	}

	hasTask(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE id = ? LIMIT 1").get(id)); }

	record(task: RuntimeTaskRecord): void {
		this.db.prepare(`INSERT INTO tasks (id, owner_key, kind, title, description, acceptance_criteria, recovery_policy, idempotency_key, execution_scope, situation, access_scope_ref, status, parent_id, plan_id, evidence, artifacts, unresolved_issues, verification_outcome, verification_feedback, verification_requirements, criterion_verifications, corrective_attempts, created_at, started_at, finished_at, result, candidate_result, error, checkpoint, checkpoint_at, routes, route_index, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(task.id, task.ownerKey, task.kind, task.title, safeTaskText(task.description), task.acceptanceCriteria ?? null, task.recoveryPolicy ?? "never", task.idempotencyKey ?? null, task.executionScope ? JSON.stringify(task.executionScope) : null, task.situation ? JSON.stringify(task.situation) : null, task.accessScopeRef ? JSON.stringify(task.accessScopeRef) : null, task.status, task.parentId ?? null, task.planId ?? null, safeTaskText(task.evidence), safeTaskArtifacts(task.artifacts), safeUnresolvedIssues(task.unresolvedIssues), task.verificationStatus ?? null, safeTaskText(task.verificationFeedback), safeVerificationRequirements(task.verificationRequirements), safeCriterionVerifications(task.criterionVerifications), task.correctiveAttempts ?? 0, task.createdAt, task.startedAt ?? null, task.finishedAt ?? null, safeTaskText(task.result), safeTaskText(task.candidateResult), safeTaskText(task.error), task.checkpoint ? renderTaskCheckpoint(task.checkpoint) : null, task.checkpointAt ?? null, task.routes ? JSON.stringify(task.routes) : null, task.routeIndex ?? 0, task.createdAt);
	}

	updateSituation(ownerKey: string, taskId: string, situation: NonNullable<RuntimeTaskRecord["situation"]>): boolean {
		return this.db.prepare("UPDATE tasks SET situation = ?, updated_at = ? WHERE id = ? AND owner_key = ? AND kind = 'objective' AND status IN ('pending', 'running')")
			.run(JSON.stringify(situation), Date.now(), taskId, ownerKey).changes === 1;
	}

	updateVerificationRequirements(ownerKey: string, taskId: string, requirements: NonNullable<RuntimeTaskRecord["verificationRequirements"]>): boolean {
		const encoded = safeVerificationRequirements(requirements);
		if (!encoded) return false;
		return this.db.prepare("UPDATE tasks SET verification_requirements = ?, updated_at = ? WHERE id = ? AND owner_key = ? AND status IN ('pending', 'running')")
			.run(encoded, Date.now(), taskId, ownerKey).changes === 1;
	}

	transition(id: string, change: TaskTransition): boolean {
		const resultText = safeTaskText(change.result);
		const candidateResult = safeTaskText(change.candidateResult);
		const error = safeTaskText(change.error);
		const evidence = safeTaskText(change.evidence);
		const artifacts = safeTaskArtifacts(change.artifacts);
		const unresolvedIssues = safeUnresolvedIssues(change.unresolvedIssues);
		const verificationFeedback = safeTaskText(change.verificationFeedback);
		const criterionVerifications = safeCriterionVerifications(change.criterionVerifications);
		const result = this.db.prepare(`UPDATE tasks SET status = ?,
			started_at = CASE WHEN ? = 'pending' THEN NULL ELSE COALESCE(?, started_at) END,
			finished_at = CASE WHEN ? IN ('pending', 'running') THEN NULL ELSE COALESCE(?, finished_at) END,
			result = CASE WHEN ? IN ('pending', 'running') THEN NULL ELSE COALESCE(?, result) END,
			candidate_result = CASE WHEN ? = 'succeeded' THEN NULL WHEN ? IS NOT NULL THEN ? WHEN ? = 'pending' THEN NULL ELSE candidate_result END,
			error = CASE WHEN ? = 'succeeded' THEN NULL WHEN ? IS NOT NULL THEN ? WHEN ? = 'running' THEN NULL ELSE error END,
			evidence = COALESCE(?, evidence),
			artifacts = COALESCE(?, artifacts), unresolved_issues = COALESCE(?, unresolved_issues),
			verification_outcome = COALESCE(?, verification_outcome),
			verification_feedback = CASE WHEN ? = 'succeeded' THEN NULL ELSE COALESCE(?, verification_feedback) END,
			criterion_verifications = CASE WHEN ? = 'succeeded' THEN ? WHEN ? IS NOT NULL THEN ? ELSE criterion_verifications END,
			corrective_attempts = COALESCE(?, corrective_attempts),
			updated_at = ? WHERE id = ? AND ((? = 'pending' AND status = 'running') OR (? = 'running' AND status IN ('pending', 'running')) OR (? IN ('succeeded', 'failed', 'cancelled') AND status IN ('pending', 'running')))`)
			.run(change.status, change.status, change.startedAt ?? null, change.status, change.finishedAt ?? null, change.status, resultText,
				change.status, candidateResult, candidateResult, change.status,
				change.status, error, error, change.status,
				evidence, artifacts, unresolvedIssues, change.verificationStatus ?? null, change.status, verificationFeedback, change.status, criterionVerifications, criterionVerifications, criterionVerifications, change.correctiveAttempts ?? null, Date.now(), id, change.status, change.status, change.status);
		return result.changes === 1;
	}

	retryObjective(ownerKey: string, id: string, now = Date.now()): boolean {
		return this.db.prepare(`UPDATE tasks SET status = 'running', started_at = ?, finished_at = NULL, result = NULL, error = NULL, updated_at = ?
			WHERE id = ? AND owner_key = ? AND kind = 'objective' AND status = 'failed'`).run(now, now, id, ownerKey).changes === 1;
	}

	cancelObjectives(ownerKey: string, now = Date.now()): number {
		return this.db.prepare("UPDATE tasks SET status = 'cancelled', finished_at = ?, error = 'Cancelled by user', updated_at = ? WHERE owner_key = ? AND kind = 'objective' AND status IN ('pending', 'running')").run(now, now, ownerKey).changes;
	}

	activeObjectivePlanIds(ownerKey: string): string[] {
		return (this.db.prepare(`SELECT DISTINCT child.plan_id FROM tasks child JOIN tasks objective ON objective.id = child.parent_id
			WHERE objective.owner_key = ? AND objective.kind = 'objective' AND objective.status IN ('pending', 'running') AND child.plan_id IS NOT NULL`).all(ownerKey) as Array<{ plan_id: string }>).map((row) => row.plan_id);
	}

	recordRun(run: TaskRunRecord): void {
		this.db.prepare("INSERT INTO task_runs (id, task_id, executor, status, started_at, lease_expires_at, finished_at, output, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(run.id, run.taskId, run.executor, run.status, run.startedAt, run.leaseExpiresAt ?? null, run.finishedAt ?? null, safeTaskText(run.output), safeTaskText(run.error));
	}

	transitionRun(id: string, change: TaskRunTransition): boolean {
		const result = this.db.prepare("UPDATE task_runs SET status = ?, finished_at = COALESCE(?, finished_at), output = COALESCE(?, output), error = COALESCE(?, error) WHERE id = ? AND status = 'running'")
			.run(change.status, change.finishedAt ?? null, safeTaskText(change.output), safeTaskText(change.error), id);
		return result.changes === 1;
	}

	renewTaskRunLease(id: string, leaseExpiresAt: number): boolean {
		return this.db.prepare("UPDATE task_runs SET lease_expires_at = ? WHERE id = ? AND status = 'running'").run(leaseExpiresAt, id).changes === 1;
	}

	taskRuns(taskId: string): TaskRunRecord[] {
		return (this.db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC").all(taskId) as TaskRunRow[]).map(mapTaskRun);
	}

	queryTasks(query: TaskQuery): RuntimeTaskRecord[] {
		if (query.ownerKeys.length === 0) return [];
		const conditions = [`owner_key IN (${query.ownerKeys.map(() => "?").join(", ")})`];
		const params: unknown[] = [...query.ownerKeys];
		if (query.id) { conditions.push("id = ?"); params.push(query.id); }
		if (query.kinds?.length) { conditions.push(`kind IN (${query.kinds.map(() => "?").join(", ")})`); params.push(...query.kinds); }
		if (query.statuses?.length) { conditions.push(`status IN (${query.statuses.map(() => "?").join(", ")})`); params.push(...query.statuses); }
		if (query.planIds?.length) { conditions.push(`plan_id IN (${query.planIds.map(() => "?").join(", ")})`); params.push(...query.planIds); }
		if (query.parentIds?.length) { conditions.push(`parent_id IN (${query.parentIds.map(() => "?").join(", ")})`); params.push(...query.parentIds); }
		params.push(limitOf(query.limit, 50));
		const rows = this.db.prepare(`SELECT * FROM tasks WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...params) as RuntimeTaskRow[];
		return rows.map(mapRuntimeTask);
	}

	recordPlan(tasks: RuntimeTaskRecord[], dependencies: TaskDependency[], plan?: TaskPlanRecord): void {
		this.db.transaction(() => {
			if (plan) this.db.prepare(`INSERT INTO task_plans (id, owner_key, title, status, task_count, succeeded, failed, cancelled, verified, corrective_attempts, created_at, started_at, finished_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(plan.id, plan.ownerKey, plan.title, plan.status, plan.taskCount, plan.succeeded, plan.failed, plan.cancelled, plan.verified, plan.correctiveAttempts, plan.createdAt, plan.startedAt ?? null, plan.finishedAt ?? null);
			for (const task of tasks) this.record(task);
			const insert = this.db.prepare("INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)");
			for (const edge of dependencies) insert.run(edge.taskId, edge.dependsOn);
		})();
	}

	transitionPlan(id: string, change: TaskPlanTransition): boolean {
		const update = this.db.prepare(`UPDATE task_plans SET status = ?, task_count = ?, succeeded = ?, failed = ?, cancelled = ?, verified = ?, corrective_attempts = ?,
			started_at = COALESCE(?, started_at), finished_at = CASE WHEN ? IN ('pending', 'running') THEN NULL ELSE COALESCE(?, finished_at) END
			WHERE id = ? AND ((? = 'running' AND status IN ('pending', 'running')) OR (? IN ('succeeded', 'failed', 'cancelled') AND status IN ('pending', 'running')))`);
		let result = update.run(change.status, change.taskCount, change.succeeded, change.failed, change.cancelled, change.verified, change.correctiveAttempts, change.startedAt ?? null, change.status, change.finishedAt ?? null, id, change.status, change.status);
		if (result.changes !== 1) {
			this.backfillTaskPlans(id);
			result = update.run(change.status, change.taskCount, change.succeeded, change.failed, change.cancelled, change.verified, change.correctiveAttempts, change.startedAt ?? null, change.status, change.finishedAt ?? null, id, change.status, change.status);
		}
		return result.changes === 1;
	}

	claimTaskPlanExecution(ownerKey: string, planId: string, holderId: string, leaseExpiresAt: number, now = Date.now()): boolean {
		if (!ownerKey.trim() || !planId.trim() || !holderId.trim() || leaseExpiresAt <= now) return false;
		this.backfillTaskPlans(planId);
		return this.db.prepare(`INSERT INTO task_plan_execution_claims (plan_id, owner_key, holder_id, lease_expires_at)
			SELECT id, owner_key, ?, ? FROM task_plans WHERE id = ? AND owner_key = ? AND status IN ('pending', 'running', 'failed')
			ON CONFLICT(plan_id) DO UPDATE SET owner_key = excluded.owner_key, holder_id = excluded.holder_id, lease_expires_at = excluded.lease_expires_at
			WHERE task_plan_execution_claims.owner_key = excluded.owner_key
				AND (task_plan_execution_claims.holder_id = excluded.holder_id OR task_plan_execution_claims.lease_expires_at <= ?)`)
			.run(holderId, leaseExpiresAt, planId, ownerKey, now).changes === 1;
	}

	renewTaskPlanExecution(ownerKey: string, planId: string, holderId: string, leaseExpiresAt: number, now = Date.now()): boolean {
		if (leaseExpiresAt <= now) return false;
		return this.db.prepare(`UPDATE task_plan_execution_claims SET lease_expires_at = ?
			WHERE plan_id = ? AND owner_key = ? AND holder_id = ? AND lease_expires_at > ?`)
			.run(leaseExpiresAt, planId, ownerKey, holderId, now).changes === 1;
	}

	releaseTaskPlanExecution(ownerKey: string, planId: string, holderId: string): boolean {
		return this.db.prepare("DELETE FROM task_plan_execution_claims WHERE plan_id = ? AND owner_key = ? AND holder_id = ?")
			.run(planId, ownerKey, holderId).changes === 1;
	}

	claimTaskVerification(ownerKey: string, taskId: string, holderId: string, leaseExpiresAt: number, now = Date.now()): boolean {
		if (!ownerKey.trim() || !taskId.trim() || !holderId.trim() || leaseExpiresAt <= now) return false;
		return this.db.prepare(`INSERT INTO task_verification_claims (task_id, owner_key, holder_id, lease_expires_at)
			SELECT id, owner_key, ?, ? FROM tasks WHERE id = ? AND owner_key = ? AND status IN ('running', 'failed')
				AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL
			ON CONFLICT(task_id) DO UPDATE SET owner_key = excluded.owner_key, holder_id = excluded.holder_id, lease_expires_at = excluded.lease_expires_at
			WHERE task_verification_claims.owner_key = excluded.owner_key
				AND (task_verification_claims.holder_id = excluded.holder_id OR task_verification_claims.lease_expires_at <= ?)`)
			.run(holderId, leaseExpiresAt, taskId, ownerKey, now).changes === 1;
	}

	renewTaskVerification(ownerKey: string, taskId: string, holderId: string, leaseExpiresAt: number, now = Date.now()): boolean {
		if (leaseExpiresAt <= now) return false;
		return this.db.prepare(`UPDATE task_verification_claims SET lease_expires_at = ?
			WHERE task_id = ? AND owner_key = ? AND holder_id = ? AND lease_expires_at > ?`)
			.run(leaseExpiresAt, taskId, ownerKey, holderId, now).changes === 1;
	}

	releaseTaskVerification(ownerKey: string, taskId: string, holderId: string): boolean {
		return this.db.prepare("DELETE FROM task_verification_claims WHERE task_id = ? AND owner_key = ? AND holder_id = ?")
			.run(taskId, ownerKey, holderId).changes === 1;
	}

	private backfillTaskPlans(id?: string): void {
		const statement = this.db.prepare(`INSERT OR IGNORE INTO task_plans (id, owner_key, title, status, task_count, succeeded, failed, cancelled, verified, corrective_attempts, created_at, started_at, finished_at)
			SELECT plan_id, owner_key, 'Task Plan',
				CASE WHEN SUM(status = 'failed') > 0 THEN 'failed' WHEN SUM(status = 'running') > 0 THEN 'running' WHEN SUM(status = 'pending') > 0 THEN 'pending' WHEN SUM(status = 'cancelled') > 0 THEN 'cancelled' ELSE 'succeeded' END,
				COUNT(*), SUM(status = 'succeeded'), SUM(status = 'failed'), SUM(status = 'cancelled'), COALESCE(SUM(verification_outcome = 'accepted'), 0), COALESCE(SUM(corrective_attempts), 0),
				MIN(created_at), MIN(started_at), CASE WHEN SUM(status IN ('pending', 'running')) = 0 THEN MAX(finished_at) ELSE NULL END
			FROM tasks WHERE ${id ? "plan_id = ?" : "plan_id IS NOT NULL"} GROUP BY plan_id, owner_key`);
		if (id) statement.run(id); else statement.run();
	}

	queryTaskPlans(query: TaskPlanQuery): TaskPlanRecord[] {
		if (!query.ownerKeys.length) return [];
		const conditions = [`owner_key IN (${query.ownerKeys.map(() => "?").join(", ")})`];
		const params: unknown[] = [...query.ownerKeys];
		if (query.id) { conditions.push("id = ?"); params.push(query.id); }
		if (query.statuses?.length) { conditions.push(`status IN (${query.statuses.map(() => "?").join(", ")})`); params.push(...query.statuses); }
		params.push(limitOf(query.limit, 50));
		return (this.db.prepare(`SELECT * FROM task_plans WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...params) as TaskPlanRow[]).map(mapTaskPlan);
	}

	taskDependencies(taskIds: string[]): TaskDependency[] {
		if (taskIds.length === 0) return [];
		return this.db.prepare(`SELECT task_id, depends_on FROM task_dependencies WHERE task_id IN (${taskIds.map(() => "?").join(", ")})`)
			.all(...taskIds).map((row) => ({ taskId: (row as { task_id: string }).task_id, dependsOn: (row as { depends_on: string }).depends_on }));
	}

	checkpointTask(ownerKey: string, taskId: string, checkpoint: TaskCheckpoint | string, now = Date.now()): boolean {
		const encoded = renderTaskCheckpoint(checkpoint);
		if (containsCredentialMaterial(encoded)) return false;
		return this.db.prepare("UPDATE tasks SET checkpoint = ?, checkpoint_at = ?, updated_at = ? WHERE id = ? AND owner_key = ? AND status = 'running'")
			.run(encoded.slice(0, 50_000), now, now, taskId, ownerKey).changes === 1;
	}

	advanceTaskRoute(ownerKey: string, taskId: string, error: string, now = Date.now()): boolean {
		return this.db.prepare(`UPDATE tasks SET status = 'pending', started_at = NULL, finished_at = NULL, error = ?, route_index = route_index + 1,
			verification_outcome = CASE WHEN acceptance_criteria IS NULL THEN NULL ELSE 'pending' END, verification_feedback = NULL,
			criterion_verifications = NULL, candidate_result = NULL, corrective_attempts = 0, updated_at = ?
			WHERE id = ? AND owner_key = ? AND status = 'running' AND routes IS NOT NULL AND route_index + 1 < json_array_length(routes)`)
			.run(redactCredentialMaterial(`Route failed; switching strategy: ${error}`.slice(0, 5_000)), now, taskId, ownerKey).changes === 1;
	}

	pauseTaskPlan(ownerKeys: string[], planId: string, now = Date.now()): boolean {
		if (!ownerKeys.length || !planId.trim()) return false;
		return this.db.prepare(`UPDATE task_plans SET paused_at = ? WHERE id = ? AND owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND status IN ('pending', 'running') AND paused_at IS NULL`)
			.run(now, planId, ...ownerKeys).changes === 1;
	}

	resumeTaskPlan(ownerKeys: string[], planId: string): boolean {
		if (!ownerKeys.length || !planId.trim()) return false;
		return this.db.prepare(`UPDATE task_plans SET paused_at = NULL WHERE id = ? AND owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND paused_at IS NOT NULL`)
			.run(planId, ...ownerKeys).changes === 1;
	}

	reconcileExpiredTaskRuns(now = Date.now(), effects?: TaskRunEffectStateReader): TaskRecoveryResult {
		return this.db.transaction(() => {
			const rows = this.db.prepare(`SELECT r.id AS run_id, r.task_id, t.owner_key, t.plan_id, t.recovery_policy, t.idempotency_key, t.effect_receipts,
				t.verification_outcome, t.candidate_result, t.acceptance_criteria
				FROM task_runs r JOIN tasks t ON t.id = r.task_id
				WHERE r.status = 'running' AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at <= ?`).all(now) as Array<{ run_id: string; task_id: string; owner_key: string; plan_id: string | null; recovery_policy: string; idempotency_key: string | null; effect_receipts: string | null; verification_outcome: RuntimeTaskRecord["verificationStatus"] | null; candidate_result: string | null; acceptance_criteria: string | null }>;
			let retried = 0; let failed = 0;
			const affectedPlans = new Map<string, { ownerKey: string; planId: string }>();
			const reason = "Task Run interrupted after its Execution Lease expired";
			for (const row of rows) {
				const legacyEffectState = effects ? undefined : readEffectReceiptState(row.effect_receipts);
				const replayBlocked = effects
					? effects.taskRunReplayState({ ownerKey: row.owner_key, taskId: row.task_id, taskRunId: row.run_id }) === "blocked"
					: !legacyEffectState!.readable || legacyEffectState!.receipts.some((receipt) => receipt.sideEffect === "mutation" && (receipt.status === "committed" || receipt.status === "unknown"));
				const taskReason = effects
					? replayBlocked ? `${reason}; automatic replay blocked by authoritative Effect state` : reason
					: !legacyEffectState!.readable ? `${reason}; automatic replay blocked because durable Effect Receipts are unreadable`
						: replayBlocked ? `${reason}; automatic replay blocked by durable Effect Receipt` : reason;
				this.db.prepare("UPDATE task_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'").run(now, taskReason, row.run_id);
				const interruptedVerification = row.candidate_result !== null && row.acceptance_criteria !== null && (row.verification_outcome === "pending" || row.verification_outcome === "unavailable");
				if (interruptedVerification) {
					const criterionVerifications = safeCriterionVerifications(unavailableTaskCriterionVerifications(row.acceptance_criteria ?? undefined, taskReason));
					const changed = this.db.prepare(`UPDATE tasks SET status = 'running', finished_at = NULL, verification_outcome = 'unavailable',
						criterion_verifications = ?, verification_retry_at = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
						.run(criterionVerifications, now, taskReason, now, row.task_id).changes;
					retried += changed;
				} else if (row.recovery_policy === "safe_retry" && row.idempotency_key && !replayBlocked) {
					const changed = this.db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, finished_at = NULL, result = NULL, candidate_result = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(taskReason, now, row.task_id).changes;
					retried += changed;
				} else {
					const changed = this.db.prepare("UPDATE tasks SET status = 'failed', finished_at = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(now, taskReason, now, row.task_id).changes;
					failed += changed;
				}
				if (row.plan_id) affectedPlans.set(`${row.owner_key}\0${row.plan_id}`, { ownerKey: row.owner_key, planId: row.plan_id });
			}
			for (const { planId } of affectedPlans.values()) this.syncTaskPlanFromTasks(planId, now);
			return { retried, failed, affectedPlans: [...affectedPlans.values()].sort((left, right) => left.planId.localeCompare(right.planId)) };
		})();
	}

	recoveryCandidates(limit = 100, excludePlanIds: string[] = []): RuntimeTaskRecord[] {
		const excluded = [...new Set(excludePlanIds.filter((id) => id.trim()))];
		return (this.db.prepare(`SELECT tasks.* FROM tasks LEFT JOIN task_plans ON task_plans.id = tasks.plan_id WHERE tasks.status = 'pending' AND tasks.recovery_policy = 'safe_retry'
			AND idempotency_key IS NOT NULL AND plan_id IS NOT NULL AND execution_scope IS NOT NULL
			AND task_plans.paused_at IS NULL
			${excluded.length ? "AND (tasks.plan_id IS NULL OR tasks.plan_id NOT IN (SELECT value FROM json_each(?)))" : ""}
			ORDER BY updated_at, created_at LIMIT ?`).all(...(excluded.length ? [JSON.stringify(excluded)] : []), limitOf(limit, 100)) as RuntimeTaskRow[]).map(mapRuntimeTask);
	}

	verificationCandidates(now = Date.now(), limit = 100, excludePlanIds: string[] = []): RuntimeTaskRecord[] {
		const excluded = [...new Set(excludePlanIds.filter((id) => id.trim()))];
		return (this.db.prepare(`SELECT tasks.* FROM tasks LEFT JOIN task_plans ON task_plans.id = tasks.plan_id WHERE tasks.status IN ('running', 'failed') AND verification_outcome = 'unavailable'
			AND candidate_result IS NOT NULL AND acceptance_criteria IS NOT NULL
			AND (tasks.plan_id IS NULL OR task_plans.paused_at IS NULL)
			AND (verification_retry_at IS NULL OR verification_retry_at <= ?)
			${excluded.length ? "AND (tasks.plan_id IS NULL OR tasks.plan_id NOT IN (SELECT value FROM json_each(?)))" : ""}
			ORDER BY COALESCE(verification_retry_at, 0), updated_at, created_at LIMIT ?`)
			.all(now, ...(excluded.length ? [JSON.stringify(excluded)] : []), limitOf(limit, 100)) as RuntimeTaskRow[]).map(mapRuntimeTask);
	}

	deferCandidateVerification(ownerKeys: string[], taskId: string, now = Date.now()): boolean {
		if (!ownerKeys.length || !taskId.trim()) return false;
		const row = this.db.prepare(`SELECT verification_attempts FROM tasks WHERE id = ? AND owner_key IN (${ownerKeys.map(() => "?").join(", ")})
			AND status IN ('running', 'failed') AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL`).get(taskId, ...ownerKeys) as { verification_attempts: number } | undefined;
		if (!row) return false;
		const attempts = Math.max(0, row.verification_attempts) + 1;
		const delay = Math.min(60 * 60_000, 60_000 * (2 ** Math.min(attempts - 1, 6)));
		return this.db.prepare(`UPDATE tasks SET verification_attempts = ?, verification_retry_at = ?, updated_at = ?
			WHERE id = ? AND status IN ('running', 'failed') AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL AND verification_attempts = ?`)
			.run(attempts, now + delay, now, taskId, row.verification_attempts).changes === 1;
	}

	resolveCandidateVerification(ownerKeys: string[], taskId: string, resolution: TaskCandidateVerificationResolution, now = Date.now()): boolean {
		if (!ownerKeys.length || !taskId.trim()) return false;
		return this.db.transaction(() => {
			const row = this.db.prepare(`SELECT plan_id FROM tasks WHERE id = ? AND owner_key IN (${ownerKeys.map(() => "?").join(", ")})
				AND status IN ('running', 'failed') AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL`).get(taskId, ...ownerKeys) as { plan_id: string | null } | undefined;
			if (!row) return false;
			const criterionVerifications = safeCriterionVerifications(resolution.criterionVerifications);
			const changed = resolution.accepted
				? this.db.prepare(`UPDATE tasks SET status = 'succeeded', result = candidate_result, candidate_result = NULL, evidence = COALESCE(?, evidence),
					verification_outcome = 'accepted', verification_feedback = NULL, criterion_verifications = ?, verification_retry_at = NULL, error = NULL, finished_at = ?, updated_at = ?
					WHERE id = ? AND status IN ('running', 'failed') AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL`).run(safeTaskText(resolution.evidence), criterionVerifications, now, now, taskId).changes
				: this.db.prepare(`UPDATE tasks SET status = 'failed', finished_at = ?, verification_outcome = 'rejected', verification_feedback = ?, criterion_verifications = ?, verification_retry_at = NULL, error = ?, updated_at = ?
					WHERE id = ? AND status IN ('running', 'failed') AND verification_outcome = 'unavailable' AND candidate_result IS NOT NULL`)
					.run(now, safeTaskText(resolution.feedback.slice(0, 5_000)), criterionVerifications, safeTaskText(`Task verification rejected: ${resolution.feedback}`.slice(0, 5_000)), now, taskId).changes;
			if (changed && row.plan_id) this.syncTaskPlanAfterCandidateVerification(row.plan_id, now);
			return changed === 1;
		})();
	}

	prepareTaskCorrections(maxCorrectiveAttempts: number, now = Date.now()): number {
		const budget = Math.max(0, Math.min(Math.trunc(maxCorrectiveAttempts), 2));
		if (!budget) return 0;
		return this.db.transaction(() => {
			const planIds = this.db.prepare(`SELECT DISTINCT plan_id FROM tasks WHERE status = 'failed' AND verification_outcome = 'rejected'
				AND verification_feedback IS NOT NULL AND candidate_result IS NOT NULL AND corrective_attempts < ?
				AND recovery_policy = 'safe_retry' AND idempotency_key IS NOT NULL AND execution_scope IS NOT NULL AND plan_id IS NOT NULL`)
				.all(budget).map((row) => (row as { plan_id: string }).plan_id);
			if (!planIds.length) return 0;
			const changed = this.db.prepare(`UPDATE tasks SET status = 'pending', started_at = NULL, finished_at = NULL, result = NULL,
				error = 'Automatic Corrective Attempt scheduled', updated_at = ?
				WHERE status = 'failed' AND verification_outcome = 'rejected' AND verification_feedback IS NOT NULL AND candidate_result IS NOT NULL
				AND corrective_attempts < ? AND recovery_policy = 'safe_retry' AND idempotency_key IS NOT NULL AND execution_scope IS NOT NULL AND plan_id IS NOT NULL`)
				.run(now, budget).changes;
			for (const planId of planIds) this.syncTaskPlan(planId, "pending", now, true);
			return changed;
		})();
	}

	enqueueTaskPlanCompletionNotice(ownerKey: string, planId: string, now = Date.now()): boolean {
		if (!ownerKey.trim() || !planId.trim()) return false;
		const plan = this.db.prepare(`SELECT * FROM task_plans WHERE id = ? AND owner_key = ? AND status IN ('succeeded', 'failed', 'cancelled')`).get(planId, ownerKey) as TaskPlanRow | undefined;
		if (!plan) return false;
		const scopeRow = this.db.prepare("SELECT execution_scope FROM tasks WHERE plan_id = ? AND owner_key = ? AND execution_scope IS NOT NULL ORDER BY created_at LIMIT 1").get(planId, ownerKey) as { execution_scope: string } | undefined;
		const target = parseExecutionScope(scopeRow?.execution_scope ?? null);
		if (!target?.platform || !target.chatId) return false;
		const id = `${plan.id}:${plan.finished_at ?? now}:${plan.status}`;
		return this.db.prepare(`INSERT OR IGNORE INTO task_plan_completion_notices
			(id, plan_id, owner_key, platform, channel_instance_id, chat_id, chat_type, user_id, thread_id, plan_status, title, task_count, succeeded, failed, cancelled, status, attempts, next_attempt_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`)
			.run(id, plan.id, plan.owner_key, target.platform, target.channelInstanceId ?? null, target.chatId, target.chatType ?? null, target.userId ?? null, target.threadId ?? null, plan.status, plan.title, plan.task_count, plan.succeeded, plan.failed, plan.cancelled, now, now).changes === 1;
	}

	claimTaskPlanCompletionNotices(platform: string, now = Date.now(), limit = 10, leaseMs = 5 * 60_000): TaskPlanCompletionNotice[] {
		if (!platform.trim()) return [];
		return this.db.transaction(() => {
			const rows = this.db.prepare(`SELECT id FROM task_plan_completion_notices
				WHERE platform = ? AND (status = 'queued' OR status = 'delivering') AND next_attempt_at <= ?
				ORDER BY next_attempt_at, created_at LIMIT ?`).all(platform, now, limitOf(limit, 10)) as Array<{ id: string }>;
			for (const row of rows) this.db.prepare("UPDATE task_plan_completion_notices SET status = 'delivering', claim_token = ?, attempts = attempts + 1, next_attempt_at = ? WHERE id = ?").run(crypto.randomUUID(), now + Math.max(1, leaseMs), row.id);
			return rows.map((row) => mapTaskPlanCompletionNotice(this.db.prepare("SELECT * FROM task_plan_completion_notices WHERE id = ?").get(row.id) as TaskPlanCompletionNoticeRow));
		})();
	}

	completeTaskPlanCompletionNotice(id: string, claimToken: string): boolean {
		return this.db.prepare("UPDATE task_plan_completion_notices SET status = 'delivered', claim_token = NULL WHERE id = ? AND status = 'delivering' AND claim_token = ?").run(id, claimToken).changes === 1;
	}

	renewTaskPlanCompletionNotice(id: string, claimToken: string, leaseExpiresAt: number): boolean {
		return this.db.prepare("UPDATE task_plan_completion_notices SET next_attempt_at = ? WHERE id = ? AND status = 'delivering' AND claim_token = ?").run(leaseExpiresAt, id, claimToken).changes === 1;
	}

	abandonTaskPlanCompletionNotice(id: string, claimToken: string, error: string, now = Date.now()): boolean {
		return this.db.prepare("UPDATE task_plan_completion_notices SET status = 'delivered', claim_token = NULL, abandoned_at = ?, last_error = ? WHERE id = ? AND status = 'delivering' AND claim_token = ?")
			.run(now, redactCredentialMaterial(error).slice(0, 5_000), id, claimToken).changes === 1;
	}

	failTaskPlanCompletionNotice(id: string, claimToken: string, now = Date.now()): boolean {
		const row = this.db.prepare("SELECT attempts FROM task_plan_completion_notices WHERE id = ? AND status = 'delivering' AND claim_token = ?").get(id, claimToken) as { attempts: number } | undefined;
		if (!row) return false;
		const delay = Math.min(60 * 60_000, 30_000 * (2 ** Math.min(Math.max(0, row.attempts - 1), 7)));
		return this.db.prepare("UPDATE task_plan_completion_notices SET status = 'queued', claim_token = NULL, next_attempt_at = ? WHERE id = ? AND status = 'delivering' AND claim_token = ?").run(now + delay, id, claimToken).changes === 1;
	}

	deferTaskPlanCompletionNotice(id: string, claimToken: string, retryAt: number, now = Date.now()): boolean {
		const boundedRetryAt = Math.max(now + 1_000, Math.min(retryAt, now + 7 * 24 * 60 * 60_000));
		return this.db.prepare("UPDATE task_plan_completion_notices SET status = 'queued', attempts = MAX(0, attempts - 1), claim_token = NULL, next_attempt_at = ?, last_error = NULL WHERE id = ? AND status = 'delivering' AND claim_token = ?")
			.run(boundedRetryAt, id, claimToken).changes === 1;
	}

	prepareTaskPlanRetry(ownerKeys: string[], planId: string, maxCorrectiveAttempts = 1): number {
		if (!ownerKeys.length || !planId.trim()) return 0;
		const budget = Math.max(0, Math.min(Math.trunc(maxCorrectiveAttempts), 2));
		const changed = this.db.prepare(`UPDATE tasks SET status = 'pending', started_at = NULL, finished_at = NULL, result = NULL, candidate_result = CASE WHEN verification_outcome = 'rejected' THEN candidate_result ELSE NULL END, error = 'Manual Task Plan retry requested', updated_at = ?
			WHERE owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND plan_id = ? AND status = 'failed'
			AND COALESCE(verification_outcome, '') <> 'unavailable'
			AND (COALESCE(verification_outcome, '') <> 'rejected' OR corrective_attempts < ?)
			AND recovery_policy = 'safe_retry' AND idempotency_key IS NOT NULL AND execution_scope IS NOT NULL`)
			.run(Date.now(), ...ownerKeys, planId, budget).changes;
		if (changed) this.syncTaskPlan(planId, "pending");
		return changed;
	}

	cancelTaskPlan(ownerKeys: string[], planId: string, now = Date.now()): number {
		if (!ownerKeys.length || !planId.trim()) return 0;
		return this.db.transaction(() => {
			const ids = this.db.prepare(`SELECT id FROM tasks WHERE owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND plan_id = ? AND status IN ('pending', 'running')`).all(...ownerKeys, planId).map((row) => (row as { id: string }).id);
			if (!ids.length) return 0;
			const placeholders = ids.map(() => "?").join(", ");
			this.db.prepare(`UPDATE task_runs SET status = 'cancelled', finished_at = ?, error = 'Task Plan cancelled by user' WHERE task_id IN (${placeholders}) AND status = 'running'`).run(now, ...ids);
			const changed = this.db.prepare(`UPDATE tasks SET status = 'cancelled', finished_at = ?, error = 'Task Plan cancelled by user', updated_at = ? WHERE id IN (${placeholders}) AND status IN ('pending', 'running')`).run(now, now, ...ids).changes;
			if (changed) this.syncTaskPlan(planId, "cancelled", now);
			return changed;
		})();
	}

	failTaskPlan(ownerKeys: string[], planId: string, holderId: string, error: string, now = Date.now()): number {
		if (!ownerKeys.length || !planId.trim() || !holderId.trim()) return 0;
		return this.db.transaction(() => {
			const claim = this.db.prepare(`SELECT 1 FROM task_plan_execution_claims WHERE plan_id = ? AND owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND holder_id = ? AND lease_expires_at > ?`).get(planId, ...ownerKeys, holderId, now);
			if (!claim) return 0;
			const ids = this.db.prepare(`SELECT id FROM tasks WHERE owner_key IN (${ownerKeys.map(() => "?").join(", ")}) AND plan_id = ? AND status IN ('pending', 'running')`).all(...ownerKeys, planId).map((row) => (row as { id: string }).id);
			if (!ids.length) return 0;
			const placeholders = ids.map(() => "?").join(", ");
			const message = safeTaskText(error) ?? "Background Task Plan execution failed";
			this.db.prepare(`UPDATE task_runs SET status = 'failed', finished_at = ?, error = ? WHERE task_id IN (${placeholders}) AND status = 'running'`).run(now, message, ...ids);
			const changed = this.db.prepare(`UPDATE tasks SET status = 'failed', finished_at = ?, error = ?, updated_at = ? WHERE id IN (${placeholders}) AND status IN ('pending', 'running')`).run(now, message, now, ...ids).changes;
			if (changed) this.syncTaskPlan(planId, "failed", now);
			return changed;
		})();
	}

	private syncTaskPlanFromTasks(id: string, now: number): void {
		const statuses = this.db.prepare(`SELECT SUM(status = 'failed') AS failed, SUM(status = 'running') AS running,
			SUM(status = 'pending') AS pending, SUM(status = 'cancelled') AS cancelled FROM tasks WHERE plan_id = ?`).get(id) as { failed: number; running: number; pending: number; cancelled: number };
		const status: TaskPlanRecord["status"] = statuses.failed ? "failed" : statuses.running ? "running" : statuses.pending ? "pending" : statuses.cancelled ? "cancelled" : "succeeded";
		this.syncTaskPlan(id, status, now, status === "pending");
	}

	private syncTaskPlanAfterCandidateVerification(id: string, now: number): void {
		const counts = this.db.prepare(`SELECT COUNT(*) AS task_count, SUM(status = 'succeeded') AS succeeded, SUM(status = 'failed') AS failed,
			SUM(status = 'running') AS running, SUM(status = 'pending') AS pending, SUM(status = 'cancelled') AS cancelled,
			COALESCE(SUM(verification_outcome = 'accepted'), 0) AS verified, COALESCE(SUM(corrective_attempts), 0) AS corrective_attempts
			FROM tasks WHERE plan_id = ?`).get(id) as { task_count: number; succeeded: number; failed: number; running: number; pending: number; cancelled: number; verified: number; corrective_attempts: number };
		const status: TaskPlanRecord["status"] = counts.failed ? "failed" : counts.running ? "running" : counts.pending ? "pending" : counts.cancelled ? "cancelled" : "succeeded";
		this.db.prepare(`UPDATE task_plans SET status = ?, task_count = ?, succeeded = ?, failed = ?, cancelled = ?, verified = ?, corrective_attempts = ?,
			finished_at = CASE WHEN ? IN ('succeeded', 'failed', 'cancelled') THEN ? ELSE NULL END WHERE id = ? AND status IN ('running', 'failed')`)
			.run(status, counts.task_count, counts.succeeded, counts.failed, counts.cancelled, counts.verified, counts.corrective_attempts, status, now, id);
	}

	private syncTaskPlan(id: string, status: TaskPlanRecord["status"], now = Date.now(), reopenRunning = false): void {
		this.backfillTaskPlans(id);
		const counts = this.db.prepare(`SELECT COUNT(*) AS task_count, SUM(status = 'succeeded') AS succeeded, SUM(status = 'failed') AS failed,
			SUM(status = 'cancelled') AS cancelled, COALESCE(SUM(verification_outcome = 'accepted'), 0) AS verified,
			COALESCE(SUM(corrective_attempts), 0) AS corrective_attempts FROM tasks WHERE plan_id = ?`).get(id) as { task_count: number; succeeded: number; failed: number; cancelled: number; verified: number; corrective_attempts: number };
		const change: TaskPlanTransition = {
			status, taskCount: counts.task_count, succeeded: counts.succeeded, failed: counts.failed, cancelled: counts.cancelled,
			verified: counts.verified, correctiveAttempts: counts.corrective_attempts,
			...(status === "running" ? { startedAt: now } : {}), ...(["succeeded", "failed", "cancelled"].includes(status) ? { finishedAt: now } : {}),
		};
		if (status === "pending") {
			this.db.prepare(`UPDATE task_plans SET status = 'pending', task_count = ?, succeeded = ?, failed = ?, cancelled = ?, verified = ?, corrective_attempts = ?, finished_at = NULL
				WHERE id = ? AND status IN (${reopenRunning ? "'pending', 'running', 'failed'" : "'pending', 'failed'"})`).run(change.taskCount, change.succeeded, change.failed, change.cancelled, change.verified, change.correctiveAttempts, id);
		} else this.transitionPlan(id, change);
	}

	forget(id: string, opts: Omit<RecallOptions, "limit"> = {}): boolean {
		const conditions = ["id = ?", "role = 'memory'"];
		const params: unknown[] = [id];
		if (opts.platform) { conditions.push("platform = ?"); params.push(opts.platform); }
		if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
		if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
		if (opts.chatId) { conditions.push("thread_id IS ?"); params.push(opts.threadId ?? null); }
		return this.db.prepare(`DELETE FROM memories WHERE ${conditions.join(" AND ")}`).run(...params).changes > 0;
	}

	upsertInitiativeObservation(input: InitiativeObservationInput): { observation: InitiativeObservation; created: boolean } {
		this.assertInitiativeScope(input.scope);
		if (containsCredentialMaterial(JSON.stringify(input))) throw new Error("Initiative observation cannot contain credential material");
		if (!input.dedupeKey.trim() || input.dedupeKey.length > 256) throw new Error("Initiative observation dedupe key is invalid");
		if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) throw new Error("Initiative observation time is invalid");
		if (!Number.isFinite(input.expectedValue) || input.expectedValue < 0 || input.expectedValue > 1
			|| !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("Initiative observation scores must be between 0 and 1");
		if (!input.evidenceRefs.length || input.evidenceRefs.length > 100 || input.evidenceRefs.some((reference) => !reference.trim() || reference.length > 1_000)) throw new Error("Initiative observation evidence references are invalid");
		const normalizedSituation = createSituation(input.situation);
		const existing = this.db.prepare("SELECT id, platform, channel_instance_id, chat_id, user_id, thread_id FROM initiative_observations WHERE profile_id = ? AND dedupe_key = ?")
			.get(this.profileId, input.dedupeKey) as Pick<InitiativeObservationRow, "id" | "platform" | "channel_instance_id" | "chat_id" | "user_id" | "thread_id"> | undefined;
		if (existing) {
			if (existing.platform !== input.scope.platform || existing.channel_instance_id !== (input.scope.channelInstanceId ?? null) || existing.chat_id !== input.scope.chatId
				|| existing.user_id !== (input.scope.userId ?? null) || existing.thread_id !== (input.scope.threadId ?? null)) {
				throw new Error("Initiative observation dedupe key belongs to a different scope");
			}
			this.db.prepare(`UPDATE initiative_observations SET repeat_count = repeat_count + 1,
				last_observed_at = MAX(last_observed_at, ?), trigger_kind = ?, trigger_id = ?
				WHERE id = ?`).run(input.observedAt, input.triggerKind, input.triggerId, existing.id);
			return { observation: this.getInitiativeObservationRequired(existing.id), created: false };
		}
		const id = crypto.randomUUID();
		this.db.prepare(`INSERT INTO initiative_observations (
			id, profile_id, platform, channel_instance_id, chat_id, user_id, thread_id, dedupe_key, trigger_kind, trigger_id,
			situation, action, expected_value, risk, rationale, intended_verification, evidence_refs,
			confidence, mode, disposition, related_objective_id, notification_emitted, feedback,
			repeat_count, created_at, last_observed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observe_only', ?, ?, 0, 'unreviewed', 1, ?, ?)`)
			.run(id, this.profileId, input.scope.platform, input.scope.channelInstanceId ?? null, input.scope.chatId, input.scope.userId ?? null, input.scope.threadId ?? null,
				input.dedupeKey, input.triggerKind, input.triggerId, JSON.stringify(normalizedSituation), input.action, input.expectedValue,
				input.risk, input.rationale, input.intendedVerification, JSON.stringify(input.evidenceRefs), input.confidence,
				input.disposition, input.relatedObjectiveId ?? null, input.observedAt, input.observedAt);
		return { observation: this.getInitiativeObservationRequired(id), created: true };
	}

	listInitiativeObservations(scope: InitiativeScope, limit = 100): InitiativeObservation[] {
		this.assertInitiativeScope(scope);
		return (this.db.prepare(`SELECT * FROM initiative_observations WHERE profile_id = ? AND platform = ? AND channel_instance_id IS ? AND chat_id = ?
			AND user_id IS ? AND thread_id IS ? ORDER BY created_at DESC LIMIT ?`)
			.all(this.profileId, scope.platform, scope.channelInstanceId ?? null, scope.chatId, scope.userId ?? null, scope.threadId ?? null, Math.max(1, Math.min(500, limit))) as InitiativeObservationRow[])
			.map(mapInitiativeObservation);
	}

	reviewInitiativeObservation(id: string, scope: InitiativeScope, feedback: "accepted" | "rejected", now = Date.now()): boolean {
		this.assertInitiativeScope(scope);
		return this.db.prepare(`UPDATE initiative_observations SET feedback = ?, reviewed_at = ? WHERE id = ? AND profile_id = ?
			AND platform = ? AND channel_instance_id IS ? AND chat_id = ? AND user_id IS ? AND thread_id IS ?`)
			.run(feedback, now, id, this.profileId, scope.platform, scope.channelInstanceId ?? null, scope.chatId, scope.userId ?? null, scope.threadId ?? null).changes === 1;
	}

	pruneAmbientGroupObservations(scope: InitiativeScope, retain: number): number {
		this.assertInitiativeScope(scope);
		if (!Number.isSafeInteger(retain) || retain < 1 || retain > 10_000) throw new Error("Ambient group Observation retention must be between 1 and 10000");
		return this.db.prepare(`DELETE FROM initiative_observations WHERE id IN (
			SELECT id FROM initiative_observations WHERE profile_id = ? AND platform = ? AND channel_instance_id IS ? AND chat_id = ?
			AND user_id IS ? AND thread_id IS ? AND trigger_kind = 'message' AND trigger_id LIKE 'ambient-group:%'
			ORDER BY created_at DESC LIMIT -1 OFFSET ?
		)`).run(this.profileId, scope.platform, scope.channelInstanceId ?? null, scope.chatId, scope.userId ?? null, scope.threadId ?? null, retain).changes;
	}

	upsertBoundedAmbientGroupObservation(input: InitiativeObservationInput, retain: number): { observation: InitiativeObservation; created: boolean } {
		return this.db.transaction(() => {
			const persisted = this.upsertInitiativeObservation(input);
			this.pruneAmbientGroupObservations(input.scope, retain);
			return persisted;
		})();
	}

	initiativeEvaluation(scope: InitiativeScope): {
		observations: number; accepted: number; rejected: number; unreviewed: number; precision: number;
		averageExpectedValue: number; repeatTriggers: number; notificationsEmitted: number; interruptionRate: number;
	} {
		const observations = this.listInitiativeObservations(scope, 500);
		const accepted = observations.filter((item) => item.feedback === "accepted").length;
		const rejected = observations.filter((item) => item.feedback === "rejected").length;
		const unreviewed = observations.length - accepted - rejected;
		const reviewed = accepted + rejected;
		const notificationsEmitted = observations.filter((item) => item.notificationEmitted).length;
		return {
			observations: observations.length, accepted, rejected, unreviewed,
			precision: reviewed ? accepted / reviewed : 0,
			averageExpectedValue: observations.length ? observations.reduce((sum, item) => sum + item.expectedValue, 0) / observations.length : 0,
			repeatTriggers: observations.reduce((sum, item) => sum + Math.max(0, item.repeatCount - 1), 0),
			notificationsEmitted,
			interruptionRate: observations.length ? notificationsEmitted / observations.length : 0,
		};
	}

	enqueueInitiativeTrigger(input: DurableInitiativeTriggerInput): { trigger: DurableInitiativeTrigger; created: boolean } {
		if (input.profileId !== this.profileId || input.scope.profileId !== this.profileId) throw new Error("Initiative Trigger Profile does not own this Memory Store");
		this.assertInitiativeScope(input.scope);
		if (input.executionScope && (input.executionScope.platform !== input.scope.platform
			|| input.executionScope.channelInstanceId !== input.scope.channelInstanceId
			|| input.executionScope.chatId !== input.scope.chatId
			|| Boolean(input.scope.userId) && input.scope.userId !== (input.executionScope.userIdAlt ?? input.executionScope.userId)
			|| Boolean(input.scope.threadId) && input.scope.threadId !== input.executionScope.threadId)) {
			throw new Error("Initiative Trigger execution scope does not match its observation scope");
		}
		if (containsCredentialMaterial(JSON.stringify(input))) throw new Error("Initiative Trigger cannot contain credential material");
		const id = crypto.randomUUID();
		const inserted = this.db.prepare(`INSERT OR IGNORE INTO initiative_triggers (
			id, profile_id, kind, trigger_id, occurred_at, platform, channel_instance_id, chat_id, user_id, thread_id, prompt, evidence_ref,
			 notification_required, delivery_target, execution_scope, status, attempts, next_attempt_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`)
			.run(id, this.profileId, input.kind, input.triggerId, input.occurredAt, input.scope.platform, input.scope.channelInstanceId ?? null, input.scope.chatId,
				input.scope.userId ?? null, input.scope.threadId ?? null, input.prompt, input.evidenceRef,
				input.notificationRequired ? 1 : 0, input.deliveryTarget ? JSON.stringify(input.deliveryTarget) : null,
				input.executionScope ? JSON.stringify(input.executionScope) : null,
				input.occurredAt, input.occurredAt, input.occurredAt).changes === 1;
		if (inserted) return { trigger: this.getInitiativeTriggerRequired(id, this.profileId), created: true };
		const existing = this.db.prepare("SELECT * FROM initiative_triggers WHERE profile_id = ? AND kind = ? AND trigger_id = ?")
			.get(this.profileId, input.kind, input.triggerId) as InitiativeTriggerRow | undefined;
		if (!existing) throw new Error("Initiative Trigger idempotent insert could not be resolved");
		if (existing.platform !== input.scope.platform || existing.channel_instance_id !== (input.scope.channelInstanceId ?? null) || existing.chat_id !== input.scope.chatId
			|| existing.user_id !== (input.scope.userId ?? null) || existing.thread_id !== (input.scope.threadId ?? null)
			|| existing.evidence_ref !== input.evidenceRef || existing.prompt !== input.prompt
			|| existing.execution_scope !== (input.executionScope ? JSON.stringify(input.executionScope) : null)) {
			throw new Error("Initiative Trigger identity conflicts with a different payload or scope");
		}
		return { trigger: mapInitiativeTrigger(existing), created: false };
	}

	claimInitiativeTriggers(profileId: string, holderId: string, now: number, limit: number, leaseMs: number): DurableInitiativeTrigger[] {
		if (profileId !== this.profileId || !holderId.trim() || leaseMs <= 0) return [];
		return this.db.transaction(() => {
			const rows = this.db.prepare(`SELECT id FROM initiative_triggers WHERE profile_id = ? AND next_attempt_at <= ?
				AND (status = 'queued' OR (status = 'processing' AND claim_expires_at <= ?)) ORDER BY occurred_at ASC LIMIT ?`)
				.all(this.profileId, now, now, Math.max(1, Math.min(100, limit))) as Array<{ id: string }>;
			const claimed: DurableInitiativeTrigger[] = [];
			for (const row of rows) {
				const claimToken = crypto.randomUUID();
				const changed = this.db.prepare(`UPDATE initiative_triggers SET status = 'processing', attempts = attempts + 1,
					claim_token = ?, claim_holder = ?, claim_expires_at = ?, updated_at = ? WHERE id = ? AND profile_id = ?
					AND (status = 'queued' OR (status = 'processing' AND claim_expires_at <= ?))`)
					.run(claimToken, holderId, now + leaseMs, now, row.id, this.profileId, now).changes === 1;
				if (changed) claimed.push(this.getInitiativeTriggerRequired(row.id, this.profileId));
			}
			return claimed;
		})();
	}

	completeInitiativeTrigger(id: string, claimToken: string, outcome: { decision: "observed" | "ignored"; observationId?: string; notificationRequired: boolean }): boolean {
		const row = this.db.prepare("SELECT notification_required, delivery_target FROM initiative_triggers WHERE id = ? AND profile_id = ? AND status = 'processing' AND claim_token = ?")
			.get(id, this.profileId, claimToken) as { notification_required: number; delivery_target: string | null } | undefined;
		if (!row) return false;
		const notificationRequired = row.notification_required === 1;
		if (notificationRequired !== outcome.notificationRequired) return false;
		const status = notificationRequired ? row.delivery_target ? "notification_queued" : "awaiting_route" : "completed";
		return this.db.prepare(`UPDATE initiative_triggers SET status = ?, decision = ?, observation_id = ?, claim_token = NULL,
			claim_holder = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ? AND profile_id = ? AND status = 'processing' AND claim_token = ?`)
			.run(status, outcome.decision, outcome.observationId ?? null, Date.now(), id, this.profileId, claimToken).changes === 1;
	}

	failInitiativeTrigger(id: string, claimToken: string, now: number, error: string): boolean {
		const row = this.db.prepare("SELECT attempts FROM initiative_triggers WHERE id = ? AND profile_id = ? AND status = 'processing' AND claim_token = ?")
			.get(id, this.profileId, claimToken) as { attempts: number } | undefined;
		if (!row) return false;
		const delay = Math.min(60 * 60_000, 1_000 * 2 ** Math.min(Math.max(0, row.attempts - 1), 10));
		return this.db.prepare(`UPDATE initiative_triggers SET status = 'queued', next_attempt_at = ?, claim_token = NULL,
			claim_holder = NULL, claim_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND profile_id = ? AND claim_token = ?`)
			.run(now + delay, redactCredentialMaterial(error).slice(0, 5_000), now, id, this.profileId, claimToken).changes === 1;
	}

	getInitiativeTrigger(id: string, profileId: string): DurableInitiativeTrigger | undefined {
		if (profileId !== this.profileId) return undefined;
		const row = this.db.prepare("SELECT * FROM initiative_triggers WHERE id = ? AND profile_id = ?").get(id, this.profileId) as InitiativeTriggerRow | undefined;
		return row ? mapInitiativeTrigger(row) : undefined;
	}

	attachInitiativeTriggerRoute(id: string, profileId: string, target: DeliveryTarget, now = Date.now()): boolean {
		if (profileId !== this.profileId || !target.platform?.trim() || !target.chatId?.trim() || containsCredentialMaterial(JSON.stringify(target))) return false;
		return this.db.prepare(`UPDATE initiative_triggers SET delivery_target = ?, status = 'notification_queued', updated_at = ?
			WHERE id = ? AND profile_id = ? AND status = 'awaiting_route' AND notification_required = 1`)
			.run(JSON.stringify(target), now, id, this.profileId).changes === 1;
	}

	emergencyStop(scopeId: string): EmergencyStopRecord {
		const scope = reversibleControlText(scopeId, "scope", 500);
		const row = this.db.prepare("SELECT * FROM proactive_mutation_controls WHERE profile_id = ? AND scope_id = ?")
			.get(this.profileId, scope) as { scope_id: string; status: EmergencyStopRecord["status"]; revision: number; changed_at: number; publisher_id: string; evidence_ref: string } | undefined;
		return row ? { scopeId: row.scope_id, status: row.status, revision: row.revision, changedAt: row.changed_at, publisherId: row.publisher_id, evidenceRef: row.evidence_ref }
			: { scopeId: scope, status: "stopped", revision: 0, changedAt: 0 };
	}

	setEmergencyStop(input: { scopeId: string; status: EmergencyStopRecord["status"]; expectedRevision: number; publisher: EnterprisePolicyPublisher; evidenceRef: string; changedAt: number }): boolean {
		const scopeId = reversibleControlText(input.scopeId, "scope", 500);
		const evidenceRef = reversibleControlText(input.evidenceRef, "evidence reference", 1_000);
		const publisherId = trustedControlPublisher(input.publisher);
		if (input.status !== "running" && input.status !== "stopped") throw new Error("Reversible Action Emergency Stop status is invalid");
		if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Reversible Action Emergency Stop revision is invalid");
		if (!Number.isSafeInteger(input.changedAt) || input.changedAt < 0) throw new Error("Reversible Action Emergency Stop time is invalid");
		if (containsCredentialMaterial(JSON.stringify(input))) throw new Error("Reversible Action control cannot contain credential material");
		return this.db.transaction(() => {
			if (input.expectedRevision === 0) {
				const inserted = this.db.prepare(`INSERT OR IGNORE INTO proactive_mutation_controls
					(profile_id, scope_id, status, revision, changed_at, publisher_id, evidence_ref) VALUES (?, ?, ?, 1, ?, ?, ?)`)
					.run(this.profileId, scopeId, input.status, input.changedAt, publisherId, evidenceRef).changes === 1;
				if (inserted) return true;
			}
			return this.db.prepare(`UPDATE proactive_mutation_controls SET status = ?, revision = revision + 1, changed_at = ?, publisher_id = ?, evidence_ref = ?
				WHERE profile_id = ? AND scope_id = ? AND revision = ? AND changed_at <= ?`)
				.run(input.status, input.changedAt, publisherId, evidenceRef, this.profileId, scopeId, input.expectedRevision, input.changedAt).changes === 1;
		})();
	}

	recordCompensationExercise(input: { scopeId: string; forwardCapability: string; proof: CompensationProof; publisher: EnterprisePolicyPublisher }): boolean {
		const scopeId = reversibleControlText(input.scopeId, "scope", 500);
		const forwardCapability = reversibleControlText(input.forwardCapability, "forward capability", 128);
		const proof = normalizeCompensationProof(input.proof);
		const publisherId = trustedControlPublisher(input.publisher);
		if (containsCredentialMaterial(JSON.stringify(input))) throw new Error("Compensation exercise cannot contain credential material");
		const encodedEvidence = JSON.stringify(proof.evidenceRefs);
		const inserted = this.db.prepare(`INSERT OR IGNORE INTO compensation_exercises
			(id, profile_id, scope_id, forward_capability, compensation_capability, receipt_proof_provider, exercised_at, valid_until, evidence_refs, publisher_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(proof.id, this.profileId, scopeId, forwardCapability, proof.capability, proof.receiptProofProvider ?? null,
				proof.exercisedAt, proof.validUntil, encodedEvidence, publisherId, Date.now()).changes === 1;
		if (inserted) return true;
		const existing = this.db.prepare("SELECT * FROM compensation_exercises WHERE profile_id = ? AND id = ?").get(this.profileId, proof.id) as CompensationExerciseRow | undefined;
		if (!existing || existing.profile_id !== this.profileId || existing.scope_id !== scopeId || existing.forward_capability !== forwardCapability
			|| existing.compensation_capability !== proof.capability || existing.receipt_proof_provider !== (proof.receiptProofProvider ?? null)
			|| existing.exercised_at !== proof.exercisedAt || existing.valid_until !== proof.validUntil || existing.evidence_refs !== encodedEvidence
			|| existing.publisher_id !== publisherId) throw new Error("Compensation exercise identity conflicts with different evidence");
		return false;
	}

	compensationProof(scopeId: string, forwardCapability: string, at: number): CompensationProof | undefined {
		const scope = reversibleControlText(scopeId, "scope", 500);
		const capability = reversibleControlText(forwardCapability, "forward capability", 128);
		if (!Number.isSafeInteger(at) || at < 0) throw new Error("Compensation proof time is invalid");
		const row = this.db.prepare(`SELECT * FROM compensation_exercises WHERE profile_id = ? AND scope_id = ? AND forward_capability = ?
			AND exercised_at <= ? AND valid_until >= ? ORDER BY exercised_at DESC, created_at DESC LIMIT 1`)
			.get(this.profileId, scope, capability, at, at) as CompensationExerciseRow | undefined;
		return row ? mapCompensationProof(row) : undefined;
	}

	read(level: AutonomyLevel): AutonomyRolloutRecord | undefined {
		assertAutonomyLevel(level);
		const row = this.db.prepare("SELECT * FROM autonomy_rollout_states WHERE profile_id = ? AND level = ?")
			.get(this.profileId, level) as AutonomyRolloutRow | undefined;
		if (!row) return undefined;
		return {
			level: row.level,
			status: row.status,
			revision: row.revision,
			updatedAt: row.updated_at,
			authority: row.actor === "enterprise"
				? { actor: "enterprise", publisher: parseEnterprisePublisher(row.publisher), evidenceRef: row.evidence_ref, ...(row.enterprise_disposition ? { enterpriseDisposition: row.enterprise_disposition } : {}) }
				: { actor: "operator", evidenceRef: row.evidence_ref },
			reasons: parseStringArray(row.reasons, "autonomy rollout reasons"),
			evidence: row.evidence ? parseAutonomyEvidence(row.evidence) : undefined,
		};
	}

	write(record: AutonomyRolloutRecord): void {
		assertAutonomyRolloutRecord(record);
		const reasons = JSON.stringify(record.reasons);
		const evidence = record.evidence ? JSON.stringify(record.evidence) : null;
		const disposition = record.authority.actor === "enterprise" ? record.authority.enterpriseDisposition ?? null : null;
		const publisher = record.authority.actor === "enterprise" ? JSON.stringify(record.authority.publisher) : null;
		const changed = this.db.transaction(() => {
			if (record.revision === 1) {
				const inserted = this.db.prepare(`INSERT OR IGNORE INTO autonomy_rollout_states
					(profile_id, level, status, revision, updated_at, actor, publisher, evidence_ref, enterprise_disposition, reasons, evidence)
					VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(this.profileId, record.level, record.status, record.updatedAt,
					record.authority.actor, publisher, record.authority.evidenceRef, disposition, reasons, evidence).changes;
				if (inserted === 1) return true;
			}
			return this.db.prepare(`UPDATE autonomy_rollout_states SET status = ?, revision = ?, updated_at = ?, actor = ?, publisher = ?,
				evidence_ref = ?, enterprise_disposition = ?, reasons = ?, evidence = ?
				WHERE profile_id = ? AND level = ? AND revision = ? AND updated_at <= ?`)
				.run(record.status, record.revision, record.updatedAt, record.authority.actor, publisher, record.authority.evidenceRef,
					disposition, reasons, evidence, this.profileId, record.level, record.revision - 1, record.updatedAt).changes === 1;
		})();
		if (!changed) throw new Error(`Stale autonomy rollout write for ${record.level}`);
	}

	private getInitiativeTriggerRequired(id: string, profileId: string): DurableInitiativeTrigger {
		const trigger = this.getInitiativeTrigger(id, profileId);
		if (!trigger) throw new Error(`Initiative Trigger ${id} disappeared`);
		return trigger;
	}

	private getInitiativeObservationRequired(id: string): InitiativeObservation {
		const row = this.db.prepare("SELECT * FROM initiative_observations WHERE id = ?").get(id) as InitiativeObservationRow | undefined;
		if (!row) throw new Error(`Initiative observation ${id} disappeared`);
		return mapInitiativeObservation(row);
	}

	private assertInitiativeScope(scope: InitiativeScope): void {
		if (scope.profileId !== this.profileId) throw new Error("Initiative observation Profile does not own this Memory Store");
		if (!scope.platform?.trim() || !scope.chatId?.trim()) throw new Error("Initiative observation requires platform and chat scope");
	}

	close(): void {
		this.db.close();
	}

}

export type OrganizationMemoryPort = Pick<MemoryStore, "upsertEpisode" | "episodeForObjective" | "listEpisodes" | "recallEpisodes" | "recallOrganizationKnowledge" | "upsertConventionCandidate" | "getConventionCandidate" | "listConventionCandidates" | "confirmConventionCandidate" | "rejectConventionCandidate" | "supersedeConventionCandidate" | "rollbackConventionCandidate" | "explainConventionCandidate" | "upsertWorkflowCandidate" | "getWorkflowCandidate" | "listWorkflowCandidates" | "editWorkflowCandidate" | "rejectWorkflowCandidate" | "supersedeWorkflowCandidate" | "archiveWorkflowCandidate" | "explainWorkflowCandidate" | "stageWorkflowSkillCandidate" | "authorizeWorkflowSkillPromotion" | "upsertClaim" | "recordException" | "markClaimsConflicted" | "correctClaim" | "revokeClaim" | "forgetClaim" | "listClaims" | "recallBrief" | "explainClaim">;
export type InitiativeObservationPort = InitiativeObservationStore & Pick<MemoryStore, "listInitiativeObservations" | "reviewInitiativeObservation" | "initiativeEvaluation">;
export type InitiativeTriggerInboxPort = InitiativeTriggerInbox & Pick<MemoryStore, "getInitiativeTrigger" | "attachInitiativeTriggerRoute">;
export type ReversibleActionControls = ReversibleActionControlPort;
export type AutonomyRolloutStore = AutonomyRolloutStateStore;
export type ConversationMemoryStore = ConversationMemoryPort;
export type DurableTaskLedger = TaskLedger;
export type TaskRecoveryQueue = Pick<TaskLedger, "reconcileExpiredTaskRuns" | "recoveryCandidates" | "verificationCandidates" | "deferCandidateVerification" | "resolveCandidateVerification" | "prepareTaskCorrections" | "prepareTaskPlanRetry">;
export type CompletionOutbox = TaskPlanNoticeOutbox;
export interface MemoryPersistencePorts {
	organizationMemory: OrganizationMemoryPort;
	conversationMemory: ConversationMemoryStore;
	taskLedger: DurableTaskLedger;
	recoveryQueue: TaskRecoveryQueue;
	completionOutbox: CompletionOutbox;
	initiativeObservations: InitiativeObservationPort;
	initiativeTriggerInbox: InitiativeTriggerInboxPort;
	reversibleActionControls: ReversibleActionControls;
	autonomyRollout: AutonomyRolloutStore;
}

/** Typed capability views over one SQLite authority; no wrapper owns state. */
export function memoryPersistencePorts(store: MemoryStore): MemoryPersistencePorts {
	return { organizationMemory: store, conversationMemory: store, taskLedger: store, recoveryQueue: store, completionOutbox: store, initiativeObservations: store, initiativeTriggerInbox: store, reversibleActionControls: store, autonomyRollout: store };
}

export async function backupSqliteDatabase(sourcePath: string, destinationPath: string): Promise<void> {
	const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
	try {
		await db.backup(destinationPath);
	} finally {
		db.close();
	}
}

export function verifySqliteDatabase(path: string): void {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const result = db.pragma("integrity_check", { simple: true });
		if (result !== "ok") throw new Error(`SQLite integrity check failed: ${String(result)}`);
	} finally {
		db.close();
	}
}

interface AutonomyRolloutRow {
	level: AutonomyLevel;
	status: AutonomyRolloutRecord["status"];
	revision: number;
	updated_at: number;
	actor: AutonomyRolloutRecord["authority"]["actor"];
	publisher: string | null;
	evidence_ref: string;
	enterprise_disposition: "allow" | "deny" | null;
	reasons: string;
	evidence: string | null;
}

function assertAutonomyLevel(level: string): asserts level is AutonomyLevel {
	if (!(AUTONOMY_LEVELS as readonly string[]).includes(level)) throw new Error(`Unknown autonomy level: ${level}`);
}

function parseStringArray(encoded: string, label: string): string[] {
	try {
		const value = JSON.parse(encoded) as unknown;
		if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
	} catch { /* reported below */ }
	throw new Error(`Stored ${label} is invalid`);
}

function parseAutonomyEvidence(encoded: string): AutonomyRolloutEvidence {
	try {
		const value = JSON.parse(encoded) as unknown;
		if (validAutonomyEvidence(value)) return value;
	} catch { /* reported below */ }
	throw new Error("Stored autonomy rollout evidence is invalid");
}

function parseEnterprisePublisher(encoded: string | null): EnterprisePolicyPublisher {
	if (!encoded) throw new Error("Stored enterprise autonomy authority is missing its publisher");
	try {
		const value = JSON.parse(encoded) as EnterprisePolicyPublisher;
		return createEnterprisePolicyPublisher({ id: value.id, authority: value.authority, ...(value.evidenceRef ? { evidenceRef: value.evidenceRef } : {}), issuedAt: value.issuedAt });
	} catch { throw new Error("Stored enterprise autonomy publisher is invalid"); }
}

const autonomyEvidenceKeys: readonly (keyof AutonomyRolloutEvidence)[] = [
	"situationPrecision", "correctionRetention", "unauthorizedRetrievals", "verifiedCompletionRate",
	"initiativePrecision", "initiativeAverageExpectedValue", "duplicateInitiatives", "initiativeInterruptionRate",
	"readOnlyPrecision", "readOnlyAdoptionRate", "readOnlyInterruptionRate", "duplicateReadOnlyObjectives",
	"proactivePolicyScopeCoverage", "emergencyStopBlockRate", "compensationSuccessRate", "duplicateCompensations",
	"highRiskAutonomousActions", "irreversibleAutonomousActions",
];

function validAutonomyEvidence(value: unknown): value is AutonomyRolloutEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === autonomyEvidenceKeys.length
		&& autonomyEvidenceKeys.every((key) => typeof record[key] === "number" && Number.isFinite(record[key]));
}

function assertAutonomyRolloutRecord(record: AutonomyRolloutRecord): void {
	assertAutonomyLevel(record.level);
	if (record.status !== "disabled" && record.status !== "enabled" && record.status !== "stopped") throw new Error("Autonomy rollout status is invalid");
	if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error("Autonomy rollout revision is invalid");
	if (!Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) throw new Error("Autonomy rollout time is invalid");
	if (record.authority.actor !== "operator" && record.authority.actor !== "enterprise") throw new Error("Autonomy rollout actor is invalid");
	if (!record.authority.evidenceRef.trim() || record.authority.evidenceRef.length > 1_000) throw new Error("Autonomy rollout evidence reference is invalid");
	if (record.authority.actor === "enterprise") {
		if (record.authority.enterpriseDisposition && record.authority.enterpriseDisposition !== "allow" && record.authority.enterpriseDisposition !== "deny") throw new Error("Autonomy rollout enterprise disposition is invalid");
		createEnterprisePolicyPublisher({ id: record.authority.publisher.id, authority: record.authority.publisher.authority, ...(record.authority.publisher.evidenceRef ? { evidenceRef: record.authority.publisher.evidenceRef } : {}), issuedAt: record.authority.publisher.issuedAt });
	}
	if (!Array.isArray(record.reasons) || !record.reasons.every((reason) => typeof reason === "string" && reason.length <= 1_000)) throw new Error("Autonomy rollout reasons are invalid");
	if (record.evidence && !validAutonomyEvidence(record.evidence)) throw new Error("Autonomy rollout evidence is invalid");
	if (containsCredentialMaterial(JSON.stringify(record))) throw new Error("Autonomy rollout state cannot contain credential material");
}

interface MemoryRow {
	id: string;
	platform: string;
	chat_id: string;
	user_id: string | null;
	thread_id: string | null;
	subject_type?: string | null;
	subject_id?: string | null;
	object_type?: string | null;
	object_id?: string | null;
	role: string;
	content: string;
	created_at: number;
}

interface CandidateRow extends MemoryRow { status: MemoryCandidate["status"] }

interface TaskRow {
	id: string;
	title: string;
	status: string;
	evidence: string | null;
	completed_at: number | null;
	updated_at: number;
}

interface ClaimRow {
	id: string;
	profile_id: string;
	platform: string;
	chat_id: string;
	user_id: string | null;
	thread_id: string | null;
	project_id: string | null;
	organization_id: string | null;
	kind: MemoryClaim["kind"];
	statement: string;
	subject_type: string | null;
	subject_id: string | null;
	object_type: string | null;
	object_id: string | null;
	source_type: NonNullable<MemoryClaim["source"]>["type"] | null;
	source_ref: string | null;
	visibility: MemoryClaim["visibility"];
	valid_from: number | null;
	valid_until: number | null;
	confidence: number;
	stability: MemoryClaim["stability"];
	status: MemoryClaim["status"];
	superseded_by: string | null;
	first_observed_at: number;
	last_confirmed_at: number;
	expires_at: number | null;
	created_at: number;
	updated_at: number;
}

interface EpisodeRow {
	id: string; profile_id: string; platform: string; chat_id: string; user_id: string | null; thread_id: string | null;
	objective_id: string; situation: string; situation_summary: string; action: string; outcome: string; evidence: string | null;
	status: OrganizationMemoryEpisodeStatus; created_at: number; updated_at: number;
}

interface ConventionCandidateRow {
	id: string; profile_id: string; platform: string; chat_id: string; user_id: string | null; thread_id: string | null;
	statement: string; rationale: string; confidence: number; promotion_blocked: number; observed_from: number; observed_until: number;
	status: ConventionCandidateStatus; superseded_by: string | null; created_at: number; updated_at: number;
}

interface ConventionCandidateEventRow {
	id: string; candidate_id: string; kind: ConventionCandidateEvent["kind"]; excerpt: string; source_ref: string | null; created_at: number;
}

interface WorkflowCandidateRow {
	id: string; profile_id: string; platform: string; chat_id: string; user_id: string | null; thread_id: string | null;
	title: string; summary: string; conditions: string; exceptions: string; inputs: string; instructions: string; expected_outcomes: string; verification: string;
	status: WorkflowCandidateStatus; revision: number; superseded_by: string | null; created_at: number; updated_at: number;
}

interface WorkflowCandidateEventRow { id: string; candidate_id: string; kind: WorkflowCandidateEvent["kind"]; excerpt: string; source_ref: string | null; created_at: number; }

interface InitiativeObservationRow {
	id: string; profile_id: string; platform: string; channel_instance_id: string | null; chat_id: string; user_id: string | null; thread_id: string | null;
	dedupe_key: string; trigger_kind: InitiativeObservation["triggerKind"]; trigger_id: string; situation: string; action: string;
	expected_value: number; risk: InitiativeObservation["risk"]; rationale: string; intended_verification: string; evidence_refs: string;
	confidence: number; mode: "observe_only"; disposition: InitiativeObservation["disposition"]; related_objective_id: string | null;
	notification_emitted: number; feedback: InitiativeObservation["feedback"]; repeat_count: number; created_at: number; last_observed_at: number;
}

interface InitiativeTriggerRow {
	id: string; profile_id: string; kind: DurableInitiativeTrigger["kind"]; trigger_id: string; occurred_at: number;
	platform: string; channel_instance_id: string | null; chat_id: string; user_id: string | null; thread_id: string | null; prompt: string; evidence_ref: string;
	notification_required: number; delivery_target: string | null; execution_scope: string | null; status: DurableInitiativeTrigger["status"]; attempts: number;
	next_attempt_at: number; claim_token: string | null; claim_holder: string | null; claim_expires_at: number | null;
	observation_id: string | null; decision: DurableInitiativeTrigger["decision"] | null; created_at: number;
}

interface CompensationExerciseRow {
	id: string; profile_id: string; scope_id: string; forward_capability: string; compensation_capability: string;
	receipt_proof_provider: string | null; exercised_at: number; valid_until: number; evidence_refs: string; publisher_id: string; created_at: number;
}

interface EvidenceRow {
	id: string;
	claim_id: string;
	event_id: string | null;
	source_ref: string | null;
	kind: MemoryEvidence["kind"];
	excerpt: string;
	created_at: number;
	event_id_value: string | null;
	event_platform: string | null;
	event_chat_id: string | null;
	event_user_id: string | null;
	event_kind: MemoryEvent["kind"] | null;
	event_content: string | null;
	event_occurred_at: number | null;
	event_created_at: number | null;
}

interface EventRow {
	id: string;
	platform: string;
	chat_id: string;
	user_id: string | null;
	thread_id: string | null;
	kind: MemoryEvent["kind"];
	content: string;
	occurred_at: number;
	created_at: number;
}

interface RuntimeTaskRow {
	id: string; owner_key: string; kind: RuntimeTaskRecord["kind"]; title: string; description: string | null; acceptance_criteria: string | null; recovery_policy: RuntimeTaskRecord["recoveryPolicy"]; idempotency_key: string | null; execution_scope: string | null; situation: string | null; access_scope_ref: string | null; business_context: string | null; status: RuntimeTaskRecord["status"];
	parent_id: string | null; plan_id: string | null; evidence: string | null; artifacts: string | null; unresolved_issues: string | null; verification_outcome: RuntimeTaskRecord["verificationStatus"] | null; verification_feedback: string | null; verification_requirements: string | null; criterion_verifications: string | null; verification_attempts: number; verification_retry_at: number | null; corrective_attempts: number; created_at: number; started_at: number | null; finished_at: number | null; result: string | null; candidate_result: string | null; error: string | null;
	checkpoint: string | null; checkpoint_at: number | null; routes: string | null; route_index: number; effect_receipts: string | null;
}

interface TaskRunRow {
	id: string; task_id: string; executor: TaskRunRecord["executor"]; status: TaskRunRecord["status"];
	started_at: number; lease_expires_at: number | null; finished_at: number | null; output: string | null; error: string | null;
}

interface TaskPlanRow {
	id: string; owner_key: string; title: string; status: TaskPlanRecord["status"];
	task_count: number; succeeded: number; failed: number; cancelled: number; verified: number; corrective_attempts: number;
	created_at: number; started_at: number | null; finished_at: number | null;
	paused_at: number | null;
}

interface TaskPlanCompletionNoticeRow {
	id: string; plan_id: string; owner_key: string; platform: string; channel_instance_id: string | null; chat_id: string; chat_type: string | null; user_id: string | null; thread_id: string | null;
	plan_status: TaskPlanCompletionNotice["planStatus"]; title: string; task_count: number; succeeded: number; failed: number; cancelled: number;
	status: Exclude<TaskPlanCompletionNotice["status"], "abandoned">; claim_token: string | null; attempts: number; next_attempt_at: number; created_at: number; abandoned_at: number | null; last_error: string | null;
}

function validChatType(value: string | null): DeliveryTarget["chatType"] {
	return value === "dm" || value === "group" || value === "channel" || value === "thread" ? value : undefined;
}

function mapRow(row: MemoryRow): MemoryRecord {
	return {
		id: row.id,
		platform: row.platform,
		chatId: row.chat_id,
		userId: row.user_id ?? undefined,
		threadId: row.thread_id ?? undefined,
		role: row.role as MemoryRecord["role"],
		content: row.content,
		createdAt: row.created_at,
		...(row.subject_type && row.subject_id ? { subject: { type: row.subject_type, id: row.subject_id } } : {}),
		...(row.object_type && row.object_id ? { object: { type: row.object_type, id: row.object_id } } : {}),
	};
}

function mapCandidate(row: CandidateRow): MemoryCandidate {
	return { ...mapRow(row), status: row.status };
}

function mapClaim(row: ClaimRow): MemoryClaim {
	return {
		id: row.id, profileId: row.profile_id, platform: row.platform, chatId: row.chat_id, userId: row.user_id ?? undefined, threadId: row.thread_id ?? undefined,
		projectId: row.project_id ?? undefined, organizationId: row.organization_id ?? undefined,
		kind: row.kind, statement: row.statement, confidence: row.confidence, stability: row.stability,
		subject: row.subject_type && row.subject_id ? { type: row.subject_type, id: row.subject_id } : undefined,
		object: row.object_type && row.object_id ? { type: row.object_type, id: row.object_id } : undefined,
		source: row.source_type ? { type: row.source_type, ...(row.source_ref ? { ref: row.source_ref } : {}) } : undefined,
		visibility: row.visibility, validFrom: row.valid_from ?? undefined, validUntil: row.valid_until ?? undefined, conflictsWith: [],
		status: row.status, supersededBy: row.superseded_by ?? undefined, firstObservedAt: row.first_observed_at, lastConfirmedAt: row.last_confirmed_at,
		expiresAt: row.expires_at ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

function mapEpisode(row: EpisodeRow): OrganizationMemoryEpisode {
	const situation = parseSituation(row.situation);
	if (!situation) throw new Error(`Organization Memory Episode ${row.id} has an invalid Situation`);
	return {
		id: row.id, profileId: row.profile_id, platform: row.platform, chatId: row.chat_id,
		...(row.user_id ? { userId: row.user_id } : {}), ...(row.thread_id ? { threadId: row.thread_id } : {}),
		objectiveId: row.objective_id, situation, action: row.action, outcome: row.outcome,
		...(row.evidence ? { evidence: row.evidence } : {}), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

function mapConventionEvent(row: ConventionCandidateEventRow): ConventionCandidateEvent {
	return { id: row.id, candidateId: row.candidate_id, kind: row.kind, excerpt: row.excerpt, ...(row.source_ref ? { sourceRef: row.source_ref } : {}), createdAt: row.created_at };
}

function mapWorkflowEvent(row: WorkflowCandidateEventRow): WorkflowCandidateEvent {
	return { id: row.id, candidateId: row.candidate_id, kind: row.kind, excerpt: row.excerpt, ...(row.source_ref ? { sourceRef: row.source_ref } : {}), createdAt: row.created_at };
}

function mapInitiativeObservation(row: InitiativeObservationRow): InitiativeObservation {
	const situation = parseSituation(row.situation);
	if (!situation) throw new Error(`Initiative observation ${row.id} has an invalid Situation`);
	const evidenceRefs = JSON.parse(row.evidence_refs) as unknown;
	if (!Array.isArray(evidenceRefs) || evidenceRefs.some((item) => typeof item !== "string")) throw new Error(`Initiative observation ${row.id} has invalid evidence references`);
	return {
		id: row.id, dedupeKey: row.dedupe_key, triggerKind: row.trigger_kind, triggerId: row.trigger_id,
		scope: { profileId: row.profile_id, platform: row.platform, ...(row.channel_instance_id ? { channelInstanceId: row.channel_instance_id } : {}), chatId: row.chat_id, ...(row.user_id ? { userId: row.user_id } : {}), ...(row.thread_id ? { threadId: row.thread_id } : {}) },
		situation, action: row.action, expectedValue: row.expected_value, risk: row.risk, rationale: row.rationale,
		intendedVerification: row.intended_verification, evidenceRefs, confidence: row.confidence, mode: row.mode,
		disposition: row.disposition, ...(row.related_objective_id ? { relatedObjectiveId: row.related_objective_id } : {}),
		notificationEmitted: false, feedback: row.feedback, repeatCount: row.repeat_count,
		observedAt: row.last_observed_at, createdAt: row.created_at, lastObservedAt: row.last_observed_at,
	};
}

function mapInitiativeTrigger(row: InitiativeTriggerRow): DurableInitiativeTrigger {
	let deliveryTarget: DeliveryTarget | undefined;
	if (row.delivery_target) {
		try {
			const parsed = JSON.parse(row.delivery_target) as DeliveryTarget;
			if (parsed && typeof parsed.platform === "string" && typeof parsed.chatId === "string") deliveryTarget = parsed;
		} catch { /* invalid optional route stays unavailable */ }
	}
	const executionScope = parseExecutionScope(row.execution_scope);
	return {
		id: row.id, profileId: row.profile_id, kind: row.kind, triggerId: row.trigger_id, occurredAt: row.occurred_at,
		scope: { profileId: row.profile_id, platform: row.platform, ...(row.channel_instance_id ? { channelInstanceId: row.channel_instance_id } : {}), chatId: row.chat_id, ...(row.user_id ? { userId: row.user_id } : {}), ...(row.thread_id ? { threadId: row.thread_id } : {}) },
		prompt: row.prompt, evidenceRef: row.evidence_ref, notificationRequired: row.notification_required === 1,
		...(deliveryTarget ? { deliveryTarget } : {}), ...(executionScope ? { executionScope } : {}), status: row.status, attempts: row.attempts, nextAttemptAt: row.next_attempt_at,
		...(row.claim_token ? { claimToken: row.claim_token } : {}), ...(row.claim_expires_at === null ? {} : { claimExpiresAt: row.claim_expires_at }),
		...(row.observation_id ? { observationId: row.observation_id } : {}), ...(row.decision ? { decision: row.decision } : {}), createdAt: row.created_at,
	};
}

function mapCompensationProof(row: CompensationExerciseRow): CompensationProof {
	const evidenceRefs = JSON.parse(row.evidence_refs) as unknown;
	if (!Array.isArray(evidenceRefs) || evidenceRefs.some((item) => typeof item !== "string")) throw new Error(`Compensation exercise ${row.id} has invalid evidence`);
	return {
		id: row.id,
		capability: row.compensation_capability,
		...(row.receipt_proof_provider ? { receiptProofProvider: row.receipt_proof_provider } : {}),
		exercisedAt: row.exercised_at,
		validUntil: row.valid_until,
		evidenceRefs,
	};
}

function mapEvidence(row: EvidenceRow): MemoryEvidence {
	const event = row.event_id_value && row.event_platform && row.event_chat_id && row.event_kind && row.event_content && row.event_occurred_at && row.event_created_at
		? { id: row.event_id_value, platform: row.event_platform, chatId: row.event_chat_id, userId: row.event_user_id ?? undefined, kind: row.event_kind, content: row.event_content, occurredAt: row.event_occurred_at, createdAt: row.event_created_at }
		: undefined;
	return { id: row.id, claimId: row.claim_id, eventId: row.event_id ?? undefined, sourceRef: row.source_ref ?? undefined, kind: row.kind, excerpt: row.excerpt, createdAt: row.created_at, event };
}

function mapEvent(row: EventRow): MemoryEvent {
	return { id: row.id, platform: row.platform, chatId: row.chat_id, userId: row.user_id ?? undefined, threadId: row.thread_id ?? undefined, kind: row.kind, content: row.content, occurredAt: row.occurred_at, createdAt: row.created_at };
}

function mapRuntimeTask(row: RuntimeTaskRow): RuntimeTaskRecord {
	const executionScope = parseExecutionScope(row.execution_scope);
	const situation = parseSituation(row.situation);
	const accessScopeRef = parseAccessScopeRef(row.access_scope_ref);
	const businessContext = parseBusinessContext(row.business_context);
	const artifacts = parseTaskArtifacts(row.artifacts);
	const unresolvedIssues = parseUnresolvedIssues(row.unresolved_issues);
	const verificationRequirements = parseVerificationRequirements(row.verification_requirements);
	const criterionVerifications = parseCriterionVerifications(row.criterion_verifications);
	return {
		id: row.id, ownerKey: row.owner_key, kind: row.kind, title: row.title, status: row.status,
		createdAt: row.created_at,
		...(row.description === null ? {} : { description: row.description }),
		...(row.acceptance_criteria === null ? {} : { acceptanceCriteria: row.acceptance_criteria }),
		...(row.recovery_policy === "never" || row.recovery_policy === undefined ? {} : { recoveryPolicy: row.recovery_policy }),
		...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
		...(executionScope ? { executionScope } : {}),
		...(situation ? { situation } : {}),
		...(accessScopeRef ? { accessScopeRef } : {}),
		...(businessContext ? { businessContext } : {}),
		...(row.parent_id === null ? {} : { parentId: row.parent_id }),
		...(row.plan_id === null ? {} : { planId: row.plan_id }),
		...(row.evidence === null ? {} : { evidence: row.evidence }),
		...(artifacts ? { artifacts } : {}),
		...(unresolvedIssues ? { unresolvedIssues } : {}),
		...(row.verification_outcome === null ? {} : { verificationStatus: row.verification_outcome }),
		...(row.verification_feedback === null ? {} : { verificationFeedback: row.verification_feedback }),
		...(verificationRequirements ? { verificationRequirements } : {}),
		...(criterionVerifications ? { criterionVerifications } : {}),
		...(row.verification_attempts ? { verificationAttempts: row.verification_attempts } : {}),
		...(row.verification_retry_at === null ? {} : { verificationRetryAt: row.verification_retry_at }),
		...(row.corrective_attempts ? { correctiveAttempts: row.corrective_attempts } : {}),
		...(row.started_at === null ? {} : { startedAt: row.started_at }),
		...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
		...(row.result === null ? {} : { result: row.result }),
		...(row.candidate_result === null ? {} : { candidateResult: row.candidate_result }),
		...(row.error === null ? {} : { error: row.error }),
		...(row.checkpoint === null ? {} : { checkpoint: parseTaskCheckpoint(row.checkpoint) }),
		...(row.checkpoint_at === null ? {} : { checkpointAt: row.checkpoint_at }),
		...(row.routes === null ? {} : { routes: JSON.parse(row.routes) as string[], routeIndex: row.route_index }),
	};
}

function mapTaskPlanCompletionNotice(row: TaskPlanCompletionNoticeRow): TaskPlanCompletionNotice {
	return {
		id: row.id, planId: row.plan_id, ownerKey: row.owner_key,
		target: { platform: row.platform, ...(row.channel_instance_id ? { channelInstanceId: row.channel_instance_id } : {}), chatId: row.chat_id, ...(validChatType(row.chat_type) ? { chatType: validChatType(row.chat_type) } : {}), ...(row.user_id ? { userId: row.user_id } : {}), ...(row.thread_id ? { threadId: row.thread_id } : {}) },
		planStatus: row.plan_status, title: row.title, taskCount: row.task_count, succeeded: row.succeeded, failed: row.failed, cancelled: row.cancelled,
		status: row.abandoned_at === null ? row.status : "abandoned", ...(row.claim_token ? { claimToken: row.claim_token } : {}), attempts: row.attempts, nextAttemptAt: row.next_attempt_at, createdAt: row.created_at,
		...(row.abandoned_at === null ? {} : { abandonedAt: row.abandoned_at }), ...(row.last_error ? { error: row.last_error } : {}),
	};
}

function parseExecutionScope(value: string | null): RuntimeTaskRecord["executionScope"] {
	if (!value) return undefined;
	try {
		const scope = JSON.parse(value) as RuntimeTaskRecord["executionScope"];
		return scope && typeof scope.platform === "string" && typeof scope.chatId === "string" && typeof scope.chatType === "string" ? scope : undefined;
	} catch { return undefined; }
}

function parseSituation(value: string | null): RuntimeTaskRecord["situation"] {
	if (!value) return undefined;
	try { return createSituation(JSON.parse(value) as Parameters<typeof createSituation>[0]); }
	catch { return undefined; }
}

function parseAccessScopeRef(value: string | null): RuntimeTaskRecord["accessScopeRef"] {
	if (!value) return undefined;
	try {
		const ref = JSON.parse(value) as RuntimeTaskRecord["accessScopeRef"];
		if (!ref || ref.trust !== "verified") return undefined;
		return createAccessScopeRef(ref);
	} catch { return undefined; }
}

function parseBusinessContext(value: string | null): RuntimeTaskRecord["businessContext"] {
	if (!value) return undefined;
	try {
		const context = JSON.parse(value) as { subject?: unknown; object?: unknown } | null;
		if (!context || typeof context !== "object") return undefined;
		const subject = parseBusinessEntityRef(context.subject);
		const object = parseBusinessEntityRef(context.object);
		if ((context.subject !== undefined && !subject) || (context.object !== undefined && !object) || (!subject && !object)) return undefined;
		return { ...(subject ? { subject } : {}), ...(object ? { object } : {}) };
	} catch { return undefined; }
}

function parseBusinessEntityRef(value: unknown): { type: string; id: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const ref = value as { type?: unknown; id?: unknown };
	if (typeof ref.type !== "string" || typeof ref.id !== "string") return undefined;
	const type = ref.type.trim();
	const id = ref.id.trim();
	return type && id && type.length <= 100 && id.length <= 500 ? { type, id } : undefined;
}

function parseTaskArtifacts(value: string | null): RuntimeTaskRecord["artifacts"] {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		const artifacts = parsed.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const artifact = item as { type?: unknown; uri?: unknown; label?: unknown };
			if ((artifact.type !== "file" && artifact.type !== "url" && artifact.type !== "reference") || typeof artifact.uri !== "string" || !artifact.uri.trim()) return [];
			const normalized: NonNullable<RuntimeTaskRecord["artifacts"]>[number] = { type: artifact.type, uri: artifact.uri.trim().slice(0, 2_000), ...(typeof artifact.label === "string" && artifact.label.trim() ? { label: artifact.label.trim().slice(0, 500) } : {}) };
			return containsCredentialMaterial(JSON.stringify(normalized)) ? [] : [normalized];
		}).slice(0, 20);
		return artifacts.length ? artifacts : undefined;
	} catch { return undefined; }
}

function parseUnresolvedIssues(value: string | null): string[] | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		const issues = parsed.filter((item): item is string => typeof item === "string").map((item) => redactCredentialMaterial(item.trim()).slice(0, 2_000)).filter(Boolean).slice(0, 20);
		return issues.length ? issues : undefined;
	} catch { return undefined; }
}

function parseVerificationRequirements(value: string | null): RuntimeTaskRecord["verificationRequirements"] {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		const capabilities = new Set<string>();
		const requirements = parsed.slice(0, 50).flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const entry = item as { capability?: unknown; freshness?: unknown; evidence?: unknown };
			if (typeof entry.capability !== "string") return [];
			const capability = entry.capability.trim();
			if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(capability) || capabilities.has(capability) || containsCredentialMaterial(capability)) return [];
			const freshness = ["static", "periodic", "current", "realtime"].includes(String(entry.freshness)) ? entry.freshness as "static" | "periodic" | "current" | "realtime" : undefined;
			const evidence = ["none", "self_reported", "source_receipt", "verified"].includes(String(entry.evidence)) ? entry.evidence as "none" | "self_reported" | "source_receipt" | "verified" : undefined;
			if (!freshness && !evidence) return [];
			capabilities.add(capability);
			return [{ capability, ...(freshness ? { freshness } : {}), ...(evidence ? { evidence } : {}) }];
		});
		return requirements.length ? requirements : undefined;
	} catch { return undefined; }
}

function parseCriterionVerifications(value: string | null): RuntimeTaskRecord["criterionVerifications"] {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		const ids = new Set<string>();
		const verifications = parsed.slice(0, 100).flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const entry = item as { criterionId?: unknown; criterion?: unknown; status?: unknown; evidence?: unknown; evidenceRefs?: unknown };
			if (typeof entry.criterionId !== "string" || typeof entry.criterion !== "string" || !["accepted", "rejected", "unavailable"].includes(String(entry.status)) || !Array.isArray(entry.evidenceRefs)) return [];
			const criterionId = entry.criterionId.trim().slice(0, 128);
			const criterion = entry.criterion.trim().slice(0, 2_000);
			if (!criterionId || !criterion || ids.has(criterionId) || containsCredentialMaterial(`${criterionId}\n${criterion}`)) return [];
			const evidence = typeof entry.evidence === "string" && entry.evidence.trim() ? redactCredentialMaterial(entry.evidence.trim()).slice(0, 5_000) : undefined;
			const evidenceRefs = [...new Set(entry.evidenceRefs.slice(0, 50).filter((ref): ref is string => typeof ref === "string").map((ref) => ref.trim().slice(0, 1_000)).filter((ref) => ref && !containsCredentialMaterial(ref)))];
			ids.add(criterionId);
			return [{ criterionId, criterion, status: entry.status as "accepted" | "rejected" | "unavailable", ...(evidence ? { evidence } : {}), evidenceRefs }];
		});
		return verifications.length ? verifications : undefined;
	} catch { return undefined; }
}

function mapTaskRun(row: TaskRunRow): TaskRunRecord {
	return {
		id: row.id, taskId: row.task_id, executor: row.executor, status: row.status, startedAt: row.started_at,
		...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
		...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
		...(row.output === null ? {} : { output: row.output }),
		...(row.error === null ? {} : { error: row.error }),
	};
}

function mapTaskPlan(row: TaskPlanRow): TaskPlanRecord {
	return {
		id: row.id, ownerKey: row.owner_key, title: row.title, status: row.status, taskCount: row.task_count,
		succeeded: row.succeeded, failed: row.failed, cancelled: row.cancelled, verified: row.verified, correctiveAttempts: row.corrective_attempts,
		...(row.paused_at === null ? {} : { pausedAt: row.paused_at }),
		createdAt: row.created_at, ...(row.started_at === null ? {} : { startedAt: row.started_at }), ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
	};
}

function safeTaskText(value: string | undefined): string | null {
	return value === undefined ? null : redactCredentialMaterial(value);
}

function reversibleControlText(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength || containsCredentialMaterial(value)) throw new Error(`Reversible Action ${field} is invalid`);
	return value.trim();
}

function trustedControlPublisher(publisher: EnterprisePolicyPublisher): string {
	if (publisher?.trust !== "verified" || publisher.authority?.kind !== "enterprise_system" && publisher.authority?.kind !== "administrator_grant") throw new Error("Reversible Action control requires a trusted enterprise publisher");
	return reversibleControlText(publisher.id, "publisher", 256);
}

function normalizeCompensationProof(input: CompensationProof): CompensationProof {
	const id = reversibleControlText(input.id, "Compensation id", 512);
	const capability = reversibleControlText(input.capability, "Compensation capability", 128);
	const receiptProofProvider = input.receiptProofProvider ? reversibleControlText(input.receiptProofProvider, "receipt proof provider", 128) : undefined;
	if (!Number.isSafeInteger(input.exercisedAt) || input.exercisedAt < 0 || !Number.isSafeInteger(input.validUntil) || input.validUntil <= input.exercisedAt) throw new Error("Compensation exercise validity is invalid");
	const evidenceRefs = [...new Set(input.evidenceRefs.map((item) => reversibleControlText(item, "Compensation evidence", 1_000)))];
	if (!evidenceRefs.length || evidenceRefs.length > 20) throw new Error("Compensation exercise requires between 1 and 20 evidence references");
	return { id, capability, ...(receiptProofProvider ? { receiptProofProvider } : {}), exercisedAt: input.exercisedAt, validUntil: input.validUntil, evidenceRefs };
}

function safeTaskArtifacts(value: RuntimeTaskRecord["artifacts"]): string | null {
	const artifacts = parseTaskArtifacts(value === undefined ? null : JSON.stringify(value));
	return artifacts ? JSON.stringify(artifacts) : null;
}

function safeUnresolvedIssues(value: RuntimeTaskRecord["unresolvedIssues"]): string | null {
	const issues = value?.slice(0, 20).map((item) => redactCredentialMaterial(item.trim()).slice(0, 2_000)).filter(Boolean);
	return issues?.length ? JSON.stringify(issues) : null;
}

function safeCriterionVerifications(value: RuntimeTaskRecord["criterionVerifications"]): string | null {
	const verifications = parseCriterionVerifications(value === undefined ? null : JSON.stringify(value));
	return verifications ? JSON.stringify(verifications) : null;
}

function safeVerificationRequirements(value: RuntimeTaskRecord["verificationRequirements"]): string | null {
	const requirements = parseVerificationRequirements(value === undefined ? null : JSON.stringify(value));
	return requirements ? JSON.stringify(requirements) : null;
}

function scopeWhere(opts: Omit<RecallOptions, "limit">, alias: string): { where: string; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];
	if (opts.platform) { conditions.push(`${alias}.platform = ?`); params.push(opts.platform); }
	if (opts.chatId) { conditions.push(`${alias}.chat_id = ?`); params.push(opts.chatId); }
	if (opts.userId) { conditions.push(`${alias}.user_id = ?`); params.push(opts.userId); }
	if (opts.chatId) { conditions.push(`${alias}.thread_id IS ?`); params.push(opts.threadId ?? null); }
	return { where: conditions.length ? `AND ${conditions.join(" AND ")}` : "", params };
}

function episodeScopeWhere(opts: Omit<RecallOptions, "limit">, alias: string): { where: string; params: unknown[] } {
	const conditions = [`${alias}.profile_id = ?`];
	const params: unknown[] = [opts.profileId ?? "default"];
	if (opts.platform) { conditions.push(`${alias}.platform = ?`); params.push(opts.platform); }
	if (opts.chatId) { conditions.push(`${alias}.chat_id = ?`, `${alias}.thread_id IS ?`); params.push(opts.chatId, opts.threadId ?? null); }
	if (opts.userId) { conditions.push(`${alias}.user_id = ?`); params.push(opts.userId); }
	return { where: `AND ${conditions.join(" AND ")}`, params };
}

function validEpisodeStatuses(values: readonly OrganizationMemoryEpisodeStatus[]): OrganizationMemoryEpisodeStatus[] {
	const statuses = [...new Set(values)];
	if (!statuses.length || statuses.some((status) => !EPISODE_STATUSES.has(status))) throw new Error("Organization Memory Episode status filter is invalid");
	return statuses;
}

function boundedEpisodeText(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`Organization Memory Episode ${field} must be between 1 and ${maxLength} characters`);
	return value.trim();
}

function normalizeWorkflowContent(input: Pick<WorkflowCandidateInput, "title" | "summary" | "conditions" | "exceptions" | "inputs" | "instructions" | "expectedOutcomes" | "verification">) {
	const content = {
		title: boundedEpisodeText(input.title, "Workflow title", 240),
		summary: boundedEpisodeText(input.summary, "Workflow summary", 2_000),
		conditions: workflowStrings(input.conditions, "conditions", 1, 20),
		exceptions: workflowStrings(input.exceptions, "exceptions", 0, 20),
		inputs: workflowStrings(input.inputs, "inputs", 1, 20),
		instructions: workflowStrings(input.instructions, "instructions", 1, 50),
		expectedOutcomes: workflowStrings(input.expectedOutcomes, "expected outcomes", 1, 20),
		verification: workflowStrings(input.verification, "Verification", 1, 20),
	};
	if (JSON.stringify(content).length > 30_000) throw new Error("Workflow Candidate instruction content exceeds 30000 characters");
	return content;
}

function workflowStrings(input: unknown, field: string, min: number, max: number): string[] {
	if (!Array.isArray(input) || input.length < min || input.length > max) throw new Error(`Workflow Candidate ${field} must contain between ${min} and ${max} entries`);
	return [...new Set(input.map((value) => boundedEpisodeText(value, `Workflow ${field}`, 2_000)))];
}

function parseWorkflowStrings(value: string): string[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("Workflow Candidate contains invalid instruction data");
	return parsed;
}

function situationKnowledgeQuery(situation: Situation): string {
	return [situation.summary, ...situation.goals, ...situation.constraints, ...situation.uncertainties, ...situation.observations.map((item) => item.statement), ...(situation.conflicts ?? []).map((item) => item.statement)]
		.filter(Boolean).join("\n").slice(0, 10_000);
}
function knowledgeRelevance(content: string, terms: readonly string[]): number {
	const normalized = content.normalize("NFKC").toLocaleLowerCase();
	if (!terms.length) return 0;
	const matched = terms.filter((term) => normalized.includes(term.normalize("NFKC").toLocaleLowerCase()));
	if (!matched.length) return 0;
	const identityAnchors = terms.filter((term) => /[-_:/.\d]/u.test(term));
	if (identityAnchors.length && !identityAnchors.some((term) => normalized.includes(term.normalize("NFKC").toLocaleLowerCase()))) return 0;
	const specificity = (term: string) => [...term].length + (/[-_:/.\d]/u.test(term) ? 4 : 0);
	const strongestAvailable = Math.max(...terms.map(specificity));
	const strongestMatch = Math.max(...matched.map(specificity));
	const coverage = matched.length / Math.min(terms.length, 6);
	return Math.min(1, strongestMatch / strongestAvailable * 0.65 + coverage * 0.35);
}
function recencyScore(timestamp: number): number { return 1 / (1 + Math.max(0, Date.now() - timestamp) / (30 * 24 * 60 * 60 * 1_000)); }
function boundedKnowledgeScore(value: number): number { return Number(Math.max(0, Math.min(1, value)).toFixed(6)); }

function clampConfidence(value: number): number { return Math.max(0, Math.min(1, value)); }
function strongerStability(a: MemoryClaim["stability"], b: MemoryClaim["stability"]): MemoryClaim["stability"] {
	const order = { low: 1, medium: 2, high: 3 } as const;
	return order[a] >= order[b] ? a : b;
}
function sameClaimScope(a: MemoryClaim, b: MemoryClaim): boolean {
	return a.profileId === b.profileId && a.platform === b.platform && a.chatId === b.chatId && a.userId === b.userId && a.threadId === b.threadId
		&& a.projectId === b.projectId && a.organizationId === b.organizationId && a.visibility === b.visibility;
}

function claimReadWhere(opts: Omit<RecallOptions, "limit">, alias: string): { where: string; params: unknown[] } {
	const profileId = opts.profileId ?? "default";
	const privateDisclosureAllowed = opts.chatType === undefined || opts.chatType === "dm";
	const entityConditions: string[] = [];
	const entityParams: unknown[] = [];
	if (opts.subject) {
		entityConditions.push(`${alias}.subject_type = ? AND ${alias}.subject_id = ?`);
		entityParams.push(opts.subject.type, opts.subject.id);
	}
	if (opts.object) {
		entityConditions.push(`${alias}.object_type = ? AND ${alias}.object_id = ?`);
		entityParams.push(opts.object.type, opts.object.id);
	}
	return {
		where: `AND ${alias}.profile_id = ? AND (
			(? = 1 AND ${alias}.visibility = 'private' AND ${alias}.platform = ? AND ${alias}.user_id = ?)
			OR (${alias}.visibility = 'conversation' AND ${alias}.platform = ? AND ${alias}.chat_id = ? AND ${alias}.thread_id IS ?)
			OR (${alias}.visibility = 'team' AND ${alias}.project_id IS NOT NULL AND ${alias}.project_id = ?)
			OR (${alias}.visibility = 'organization' AND ${alias}.organization_id IS NOT NULL AND ${alias}.organization_id = ?))
			${entityConditions.length ? `AND ${entityConditions.join(" AND ")}` : ""}`,
		params: [profileId, privateDisclosureAllowed ? 1 : 0, opts.platform ?? "", opts.userId ?? "", opts.platform ?? "", opts.chatId ?? "", opts.threadId ?? null, opts.projectId ?? "", opts.organizationId ?? "", ...entityParams],
	};
}
function claimRecallWhere(opts: Omit<RecallOptions, "limit">, alias: string): { where: string; params: unknown[] } {
	const access = claimReadWhere(opts, alias);
	return opts.subject || opts.object ? access : { ...access, where: `${access.where} AND ${alias}.subject_type IS NULL AND ${alias}.object_type IS NULL` };
}
function conventionScopeWhere(opts: Omit<RecallOptions, "limit">, alias: string): { where: string; params: unknown[] } {
	return {
		where: `AND ${alias}.profile_id = ? AND ${alias}.platform = ? AND ${alias}.chat_id = ? AND ${alias}.user_id IS ? AND ${alias}.thread_id IS ?`,
		params: [opts.profileId ?? "default", opts.platform ?? "", opts.chatId ?? "", opts.userId ?? null, opts.threadId ?? null],
	};
}
function sameEpisodeInputScope(row: EpisodeRow, input: Pick<ConventionCandidateInput, "profileId" | "platform" | "chatId" | "userId" | "threadId">): boolean {
	return row.profile_id === input.profileId && row.platform === input.platform && row.chat_id === input.chatId
		&& row.user_id === (input.userId ?? null) && row.thread_id === (input.threadId ?? null);
}
function candidateEntityWhere(opts: Omit<RecallOptions, "limit">): { conditions: string[]; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];
	if (opts.subject) { conditions.push("subject_type = ? AND subject_id = ?"); params.push(opts.subject.type, opts.subject.id); }
	if (opts.object) { conditions.push("object_type = ? AND object_id = ?"); params.push(opts.object.type, opts.object.id); }
	if (!opts.subject && !opts.object) conditions.push("subject_type IS NULL AND object_type IS NULL");
	return { conditions, params };
}
function limitOf(value: number | undefined, fallback: number): number { return Math.max(1, Math.min(value ?? fallback, 100)); }
function legacyTaskStatus(status: TaskFactRecord["status"]): RuntimeTaskRecord["status"] {
	if (status === "open") return "pending";
	if (status === "in_progress") return "running";
	if (status === "done") return "succeeded";
	return "cancelled";
}
function legacyTaskFactStatus(status: string): TaskFactRecord["status"] {
	if (status === "pending") return "open";
	if (status === "running") return "in_progress";
	if (status === "succeeded") return "done";
	return "cancelled";
}

function toFtsQuery(query: string): string {
	return lexicalTerms(query)
		.map((token) => `"${token.replaceAll('"', '""')}"${/^[a-z0-9]+$/i.test(token) ? "*" : ""}`)
		.join(" OR ");
}

function lexicalTerms(query: string): string[] {
	return multilingualLexicalTerms(query);
}

function lexicalWhere(query: string, column: string): { where: string; params: string[] } | undefined {
	const terms = lexicalTerms(query);
	if (!terms.length) return undefined;
	return {
		where: `(${terms.map(() => `lower(${column}) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
		params: terms.map((term) => `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`),
	};
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
	const seen = new Set<string>();
	return items.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));
}

interface LegacyEffectReceipt {
	id: string; tool: string; operation: string; sideEffect: "none" | "mutation"; status: "committed" | "unknown"; externalRef?: string; idempotencyKey?: string; occurredAt: number;
}

function readEffectReceiptState(value: string | null): { readable: boolean; receipts: LegacyEffectReceipt[] } {
	if (value === null) return { readable: true, receipts: [] };
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed) || !parsed.every(validEffectReceipt)) return { readable: false, receipts: [] };
		return { readable: true, receipts: parsed.slice(-100) };
	} catch { return { readable: false, receipts: [] }; }
}

function validEffectReceipt(value: unknown): value is LegacyEffectReceipt {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Partial<LegacyEffectReceipt>;
	const text = [receipt.id, receipt.tool, receipt.operation, receipt.externalRef, receipt.idempotencyKey].filter((item): item is string => typeof item === "string").join(" ");
	return typeof receipt.id === "string" && receipt.id.length > 0 && receipt.id.length <= 256
		&& typeof receipt.tool === "string" && receipt.tool.length > 0 && receipt.tool.length <= 256
		&& typeof receipt.operation === "string" && receipt.operation.length > 0 && receipt.operation.length <= 1_000
		&& (receipt.sideEffect === "none" || receipt.sideEffect === "mutation")
		&& (receipt.status === "committed" || receipt.status === "unknown")
		&& typeof receipt.occurredAt === "number" && Number.isFinite(receipt.occurredAt)
		&& !containsCredentialMaterial(text);
}

function rankMemoryHit(hit: Omit<MemoryRecallHit, "score">, query: string, opts: RecallOptions): MemoryRecallHit {
	const normalizedContent = hit.content.normalize("NFKC").toLocaleLowerCase();
	const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase();
	const terms = lexicalTerms(query);
	const matched = terms.filter((term) => normalizedContent.includes(term));
	const coverage = terms.length ? matched.length / terms.length : 0;
	const reasons = new Set(hit.matchReasons);
	if (matched.length) reasons.add("lexical");
	if (normalizedQuery && normalizedContent.includes(normalizedQuery)) reasons.add("exact-phrase");
	const subjectMatch = Boolean(opts.subject && hit.subject?.type === opts.subject.type && hit.subject.id === opts.subject.id);
	const objectMatch = Boolean(opts.object && hit.object?.type === opts.object.type && hit.object.id === opts.object.id);
	if (subjectMatch || objectMatch) reasons.add("business-object");
	if (hit.memoryType === "candidate") reasons.add("unconfirmed-candidate"); else reasons.add("confirmed-memory");
	const base = hit.memoryType === "claim" ? 0.55 : hit.memoryType === "curated" ? 0.4 : 0.1;
	const phrase = reasons.has("exact-phrase") ? 0.25 : 0;
	const entity = (subjectMatch ? 0.2 : 0) + (objectMatch ? 0.3 : 0);
	const confidence = hit.confidence * (hit.memoryType === "candidate" ? 0.1 : 0.2);
	const conflictPenalty = hit.status === "conflicted" ? 0.15 : 0;
	return { ...hit, score: Number(Math.max(0, base + coverage * 0.35 + phrase + entity + confidence - conflictPenalty).toFixed(6)), matchReasons: [...reasons] };
}

function cryptoRandom(): string {
	// 16 random bytes -> 32 hex chars. Good enough as a unique row id.
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

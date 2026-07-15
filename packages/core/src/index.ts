/**
 * BeeMax Core is the Agent runtime seam.
 *
 * Pi is the current implementation, but every BeeMax-owned package imports
 * runtime primitives from this module so runtime evolution stays local here.
 */

export type { Agent } from "@earendil-works/pi-agent-core";
export { canonicalUserId, conversationIdentity, conversationKey, conversationOwnerKey, responsibilityOwnerKey, responsibilityOwnerKeys, type AgentScope, type ConversationIdentity } from "./agent-scope.ts";
export { StringEnum } from "@earendil-works/pi-ai";
export { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
export { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
export { builtinProviders } from "@earendil-works/pi-ai/providers/all";
export type { Api, ImageContent, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
export {
	assessCompactionPreservation,
	evaluateCompactionQuality,
	planContextCompaction,
	recoverCompactionPreservation,
	taskIdsFromCompactionPreservation,
	type CompactionPreservationAssessment,
	type CompactionPreservationRecovery,
	type CompactionQualityAssessment,
	type ContextCompactionPlan,
	type ContextCompactionPlanInput,
} from "./context-compaction.ts";
export {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
export type {
	AgentSession,
	AgentSessionEvent,
	Skill,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
export {
	buildBeeMaxRuntimeFactory,
	filterEligibleSkills,
	markRuntimeResourcesChanged,
	reloadRuntimeResourcesIfNeeded,
	resolveRuntimeModel,
	type BeeMaxRuntimeAuthorization,
	type BeeMaxRuntimeFactoryOptions,
	type ContextCompactionAuditEvent,
	type BeeMaxRuntimeSource,
	type ProactiveMutationAuthority,
} from "./runtime.ts";
export { ToolPolicyRegistry, READ_ONLY_TOOL_POLICY, MUTATING_TOOL_POLICY, boundToolResultContent, governToolDefinition, normalizeToolResultBudget, withToolPolicy, type GovernedToolDefinition, type ToolApprovalMode, type ToolCapabilityGrant, type ToolPolicy, type ToolResultBudget, type ToolRisk, type ToolRuntimeAuditEvent, type ToolRuntimeAuditSink, type ToolSideEffect } from "./tool-runtime.ts";
export { createVerificationSubmitTool, VERIFICATION_SUBMIT_TOOL_NAME } from "./verification-tools.ts";
export { FileToolAuditJournal, type DurableToolAuditEvent } from "./tool-audit-journal.ts";
export { createToolEffectDetails, FileToolEffectJournal, ToolEffectConflictError, type TaskEffectProjection, type ToolEffectAuthorityPort, type ToolEffectFinish, type ToolEffectProjectionReader, type ToolEffectProof, type ToolEffectReceipt, type ToolEffectRecord, type ToolEffectSink, type ToolEffectStart, type ToolEffectStatus } from "./tool-effect.ts";
export { RUNTIME_FAULT_CATALOG, RUNTIME_FAULT_KINDS, assessRuntimeFaultCoverage, type RuntimeFaultCoverageAssessment, type RuntimeFaultDefinition, type RuntimeFaultKind } from "./runtime-fault-catalog.ts";
export { RUNTIME_PATHS, assessRuntimePerformance, percentile, runtimeCostRegressions, type RuntimeMachineProfile, type RuntimePath, type RuntimePathAssessment, type RuntimePathBudget, type RuntimePathObservation, type RuntimePerformanceAssessment, type RuntimePerformanceInput } from "./runtime-performance.ts";
export { FileCredentialVault, FileCredentialVaultAuditJournal, type CredentialInput, type CredentialMetadata, type CredentialVault, type CredentialVaultAuditEvent, type CredentialVaultAuditSink } from "./credential-vault.ts";
export { getRuntimeCapabilitySnapshot, type RuntimeCapabilitySnapshot, type RuntimeModelCapability, type RuntimeProviderCapability } from "./runtime-capabilities.ts";
export {
	SubagentManager,
	createSubagentTools,
	type SubagentAdmission,
	type SubagentExecutor,
	type SubagentManagerOptions,
	type SubagentTask,
	type SubagentTaskSnapshot,
	type SubagentTaskStatus,
} from "./task-manager.ts";
export { ConversationContext, type ContextAssembly, type ContextItem, type ContextItemInput, type ContextItemKind, type ConversationContextOptions, type ConversationExchange, type ConversationMemoryPort, type OrganizationKnowledgeHit, type OrganizationKnowledgeKind, type OrganizationKnowledgeRecall, type OrganizationKnowledgeRecallMetrics, type VerifiedRuntimeFacts } from "./conversation-context.ts";
export { compileLongTermMemorySnapshot, type LongTermMemoryCompiler } from "./personal-memory.ts";
export { curatedMemoryPrompt } from "./curated-memory.ts";
export type { TaskArtifact, TaskCandidateVerificationResolution, TaskDependency, TaskKind, TaskLedger, TaskPlanCompletionNotice, TaskPlanQuery, TaskPlanRecord, TaskPlanStatus, TaskPlanTransition, TaskQuery, TaskRecord, TaskRecoveryPolicy, TaskRecoveryResult, TaskRunEffectStateReader, TaskRunRecord, TaskRunStatus, TaskRunTransition, TaskStatus, TaskTransition, TaskVerificationStatus } from "./task-ledger.ts";
export { createTaskCheckpoint, isTaskCheckpoint, mergeTaskCheckpoints, parseTaskCheckpoint, renderTaskCheckpoint, type TaskCheckpoint, type TaskCheckpointInput } from "./task-checkpoint.ts";
export { ObjectiveRuntime, type ObjectiveDeliverer, type ObjectiveDeliveryInput, type ObjectiveDeliveryOutcome, type ObjectiveDeliveryResult, type VerifiedObjectiveMemoryPublisher, type VerifiedObjectiveOutcome } from "./objective-runtime.ts";
export { createTaskLedgerTools } from "./task-ledger-tools.ts";
export { TaskGraph, type TaskGraphDependencyResult, type TaskGraphExecutionContext, type TaskGraphExecutionResult, type TaskGraphExecutor, type TaskGraphResult, type TaskGraphRunOptions, type TaskGraphVerificationContext, type TaskGraphVerificationResult, type TaskGraphVerifier, type TaskPlanInput } from "./task-graph.ts";
export { createTaskOrchestrationTools, type TaskOrchestrationOptions } from "./task-orchestration-tools.ts";
export { assessTaskPlanQuality, type TaskPlanQualityInput, type TaskPlanQualityResult } from "./task-plan-quality.ts";
export { assertNoCredentialMaterial, containsCredentialMaterial, redactCredentialMaterial } from "./credential-material.ts";
export { TaskRecoveryRunner, type DirectObjectiveVerificationNotifier, type DirectObjectiveVerificationResolution, type TaskPlanCancelResult, type TaskPlanPauseResult, type TaskPlanRetryResult, type TaskRecoveryRunnerOptions, type TaskRecoveryRunnerResult, type TaskVerificationRetryResult } from "./task-recovery.ts";
export { TaskRecoveryService, type TaskRecoveryCycleResult, type TaskRecoveryServiceOptions } from "./task-recovery-service.ts";
export { TaskPlanRuntime } from "./task-plan-runtime.ts";
export { TurnUnderstandingEngine, renderWorkContext, selectTurnTools, type TurnAction, type TurnExecutionMode, type TurnUnderstanding, type TurnUnderstandingInput, type TurnUnderstandingPort } from "./turn-understanding.ts";
export { CapabilityRuntime, LexicalCapabilityRanker, SemanticCapabilityRanker, capabilityDescriptor, capabilityVersionOf, type CapabilityCandidate, type CapabilityDescriptor, type CapabilityEffectStatus, type CapabilityExplanation, type CapabilityKind, type CapabilityRanker, type CapabilityRankingStrategy, type CapabilitySelection, type PiActiveToolsPort, type SemanticCapabilityPort } from "./capability-runtime.ts";
export { evaluateCapabilityRanking, type CapabilityRankingEvaluationCase, type CapabilityRankingEvaluationFailure, type CapabilityRankingEvaluationReport } from "./capability-ranking-evaluation.ts";
export { CapabilityProviderRuntime, type CapabilityProviderAcquisition, type CapabilityProviderBlocker, type CapabilityProviderCandidate, type CapabilityProviderConfiguration, type CapabilityProviderDescriptor, type CapabilityProviderHealth, type CapabilityProviderHealthStatus, type CapabilityProviderInstallAuthority, type CapabilityProviderInstaller, type CapabilityProviderInstallReceipt, type CapabilityProviderInstallSpec, type CapabilityProviderKind, type CapabilityProviderResolution, type CapabilityProviderRuntimeOptions } from "./capability-provider.ts";
export { MediaUnderstandingRuntime, MediaUnderstandingUnavailableError, PiVisionMediaUnderstandingAdapter, renderMediaUnderstandingEvidence, type MediaPrimaryModel, type MediaUnderstandingAdapter, type MediaUnderstandingAdapterResult, type MediaUnderstandingEvaluation, type MediaUnderstandingFailure, type MediaUnderstandingOutput, type MediaUnderstandingPort, type MediaUnderstandingReceipt, type MediaUnderstandingRequest, type MediaUnderstandingRuntimeOptions, type PiVisionMediaUnderstandingAdapterOptions, type PreparedMediaUnderstanding } from "./media-understanding.ts";
export { EnterprisePolicyRuntime, createEnterprisePolicyProvider, createEnterprisePolicyPublisher, resolveEnterprisePolicyDecision, type EnterpriseActionConstraints, type EnterprisePolicyDecision, type EnterprisePolicyDirective, type EnterprisePolicyDisposition, type EnterprisePolicyEffectiveScope, type EnterprisePolicyInput, type EnterprisePolicyProvider, type EnterprisePolicyPublisher } from "./enterprise-policy.ts";
export { ActionGovernance, type ActionExecutionGrant, type ActionGovernanceDecision, type ActionGovernanceInput, type ActionGovernanceOutcome, type MeasuredActionReliability } from "./action-governance.ts";
export { multilingualLexicalTerms } from "./multilingual-lexical.ts";
export { TaskPlanNoticeDeliveryService, renderTaskPlanCompletionNotice, type TaskPlanProgressEvent, type TaskPlanNoticeDeliveryOptions, type TaskPlanNoticeDeliveryResult, type TaskPlanNoticeOutbox } from "./task-plan-notice-delivery.ts";
export { ProfileTaskScheduler, type ProfileTaskSchedulerOptions, type ProfileTaskSchedulerSnapshot } from "./profile-task-scheduler.ts";
export { AutonomousPlanningPolicy, PlanningBudgetRegistry, type AutonomousExecutionMode, type AutonomousPlanningDecision, type AutonomousPlanningPolicyOptions, type PlanningResourceBudget, type PlanningSignals } from "./autonomous-planning.ts";
export {
	SessionCoordinator,
	sessionIdForSource,
	legacySessionIdsForSource,
	sessionKeyForSource,
	sessionOwnerKey,
	type RuntimeSession,
	type RuntimeSessionSnapshot,
	type RuntimeSessionFactory,
	type SessionCoordinatorOptions,
} from "./session-coordinator.ts";
export { SessionCatalog, type SavedSessionChoice, type SessionPreferences, type SessionCatalogOwnershipReceipt, type StoredSessionChoice } from "./session-catalog.ts";
export { ProfileSessionOwnershipMigration, type AppliedSessionOwnershipMigration, type ApplySessionOwnershipMigrationInput, type PreparedSessionOwnershipMigration, type SessionOwnershipCandidate, type SessionOwnershipMigrationPlan } from "./session-ownership-migration.ts";
export {
	BeeMaxAgentRuntime,
	buildTaskPreservationEnvelope,
	buildActiveTaskPreservationEnvelope,
	AgentRunError,
	isRecoverableModelFailure,
	type AgentRunInput,
	type AgentRunResult,
	type BeeMaxAgentRunEvent,
	type BeeMaxAgentRunEventSink,
	type ModelFallbackEvent,
	type PlanningDecisionEvent,
	type PlanningOutcomeEvent,
	type CapabilityRankedCandidate,
	type CapabilityRankedEvent,
	type ContextBuiltEvent,
	type ExecutionStartedEvent,
	type ExecutionSettledEvent,
	type MediaUnderstoodEvent,
	type AgentHistoryEntry,
	type AgentSessionUsage,
	type AgentRuntimePort,
	type BeeMaxAgentRuntimeOptions,
} from "./agent-runtime.ts";
export type { AgentControlHandler, AgentControlInput, AgentControlResult } from "./agent-control.ts";
export { ToolApprovalBroker, approvalDetails, type ApprovalAuditSink, type ApprovalPromptSender, type TaskExecutionGrantSnapshot, type ToolApprovalChoice, type ToolApprovalDecision, type ToolApprovalDetails, type ToolApprovalEvent, type ToolApprovalRequest } from "./tool-approval.ts";
export { memoryScopeForSource, type MemoryScope } from "./memory-scope.ts";
export { createAccessScopeRef, type AccessScopeRef, type AccessScopeRefInput, type TrustedAccessAuthority, type TrustedAccessAuthorityKind } from "./access-scope.ts";
export { createSituation, type Situation, type SituationAction, type SituationConflict, type SituationEvidenceSource, type SituationEvidenceSourceKind, type SituationEvidenceTrust, type SituationInput, type SituationObservation } from "./situation.ts";
export { AUTONOMY_LEVELS, AutonomyRolloutController, guardVerifiedObjectiveMemoryPublisher, type AutonomyAllowance, type AutonomyEnterpriseOverride, type AutonomyLevel, type AutonomyRolloutAuthority, type AutonomyRolloutDecision, type AutonomyRolloutEvidence, type AutonomyRolloutRecord, type AutonomyRolloutStateStore, type AutonomyRolloutStatus } from "./autonomy-rollout.ts";
export { DeterministicSituationBuilder, ModelBackedSituationBuilder, type SituationBuildInput, type SituationBuildResult, type SituationBuilderPort, type SituationEvidenceInput, type SituationModelInference, type SituationModelProposal } from "./situation-builder.ts";
export { InitiativeRuntime, decideInitiativeFromSituation, initiativeDedupeKey, initiativeOwnerKey, initiativeScopeMatchesExecutionScope, type InitiativeDecision, type InitiativeDecisionContext, type InitiativeDecisionPort, type InitiativeEvidenceRecallPort, type InitiativeObservation, type InitiativeObservationInput, type InitiativeObservationStore, type InitiativeObserveResult, type InitiativeRisk, type InitiativeRuntimeOptions, type InitiativeScope, type InitiativeTrigger, type InitiativeTriggerKind } from "./initiative-runtime.ts";
export { GroupObservationRecorder, type AmbientGroupObservation, type AmbientObservationEvaluation, type AmbientObservationEvaluator, type GroupObservationRecordResult, type GroupObservationRecorderOptions, type GroupObservationStore } from "./group-observation-recorder.ts";
export { ModelBackedAmbientObservationEvaluator, PiAmbientObservationEvaluator, type AmbientObservationEvaluationOptions, type AmbientObservationInferenceInput, type AmbientObservationModelInference, type PiAmbientObservationEvaluatorOptions } from "./ambient-observation-evaluator.ts";
export { ProactiveInvestigationRuntime, type ProactiveCapability, type ProactiveInvestigationCandidate, type ProactiveInvestigationExecution, type ProactiveInvestigationExecutionResult, type ProactiveInvestigationLedger, type ProactiveInvestigationMetric, type ProactiveInvestigationPolicy, type ProactiveInvestigationResult, type ProactiveInvestigationRuntimeOptions } from "./proactive-investigation-runtime.ts";
export { createReversibleActionMutationAuthority, ReversibleActionAdmission, type CompensationProof, type EmergencyStopRecord, type EmergencyStopSnapshot, type ReversibleActionAdmissionDecision, type ReversibleActionAdmissionInput, type ReversibleActionCapability, type ReversibleActionControlPort } from "./reversible-action-admission.ts";
export { ProactiveReversibleActionRuntime, type ProactiveCompensationExecution, type ProactiveCompensationResult, type ProactiveReversibleActionCandidate, type ProactiveReversibleActionExecution, type ProactiveReversibleActionExecutionResult, type ProactiveReversibleActionResult, type ProactiveReversibleActionRuntimeOptions } from "./proactive-reversible-action-runtime.ts";
export { EnterpriseEventInitiativeAdapter, InitiativeTriggerService, TaskTransitionInitiativeAdapter, type DurableInitiativeTrigger, type DurableInitiativeTriggerInput, type DurableInitiativeTriggerStatus, type InitiativeTriggerAdapterInput, type InitiativeTriggerInbox, type InitiativeTriggerServiceOptions } from "./initiative-trigger-service.ts";
export { InteractionEventAdapter, mapAgentSessionEvent, reduceInteractionEvent, interactionScopeForSource, type InteractionAction, type InteractionActionResult, type InteractionApprovalResult, type InteractionDeliveryMode, type InteractionEvent, type InteractionEventSink, type InteractionPhase, type InteractionQueueResult, type InteractionScope, type InteractionSessionCompactResult, type InteractionSessionResetResult, type InteractionSessionResult, type InteractionSnapshot, type InteractionSurface, type InteractionTelemetryEvent, type InteractionTelemetrySink } from "./interaction-runtime.ts";
export { AdaptiveTextBuffer, TurnStatusPulse, type AdaptiveTextBufferOptions, type TurnStatusPulseOptions } from "./interaction-presentation.ts";
export { FileInteractionInputQueueStore, type InteractionInputQueueStore, type InteractionQueuedInput } from "./interaction-input-queue.ts";
export { FileInteractionEventJournal, durableEvent, type DurableInteractionEvent, type InteractionEventJournal } from "./interaction-event-journal.ts";
export { INTERACTION_PROTOCOL_VERSION, InteractionProtocol, parseInteractionProtocolRequest, sameScope, type InteractionProtocolOptions, type InteractionProtocolRequest, type InteractionProtocolResponse, type ProtocolInteractionAction } from "./interaction-protocol.ts";
export { INTERACTION_COMMANDS, interactionCommandHelp, parseInteractionCommand, type InteractionCommand, type InteractionCommandDefinition, type InteractionDetailsDisplay } from "./interaction-commands.ts";
export { DeliveryDeferredError, type DeliveryOptions, type DeliveryPort, type DeliveryTarget, type MediaArtifact } from "./delivery-port.ts";
export { sanitizeDisplayText } from "./display-text.ts";
export type { ExecutionBackend, ExecutionPolicy, ExecutionPort, ExecutionRequest, ExecutionResult, SandboxMode, WorkspaceAccess } from "./execution.ts";
export { resolveExecutionBackend } from "./execution.ts";
export { createExecutionEnvelope, type ExecutionBudgetRef, type ExecutionEnvelope, type ExecutionMode, type ExecutionTriggerKind, type ProactiveActionAuthorityRef, type VerificationProtocol } from "./execution-envelope.ts";
export { FileExecutionTraceStore, type ExecutionTrace, type ExecutionTraceEvent, type ExecutionTraceInput, type ExecutionTraceQuery, type ExecutionTraceSink } from "./execution-trace.ts";
export { DEFAULT_DOCKER_SANDBOX_IMAGE, DEFAULT_DOCKER_SANDBOX_LIMITS, DockerExecutionPort, type DockerExecutionOptions } from "./docker-execution.ts";
export { LocalExecutionPort } from "./local-execution.ts";
export { createExecutionTools } from "./execution-tools.ts";
export type { MediaOutboxPort } from "./media-outbox-port.ts";
export { createAutomationTools } from "./automation-tools.ts";
export { createSkillTools, type SkillCandidatePromotionAuthority, type SkillCandidatePromotionAuthorityInput, type SkillCandidateTrialInput, type SkillCandidateTrialResult, type SkillCandidateVerifier, type SkillTrialAssertion, type SkillTrialToolCall } from "./skill-tools.ts";
export { SkillRegistry, SkillRuntime, type SkillDescriptor, type SkillExecutionSnapshot, type SkillManifest, type SkillMatch, type SkillRouteManifest, type SkillRuntimeState } from "./skill-runtime.ts";
export { createWebTools, type WebToolsOptions } from "./web-tools.ts";
export { createBrowserTools, type BrowserToolsOptions } from "./browser-tools.ts";
export {
	AutomationScheduler,
	AutomationDeliveryWorker,
	HeartbeatRunner,
	filterHeartbeatAnswer,
	isVerifiedAutomationOutcome,
	isWithinActiveHours,
	type AutomationExecutor,
	type HeartbeatConfig,
	type HeartbeatExecution,
	type HeartbeatExecutor,
	type HeartbeatObservation,
	type HeartbeatObserver,
} from "./automation-runtime.ts";
export { DEFAULT_RUNTIME_RESOURCE_LIMITS, resolveRuntimeTaskConcurrency } from "./runtime-resource-limits.ts";

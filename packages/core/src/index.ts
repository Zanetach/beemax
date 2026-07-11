/**
 * BeeMax Core is the Agent runtime seam.
 *
 * Pi is the current implementation, but every BeeMax-owned package imports
 * runtime primitives from this module so runtime evolution stays local here.
 */

export type { Agent } from "@earendil-works/pi-agent-core";
export { canonicalUserId, conversationIdentity, conversationKey, conversationOwnerKey, type AgentScope, type ConversationIdentity } from "./agent-scope.ts";
export { StringEnum } from "@earendil-works/pi-ai";
export { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
export { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
export { builtinProviders } from "@earendil-works/pi-ai/providers/all";
export type { Api, ImageContent, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
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
	type BeeMaxRuntimeAuthorization,
	type BeeMaxRuntimeFactoryOptions,
	type BeeMaxRuntimeSource,
} from "./runtime.ts";
export { ToolPolicyRegistry, READ_ONLY_TOOL_POLICY, MUTATING_TOOL_POLICY, governToolDefinition, withToolPolicy, type GovernedToolDefinition, type ToolApprovalMode, type ToolCapabilityGrant, type ToolPolicy, type ToolRisk, type ToolRuntimeAuditEvent, type ToolRuntimeAuditSink, type ToolSideEffect } from "./tool-runtime.ts";
export { FileToolAuditJournal, type DurableToolAuditEvent } from "./tool-audit-journal.ts";
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
export { ConversationContext, type ConversationContextOptions, type ConversationExchange, type ConversationMemoryPort, type VerifiedRuntimeFacts } from "./conversation-context.ts";
export { compileLongTermMemorySnapshot, type LongTermMemoryCompiler } from "./personal-memory.ts";
export { curatedMemoryPrompt } from "./curated-memory.ts";
export type { TaskCandidateVerificationResolution, TaskDependency, TaskKind, TaskLedger, TaskPlanCompletionNotice, TaskPlanQuery, TaskPlanRecord, TaskPlanStatus, TaskPlanTransition, TaskQuery, TaskRecord, TaskRecoveryPolicy, TaskRecoveryResult, TaskRunRecord, TaskRunStatus, TaskRunTransition, TaskStatus, TaskTransition, TaskVerificationStatus } from "./task-ledger.ts";
export { createTaskLedgerTools } from "./task-ledger-tools.ts";
export { TaskGraph, type TaskGraphDependencyResult, type TaskGraphExecutionContext, type TaskGraphExecutionResult, type TaskGraphExecutor, type TaskGraphResult, type TaskGraphRunOptions, type TaskGraphVerificationResult, type TaskGraphVerifier, type TaskPlanInput } from "./task-graph.ts";
export { createTaskOrchestrationTools, type TaskOrchestrationOptions } from "./task-orchestration-tools.ts";
export { TaskRecoveryRunner, type TaskPlanCancelResult, type TaskPlanRetryResult, type TaskRecoveryRunnerOptions, type TaskRecoveryRunnerResult, type TaskVerificationRetryResult } from "./task-recovery.ts";
export { TaskRecoveryService, type TaskRecoveryCycleResult, type TaskRecoveryServiceOptions } from "./task-recovery-service.ts";
export { TaskPlanRuntime } from "./task-plan-runtime.ts";
export { TaskPlanNoticeDeliveryService, renderTaskPlanCompletionNotice, type TaskPlanNoticeDeliveryOptions, type TaskPlanNoticeDeliveryResult, type TaskPlanNoticeOutbox } from "./task-plan-notice-delivery.ts";
export { ProfileTaskScheduler, type ProfileTaskSchedulerOptions, type ProfileTaskSchedulerSnapshot } from "./profile-task-scheduler.ts";
export {
	SessionCoordinator,
	sessionIdForSource,
	sessionKeyForSource,
	sessionOwnerKey,
	type RuntimeSession,
	type RuntimeSessionSnapshot,
	type RuntimeSessionFactory,
	type SessionCoordinatorOptions,
} from "./session-coordinator.ts";
export { SessionCatalog, type SavedSessionChoice, type SessionPreferences } from "./session-catalog.ts";
export {
	BeeMaxAgentRuntime,
	AgentRunError,
	isRecoverableModelFailure,
	type AgentRunInput,
	type AgentRunResult,
	type BeeMaxAgentRunEvent,
	type BeeMaxAgentRunEventSink,
	type ModelFallbackEvent,
	type AgentHistoryEntry,
	type AgentSessionUsage,
	type AgentRuntimePort,
	type BeeMaxAgentRuntimeOptions,
} from "./agent-runtime.ts";
export type { AgentControlHandler, AgentControlInput, AgentControlResult } from "./agent-control.ts";
export { ToolApprovalBroker, approvalDetails, type ApprovalAuditSink, type ApprovalPromptSender, type ToolApprovalChoice, type ToolApprovalDecision, type ToolApprovalDetails, type ToolApprovalEvent, type ToolApprovalRequest } from "./tool-approval.ts";
export { memoryScopeForSource, type MemoryScope } from "./memory-scope.ts";
export { InteractionEventAdapter, mapAgentSessionEvent, reduceInteractionEvent, interactionScopeForSource, type InteractionAction, type InteractionActionResult, type InteractionApprovalResult, type InteractionDeliveryMode, type InteractionEvent, type InteractionEventSink, type InteractionPhase, type InteractionQueueResult, type InteractionScope, type InteractionSessionCompactResult, type InteractionSessionResetResult, type InteractionSessionResult, type InteractionSnapshot, type InteractionSurface, type InteractionTelemetryEvent, type InteractionTelemetrySink } from "./interaction-runtime.ts";
export { FileInteractionEventJournal, durableEvent, type DurableInteractionEvent, type InteractionEventJournal } from "./interaction-event-journal.ts";
export { INTERACTION_PROTOCOL_VERSION, InteractionProtocol, parseInteractionProtocolRequest, sameScope, type InteractionProtocolOptions, type InteractionProtocolRequest, type InteractionProtocolResponse, type ProtocolInteractionAction } from "./interaction-protocol.ts";
export { INTERACTION_COMMANDS, interactionCommandHelp, parseInteractionCommand, type InteractionCommand, type InteractionCommandDefinition, type InteractionDetailsDisplay } from "./interaction-commands.ts";
export type { DeliveryPort, DeliveryTarget, MediaArtifact } from "./delivery-port.ts";
export { sanitizeDisplayText } from "./display-text.ts";
export type { ExecutionBackend, ExecutionPolicy, ExecutionPort, ExecutionRequest, ExecutionResult, SandboxMode, WorkspaceAccess } from "./execution.ts";
export { resolveExecutionBackend } from "./execution.ts";
export { DockerExecutionPort, type DockerExecutionOptions } from "./docker-execution.ts";
export { LocalExecutionPort } from "./local-execution.ts";
export { createExecutionTools } from "./execution-tools.ts";
export type { MediaOutboxPort } from "./media-outbox-port.ts";
export { createAutomationTools } from "./automation-tools.ts";
export { createSkillTools } from "./skill-tools.ts";
export { createWebTools, type WebToolsOptions } from "./web-tools.ts";
export { createBrowserTools, type BrowserToolsOptions } from "./browser-tools.ts";
export {
	AutomationScheduler,
	HeartbeatRunner,
	filterHeartbeatAnswer,
	isWithinActiveHours,
	type AutomationExecutor,
	type HeartbeatConfig,
	type HeartbeatExecution,
	type HeartbeatExecutor,
} from "./automation-runtime.ts";

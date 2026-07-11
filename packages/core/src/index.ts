/**
 * BeeMax Core is the Agent runtime seam.
 *
 * Pi is the current implementation, but every BeeMax-owned package imports
 * runtime primitives from this module so runtime evolution stays local here.
 */

export type { Agent } from "@earendil-works/pi-agent-core";
export { StringEnum } from "@earendil-works/pi-ai";
export { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
export { builtinProviders } from "@earendil-works/pi-ai/providers/all";
export type { Api, Model } from "@earendil-works/pi-ai";
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
export {
	SubagentManager,
	createSubagentTools,
	type SubagentExecutor,
	type SubagentManagerOptions,
	type SubagentTask,
	type SubagentTaskSnapshot,
	type SubagentTaskStatus,
} from "./task-manager.ts";
export { ConversationContext, type ConversationContextOptions, type ConversationExchange, type ConversationMemoryPort } from "./conversation-context.ts";
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
	type AgentRunInput,
	type AgentRunResult,
	type AgentRunEventSink,
	type AgentHistoryEntry,
	type AgentSessionUsage,
	type AgentRuntimePort,
	type BeeMaxAgentRuntimeOptions,
} from "./agent-runtime.ts";
export type { AgentControlHandler, AgentControlInput, AgentControlResult } from "./agent-control.ts";
export type { RunEvent, RunRecord } from "./run-events.ts";
export type { DeliveryPort, DeliveryTarget, MediaArtifact } from "./delivery-port.ts";
export type { ExecutionBackend, ExecutionPolicy, ExecutionPort, ExecutionRequest, ExecutionResult, SandboxMode, WorkspaceAccess } from "./execution.ts";
export { resolveExecutionBackend } from "./execution.ts";
export { DockerExecutionPort, type DockerExecutionOptions } from "./docker-execution.ts";
export { LocalExecutionPort } from "./local-execution.ts";
export { createExecutionTools } from "./execution-tools.ts";
export type { MediaOutboxPort } from "./media-outbox-port.ts";
export { createAutomationTools } from "./automation-tools.ts";
export { createSkillTools } from "./skill-tools.ts";
export { createWebTools, type WebToolsOptions } from "./web-tools.ts";
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

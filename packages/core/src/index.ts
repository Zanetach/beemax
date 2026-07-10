/**
 * BeeMax Core is the Agent runtime seam.
 *
 * Pi is the current implementation, but every BeeMax-owned package imports
 * runtime primitives from this module so runtime evolution stays local here.
 */

export type { Agent } from "@earendil-works/pi-agent-core";
export { StringEnum } from "@earendil-works/pi-ai";
export { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
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
export { createCodexImageTool, type CodexImageToolOptions } from "./image-generation.ts";
export { ConversationContext, type ConversationContextOptions, type ConversationExchange, type ConversationMemoryPort } from "./conversation-context.ts";
export {
	SessionCoordinator,
	sessionIdForSource,
	sessionKeyForSource,
	type RuntimeSession,
	type RuntimeSessionFactory,
	type SessionCoordinatorOptions,
} from "./session-coordinator.ts";
export {
	BeeMaxAgentRuntime,
	AgentRunError,
	type AgentRunInput,
	type AgentRunResult,
	type AgentRunEventSink,
	type BeeMaxAgentRuntimeOptions,
} from "./agent-runtime.ts";
export type { DeliveryPort, DeliveryTarget, MediaArtifact } from "./delivery-port.ts";
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

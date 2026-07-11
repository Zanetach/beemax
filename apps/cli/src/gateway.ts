/**
 * `beemax gateway` - start the Feishu gateway.
 *
 * Connects the Feishu WSClient for inbound events, drives the Pi agent per
 * chat, and renders streaming replies as continuously-updated Feishu
 * interactive cards (pure TS card pipeline - no Python sidecar). Every turn
 * is also persisted to the FTS5 memory store for cross-session recall.
 */

import { AutomationStore } from "@beemax/automation";
import { AutomationScheduler, BeeMaxAgentRuntime, HeartbeatRunner } from "@beemax/core";
import {
	createSubagentTools,
	Dispatcher,
	FeishuAdapter,
	GatewayDeliveryPort,
	type FeishuSettings,
	SubagentManager,
	ToolApprovalBroker,
	type SubagentTask,
} from "@beemax/gateway";
import { loadMcpConfig, McpManager } from "@beemax/mcp-capability";
import { buildAgentFactory } from "./agent-factory.ts";
import { MemoryStore } from "@beemax/memory";
import { createFeishuMeetingTools } from "@beemax/feishu-capability";
import type { SessionSource } from "@beemax/gateway";
import { beemaxHome, type BeeMaxConfig } from "./config.ts";
import { acquireChannelLock } from "./channel-lock.ts";
import { curatedMemoryPrompt } from "./curated-memory.ts";
import { createTaskAwareConversationContext } from "./runtime-facts.ts";
import { createProfileRuntime } from "./runtime-composition.ts";
import { workspaceToolsPrompt } from "./workspace-context.ts";
import { configuredApiKey } from "./provider-resolver.ts";
import { executionPortFor, executionSafeTools } from "./execution-composition.ts";
import { createProfileControlHandler } from "./profile-control.ts";
import { recordGatewayEvent, writeGatewayState } from "./gateway-observability.ts";
import { installedVersion } from "./runtime-facts.ts";

export async function runGateway(config: BeeMaxConfig): Promise<void> {
	if (!config.gateway.feishu.appId || !config.gateway.feishu.appSecret) {
		const error = "Feishu credentials missing. Set FEISHU_APP_ID / FEISHU_APP_SECRET or configure feishu.appId/appSecret in config/beemax.yaml.";
		writeGatewayState(config.paths.agentDir, { profile: config.profile, lifecycle: "failed", version: installedVersion(), pid: process.pid, stoppedAt: new Date().toISOString(), lastError: error });
		recordGatewayEvent(config.paths.agentDir, "failed", { profile: config.profile, error });
		throw new Error(error);
	}
	const feishuSettings: FeishuSettings = {
		appId: config.gateway.feishu.appId,
		appSecret: config.gateway.feishu.appSecret,
		domain: config.gateway.feishu.domain,
		connectionMode: config.gateway.feishu.connectionMode,
		webhookHost: config.gateway.feishu.webhookHost,
		webhookPort: config.gateway.feishu.webhookPort,
		webhookPath: config.gateway.feishu.webhookPath,
		webhookVerificationToken: config.gateway.feishu.webhookVerificationToken,
		webhookEncryptKey: config.gateway.feishu.webhookEncryptKey,
		requireMention: config.gateway.feishu.requireMention,
		allowedUsers: config.gateway.feishu.allowedUsers,
		allowedChats: config.gateway.feishu.allowedChats,
		allowAllUsers: config.gateway.feishu.allowAllUsers,
	};
	const adapter = new FeishuAdapter(feishuSettings);
	const gatewayVersion = installedVersion();
	const deliveryPort = new GatewayDeliveryPort(adapter);
	let releaseChannelLock: () => Promise<void>;
	try { releaseChannelLock = await acquireChannelLock(beemaxHome(), config.gateway.feishu.appId); }
	catch (error) {
		writeGatewayState(config.paths.agentDir, { profile: config.profile, lifecycle: "failed", version: gatewayVersion, pid: process.pid, stoppedAt: new Date().toISOString(), lastError: String(error).slice(0, 500) });
		recordGatewayEvent(config.paths.agentDir, "failed", { profile: config.profile, error: String(error).slice(0, 500) });
		throw error;
	}
	const startupCleanup: Array<() => void | Promise<void>> = [() => adapter.disconnect()];
	try {

	const memory = new MemoryStore(config.memory.dbPath);
	startupCleanup.push(() => memory.close());
	const automation = new AutomationStore(config.memory.dbPath);
	startupCleanup.push(() => automation.close());
	const mcp = new McpManager();
	startupCleanup.push(() => mcp.close());
	const mcpStatus = await mcp.connectAll(loadMcpConfig(config.mcp.configPath));
	for (const status of mcpStatus) {
		if (status.connected) console.info(`[beemax] MCP ${status.name}: connected (${status.tools.length} tools, ${status.resources} resources, ${status.prompts} prompts)`);
		else console.warn(`[beemax] MCP ${status.name}: unavailable (${status.error})`);
	}
	const apiKey = configuredApiKey(config.model.provider, config.model.apiKey) ?? "";
	const approvalBroker = new ToolApprovalBroker(async (source, text) => {
		await deliveryPort.sendText(source, text);
	}, undefined, (event) => recordGatewayEvent(config.paths.agentDir, "approval", {
		profile: config.profile,
		tool: event.toolName,
		allowed: event.allowed,
		reason: event.reason,
		conversation: `${event.source.platform}:${event.source.chatId}`,
	}));
	const mcpApproval = new Set(mcp.getApprovalTools());
	const readOnlyMcpTools = mcp.getTools().filter((tool) => !mcpApproval.has(tool.name));
	const mainMcpTools = config.agent.toolset === "safe" ? readOnlyMcpTools : mcp.getTools();
	const feishuMeetingTools = createFeishuMeetingTools(() => adapter.apiClient);

	let scheduler: AutomationScheduler | undefined;
	const profileAgentDefaults = {
		provider: () => config.model.provider,
		model: () => config.model.model,
		baseUrl: () => config.model.baseUrl,
		customProtocol: () => config.model.customProtocol,
		cwd: config.paths.cwd,
		agentDir: config.paths.agentDir,
		getApiKey: (provider: string) => config.model.apiKeys[provider] ?? (provider === config.model.provider ? apiKey : undefined),
		skillToolset: config.agent.toolset,
		memoryStore: memory,
		executionPortForSource: executionPortFor(config),
	};
	const createSubagentAgent = buildAgentFactory({
		...profileAgentDefaults,
		systemPrompt: () => buildSubagentSystemPrompt(profilePrompt(config)),
		customTools: readOnlyMcpTools,
		tools: executionSafeTools(config, readOnlyAgentTools(readOnlyMcpTools.map((tool) => tool.name))),
	});
	const subagents = config.subagents.enabled ? new SubagentManager({
		maxConcurrent: config.subagents.maxConcurrent,
		maxChildrenPerOwner: config.subagents.maxChildrenPerOwner,
		defaultTimeoutMs: config.subagents.timeoutMs,
		execute: async (task, signal) => executeSubagentTask(createSubagentAgent, task, signal),
	}) : undefined;
	const createAgent = buildAgentFactory({
		...profileAgentDefaults,
		systemPrompt: () => profilePrompt(config),
		tools: executionSafeTools(config, mainAgentTools(config.agent.toolset, mainMcpTools.map((tool) => tool.name))),
		customTools: [...mainMcpTools, ...feishuMeetingTools],
		sessionTools: (source) => subagents ? createSubagentTools(subagents, source) : [],
		approvalTools: config.agent.toolset === "safe" ? [] : mcp.getApprovalTools(),
		automationStore: automation,
		wakeAutomation: () => scheduler?.wake(),
		imageGeneration: {
			enabled: config.imageGeneration.enabled,
			quality: config.imageGeneration.quality,
			outputDir: config.imageGeneration.outputDir,
			mediaOutbox: {
				enqueueMedia: async (owner, media) => { automation.enqueueMedia(owner, media); },
			},
		},
		authorizeTool: (request, signal) => approvalBroker.authorize(request, signal),
	});

	const createAutomationAgent = buildAgentFactory({
		...profileAgentDefaults,
		automationStore: automation,
		customTools: [...readOnlyMcpTools, ...feishuMeetingTools],
		tools: executionSafeTools(config, readOnlyAgentTools(readOnlyMcpTools.map((tool) => tool.name), [
			"schedule_list", "schedule_runs", "feishu_meeting_get", "feishu_meeting_list",
			"feishu_meeting_reserve_get", "feishu_meeting_reserve_active_get", "feishu_meeting_recording_get",
		])),
	});

	let runtime: BeeMaxAgentRuntime<SessionSource>;
	runtime = createProfileRuntime(
		{ maxSessions: config.agent.maxSessions, sessionIdleMs: config.agent.sessionIdleMs },
		{
			createAgent,
			createAutomationAgent,
			context: createTaskAwareConversationContext(memory, { recordDirectRoute: (route) => automation.setLastRoute(route), runtimeSnapshot: () => ({ model: `${config.model.provider}/${config.model.model}`, profile: config.profile }) }),
			controlHandler: (input) => createProfileControlHandler(runtime, config)(input),
		},
	);
	const dispatcher = new Dispatcher(
		{
			runtime,
			profileId: config.profile,
			cardOptions: { title: config.profile === "default" ? "BeeMax Agent" : `BeeMax · ${config.profile}`, reasoningDisplay: config.agent.reasoningDisplay },
			flushIntervalMs: 800,
			approvalBroker,
			cancelTasks: (source) => subagents?.cancelOwner(source) ?? 0,
		},
		adapter,
	);

	scheduler = new AutomationScheduler(automation, async (job) => {
		if (job.kind === "reminder") {
			await deliveryPort.sendText(job, `⏰ ${job.text}`);
			return { output: job.text };
		}
		const source: SessionSource = {
			platform: "feishu",
			chatId: job.chatId,
			chatType: "dm",
			userIdAlt: job.userId,
		};
		const answer = await dispatcher.runAutomation(source, job.text, { key: `schedule:${job.id}`, timeoutMs: 10 * 60_000 });
		await deliveryPort.sendText(job, `🗓️ ${job.name}\n\n${answer}`);
		return { output: answer };
	});
	const heartbeat = new HeartbeatRunner(
		automation,
		{
			enabled: config.automation.enabled && config.automation.heartbeat.enabled,
			every: config.automation.heartbeat.every,
			platform: "feishu",
			chatId: config.automation.heartbeat.chatId,
			userId: config.automation.heartbeat.userId,
			prompt: config.automation.heartbeat.prompt,
			ackMaxChars: config.automation.heartbeat.ackMaxChars,
			timeoutMs: config.automation.heartbeat.timeoutMs,
			activeHours: config.automation.heartbeat.activeHours,
		},
		(input) => dispatcher.runAutomation(
			{ platform: "feishu", chatId: input.route.chatId, chatType: "dm", userIdAlt: input.route.userId },
			input.prompt,
			{ key: "heartbeat", timeoutMs: input.timeoutMs },
		),
		{ sendText: (route, text) => deliveryPort.sendText(route, `💓 ${text}`), sendMedia: (route, media) => deliveryPort.sendMedia(route, media) },
		() => dispatcher.isBusy(),
	);

	const ok = await adapter.connect();
	if (!ok) {
		throw new Error("Failed to connect Feishu adapter");
	}
	writeGatewayState(config.paths.agentDir, { profile: config.profile, lifecycle: "running", version: gatewayVersion, pid: process.pid, startedAt: new Date().toISOString() });
	recordGatewayEvent(config.paths.agentDir, "started", { profile: config.profile, pid: process.pid, version: gatewayVersion });
	console.info(`[beemax:${config.profile}] Feishu gateway connected (model: ${config.model.provider}/${config.model.model})`);
	if (config.automation.enabled) scheduler.start();
	heartbeat.start();
	const mediaDeliveryTimer = setInterval(() => {
		void flushMediaDeliveries(automation, deliveryPort).catch((error) => console.error(`[beemax] media delivery worker failed: ${String(error)}`));
	}, 5_000);
	void flushMediaDeliveries(automation, deliveryPort).catch((error) => console.error(`[beemax] media delivery worker failed: ${String(error)}`));

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = () => {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async () => {
			console.info("\n[beemax] shutting down...");
			clearInterval(mediaDeliveryTimer);
			try { await heartbeat.stop(); } catch (error) { console.error(`[beemax] heartbeat shutdown failed: ${String(error)}`); }
			try { await scheduler?.stop(); } catch (error) { console.error(`[beemax] scheduler shutdown failed: ${String(error)}`); }
			try { await subagents?.dispose(); } catch (error) { console.error(`[beemax] Sub-Agent shutdown failed: ${String(error)}`); }
			try { dispatcher.dispose(); } catch (error) { console.error(`[beemax] dispatcher shutdown failed: ${String(error)}`); }
			try { runtime.dispose(); } catch (error) { console.error(`[beemax] Agent Runtime shutdown failed: ${String(error)}`); }
			try { await adapter.disconnect(); } catch (error) { console.error(`[beemax] Feishu disconnect failed: ${String(error)}`); }
			try { await mcp.close(); } catch (error) { console.error(`[beemax] MCP shutdown failed: ${String(error)}`); }
			try { automation.close(); } catch (error) { console.error(`[beemax] automation shutdown failed: ${String(error)}`); }
			try { memory.close(); } catch (error) { console.error(`[beemax] memory shutdown failed: ${String(error)}`); }
			await releaseChannelLock();
			writeGatewayState(config.paths.agentDir, { profile: config.profile, lifecycle: "stopped", version: gatewayVersion, pid: process.pid, stoppedAt: new Date().toISOString() });
			recordGatewayEvent(config.paths.agentDir, "stopped", { profile: config.profile, pid: process.pid });
			process.exit(0);
		})();
		return shutdownPromise;
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	} catch (error) {
		writeGatewayState(config.paths.agentDir, { profile: config.profile, lifecycle: "failed", version: gatewayVersion, pid: process.pid, stoppedAt: new Date().toISOString(), lastError: String(error).slice(0, 500) });
		recordGatewayEvent(config.paths.agentDir, "failed", { profile: config.profile, error: String(error).slice(0, 500) });
		for (const cleanup of startupCleanup.reverse()) {
			try { await cleanup(); } catch { /* preserve the original startup error */ }
		}
		await releaseChannelLock();
		throw error;
	}
}

async function flushMediaDeliveries(automation: AutomationStore, deliveryPort: import("@beemax/core").DeliveryPort): Promise<void> {
	for (const item of automation.claimMediaDue(Date.now(), 4)) {
		try {
			await deliveryPort.sendMedia(item, { path: item.path, mimeType: item.mimeType });
			automation.completeMedia(item.id);
		} catch {
			automation.failMedia(item.id);
		}
	}
}

export async function executeSubagentTask(
	factory: ReturnType<typeof buildAgentFactory>,
	task: SubagentTask,
	signal: AbortSignal,
): Promise<string> {
	const source: SessionSource = {
		...task.source,
		threadId: `__subagent:${task.id}`,
		messageId: undefined,
	};
	const runtime = new BeeMaxAgentRuntime({ createAgent: factory });
	try {
		const result = await runtime.run({ source, signal, timeoutMs: task.timeoutMs || 10 * 60_000, expandPromptTemplates: false, mode: "automation", text: [
			"[Sub-Agent Task]",
			`Name: ${task.name}`,
			`Capability: ${task.capability}`,
			`Goal: ${task.goal}`,
			task.context ? `Context:\n${task.context}` : "Context: none supplied",
			"Return a concise structured result with findings, evidence, and unresolved issues. Do not claim actions you could not verify.",
		].join("\n\n") });
		const answer = result.answer.trim();
		if (!answer) throw new Error("Sub-Agent returned no answer");
		return answer;
	} finally {
		runtime.dispose();
	}
}

export function buildSubagentSystemPrompt(parentPrompt?: string): string {
	return [
		parentPrompt ?? "You are a focused BeeMax Sub-Agent working for a parent personal Agent.",
		"# Sub-Agent isolation",
		"You have a fresh context and only the task below. Work independently and return evidence to the parent Agent.",
		"You cannot contact the user, mutate long-term memory, modify files, run shell commands, change Skills, schedule work, or spawn more agents.",
	].join("\n\n");
}

function profilePrompt(config: BeeMaxConfig): string {
	return [config.agent.systemPrompt, curatedMemoryPrompt(config.paths.agentDir), workspaceToolsPrompt(config.paths.cwd)]
		.filter((part): part is string => Boolean(part?.trim()))
		.join("\n\n");
}

export function readOnlyAgentTools(mcpTools: string[], additionalTools: string[] = []): string[] {
	return [
		"read", "grep", "find", "ls", "web_search", "agent_reach_search", "web_extract",
		"memory_recall", "memory_list",
		...additionalTools,
		...mcpTools,
	];
}

export function mainAgentTools(toolset: "safe" | "standard", mcpTools: string[]): string[] {
	const readOnly = readOnlyAgentTools(mcpTools, [
		"memory_status", "memory_candidates",
		"schedule_list", "schedule_runs", "skill_list", "skill_read", "task_status", "task_wait",
		"feishu_meeting_get", "feishu_meeting_list", "feishu_meeting_reserve_get", "feishu_meeting_reserve_active_get", "feishu_meeting_recording_get",
	]);
	if (toolset === "safe") return readOnly;
	return [
		...readOnly,
		"bash", "edit", "write", "memory_remember", "memory_promote", "memory_reject", "memory_forget",
		"reminder_create", "schedule_create", "schedule_pause", "schedule_resume", "schedule_delete",
		"skill_create", "skill_update", "task_spawn", "task_cancel", "image_generate",
		"feishu_meeting_reserve_create", "feishu_meeting_reserve_update", "feishu_meeting_reserve_delete",
		"feishu_meeting_end", "feishu_meeting_invite", "feishu_meeting_kickout", "feishu_meeting_set_host",
		"feishu_meeting_recording_set_permission", "feishu_meeting_recording_start", "feishu_meeting_recording_stop",
	];
}

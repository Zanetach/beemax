/**
 * `beemax gateway` - start the Feishu gateway.
 *
 * Connects the Feishu WSClient for inbound events, drives the Pi agent per
 * chat, and renders streaming replies as continuously-updated Feishu
 * interactive cards (pure TS card pipeline - no Python sidecar). Every turn
 * is also persisted to the FTS5 memory store for cross-session recall.
 */

import { AutomationScheduler, AutomationStore, HeartbeatRunner } from "@beemax/automation";
import {
	buildAgentFactory,
	createSubagentTools,
	Dispatcher,
	FeishuAdapter,
	type FeishuSettings,
	loadMcpConfig,
	McpManager,
	SubagentManager,
	ToolApprovalBroker,
	type SubagentTask,
} from "@beemax/gateway";
import { MemoryStore } from "@beemax/memory";
import type { SessionSource } from "@beemax/gateway";
import { beemaxHome, type BeeMaxConfig } from "./config.ts";
import { acquireChannelLock } from "./channel-lock.ts";

export async function runGateway(config: BeeMaxConfig): Promise<void> {
	if (!config.feishu.appId || !config.feishu.appSecret) {
		throw new Error(
			"Feishu credentials missing. Set FEISHU_APP_ID / FEISHU_APP_SECRET or configure feishu.appId/appSecret in config/beemax.yaml.",
		);
	}
	const feishuSettings: FeishuSettings = {
		appId: config.feishu.appId,
		appSecret: config.feishu.appSecret,
		domain: config.feishu.domain,
		connectionMode: config.feishu.connectionMode,
		webhookHost: config.feishu.webhookHost,
		webhookPort: config.feishu.webhookPort,
		webhookPath: config.feishu.webhookPath,
		webhookVerificationToken: config.feishu.webhookVerificationToken,
		webhookEncryptKey: config.feishu.webhookEncryptKey,
		requireMention: config.feishu.requireMention,
		allowedUsers: config.feishu.allowedUsers,
		allowedChats: config.feishu.allowedChats,
		allowAllUsers: config.feishu.allowAllUsers,
	};
	const adapter = new FeishuAdapter(feishuSettings);
	const releaseChannelLock = await acquireChannelLock(beemaxHome(), config.feishu.appId);
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
		if (status.connected) console.info(`[beemax] MCP ${status.name}: connected (${status.tools.length} tools)`);
		else console.warn(`[beemax] MCP ${status.name}: unavailable (${status.error})`);
	}
	const apiKey = config.model.apiKey ?? process.env[apiKeyEnv(config.model.provider)] ?? "";
	const approvalBroker = new ToolApprovalBroker(async (source, text) => {
		const result = await adapter.send(source.chatId, text);
		if (!result.success) throw new Error(result.error ?? "Feishu approval message failed");
	});
	const mcpApproval = new Set(mcp.getApprovalTools());
	const readOnlyMcpTools = mcp.getTools().filter((tool) => !mcpApproval.has(tool.name));

	let scheduler: AutomationScheduler | undefined;
	const createSubagentAgent = buildAgentFactory({
		provider: config.model.provider,
		model: config.model.model,
		baseUrl: config.model.baseUrl,
		cwd: config.paths.cwd,
		agentDir: config.paths.agentDir,
		getApiKey: () => apiKey,
		systemPrompt: buildSubagentSystemPrompt(config.agent.systemPrompt),
		memoryStore: memory,
		customTools: readOnlyMcpTools,
		tools: [
			"read", "grep", "find", "ls", "web_search", "web_extract", "memory_recall", "memory_list",
			...readOnlyMcpTools.map((tool) => tool.name),
		],
	});
	const subagents = config.subagents.enabled ? new SubagentManager({
		maxConcurrent: config.subagents.maxConcurrent,
		maxChildrenPerOwner: config.subagents.maxChildrenPerOwner,
		defaultTimeoutMs: config.subagents.timeoutMs,
		execute: async (task, signal) => executeSubagentTask(createSubagentAgent, task, signal),
	}) : undefined;
	const createAgent = buildAgentFactory({
		provider: config.model.provider,
		model: config.model.model,
		baseUrl: config.model.baseUrl,
		cwd: config.paths.cwd,
		agentDir: config.paths.agentDir,
		getApiKey: () => apiKey,
		systemPrompt: config.agent.systemPrompt,
		getFeishuClient: () => adapter.apiClient,
		memoryStore: memory,
		customTools: mcp.getTools(),
		sessionTools: (source) => subagents ? createSubagentTools(subagents, source) : [],
		approvalTools: mcp.getApprovalTools(),
		automationStore: automation,
		wakeAutomation: () => scheduler?.wake(),
		imageGeneration: {
			enabled: config.imageGeneration.enabled,
			quality: config.imageGeneration.quality,
			outputDir: config.imageGeneration.outputDir,
			deliver: async (source, path) => {
				const sent = await adapter.sendImage(source.chatId, path);
				if (!sent.success) throw new Error(sent.error ?? "Feishu image delivery failed");
			},
		},
		authorizeTool: (request, signal) => approvalBroker.authorize(request, signal),
	});

	const createAutomationAgent = buildAgentFactory({
		provider: config.model.provider,
		model: config.model.model,
		baseUrl: config.model.baseUrl,
		cwd: config.paths.cwd,
		agentDir: config.paths.agentDir,
		getApiKey: () => apiKey,
		systemPrompt: config.agent.systemPrompt,
		getFeishuClient: () => adapter.apiClient,
		memoryStore: memory,
		automationStore: automation,
		customTools: readOnlyMcpTools,
		tools: [
			"read", "grep", "find", "ls", "web_search", "web_extract", "memory_recall", "memory_list",
			"schedule_list", "schedule_runs", "feishu_meeting_get", "feishu_meeting_list",
			"feishu_meeting_reserve_get", "feishu_meeting_reserve_active_get", "feishu_meeting_recording_get",
			...readOnlyMcpTools.map((tool) => tool.name),
		],
	});

	const dispatcher = new Dispatcher(
		{
			createAgent,
			createAutomationAgent,
			cardOptions: { title: config.profile === "default" ? "BeeMax Agent" : `BeeMax · ${config.profile}` },
			flushIntervalMs: 800,
			approvalBroker,
			cancelTasks: (source) => subagents?.cancelOwner(source) ?? 0,
			recall: async (source: SessionSource, text: string) => {
				const hits = memory.recall(text, {
					limit: 4,
					platform: source.platform,
					chatId: source.chatId,
					userId: source.userIdAlt ?? source.userId,
				});
				if (hits.length === 0) return undefined;
				const ctx = hits.map((h) => `[${h.role}] ${h.content.slice(0, 500)}`).join("\n---\n");
				return `Relevant memory from past conversations:\n${ctx}\n---\nCurrent message: ${text}`;
			},
			remember: async (source, exchange) => {
				if (source.chatType === "dm") {
					automation.setLastRoute({
						platform: source.platform,
						chatId: source.chatId,
						userId: source.userIdAlt ?? source.userId,
					});
				}
				memory.remember({
					platform: source.platform,
					chatId: source.chatId,
					userId: source.userIdAlt ?? source.userId,
					role: "user",
					content: exchange.user,
				});
				memory.remember({
					platform: source.platform,
					chatId: source.chatId,
					userId: source.userIdAlt ?? source.userId,
					role: "assistant",
					content: exchange.assistant,
				});
			},
		},
		adapter,
	);

	scheduler = new AutomationScheduler(automation, async (job) => {
		if (job.kind === "reminder") {
			const sent = await adapter.send(job.chatId, `⏰ ${job.text}`);
			if (!sent.success) throw new Error(sent.error ?? "Reminder delivery failed");
			return { output: job.text };
		}
		const source: SessionSource = {
			platform: "feishu",
			chatId: job.chatId,
			chatType: "dm",
			userIdAlt: job.userId,
		};
		const answer = await dispatcher.runAutomation(source, job.text, { key: `schedule:${job.id}`, timeoutMs: 10 * 60_000 });
		const sent = await adapter.send(job.chatId, `🗓️ ${job.name}\n\n${answer}`);
		if (!sent.success) throw new Error(sent.error ?? "Scheduled task delivery failed");
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
		async (route, text) => {
			const sent = await adapter.send(route.chatId, `💓 ${text}`);
			if (!sent.success) throw new Error(sent.error ?? "Heartbeat delivery failed");
		},
		() => dispatcher.isBusy(),
	);

	let ok: boolean;
	try {
		ok = await adapter.connect();
	} catch (error) {
		for (const cleanup of startupCleanup.reverse()) {
			try { await cleanup(); } catch { /* preserve the original startup error */ }
		}
		await releaseChannelLock();
		throw error;
	}
	if (!ok) {
		console.error("Failed to connect Feishu adapter");
		await releaseChannelLock();
		process.exit(1);
	}
	console.info(`[beemax:${config.profile}] Feishu gateway connected (model: ${config.model.provider}/${config.model.model})`);
	if (config.automation.enabled) scheduler.start();
	heartbeat.start();

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = () => {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async () => {
			console.info("\n[beemax] shutting down...");
			try { await heartbeat.stop(); } catch (error) { console.error(`[beemax] heartbeat shutdown failed: ${String(error)}`); }
			try { await scheduler?.stop(); } catch (error) { console.error(`[beemax] scheduler shutdown failed: ${String(error)}`); }
			try { await subagents?.dispose(); } catch (error) { console.error(`[beemax] Sub-Agent shutdown failed: ${String(error)}`); }
			try { dispatcher.dispose(); } catch (error) { console.error(`[beemax] dispatcher shutdown failed: ${String(error)}`); }
			try { await adapter.disconnect(); } catch (error) { console.error(`[beemax] Feishu disconnect failed: ${String(error)}`); }
			try { await mcp.close(); } catch (error) { console.error(`[beemax] MCP shutdown failed: ${String(error)}`); }
			try { automation.close(); } catch (error) { console.error(`[beemax] automation shutdown failed: ${String(error)}`); }
			try { memory.close(); } catch (error) { console.error(`[beemax] memory shutdown failed: ${String(error)}`); }
			await releaseChannelLock();
			process.exit(0);
		})();
		return shutdownPromise;
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	} catch (error) {
		await releaseChannelLock();
		throw error;
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
	const session = await factory(`subagent-${task.id}`, source);
	const abort = () => { void session.abort(); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		if (signal.aborted) await session.abort();
		await session.prompt([
			"[Sub-Agent Task]",
			`Name: ${task.name}`,
			`Capability: ${task.capability}`,
			`Goal: ${task.goal}`,
			task.context ? `Context:\n${task.context}` : "Context: none supplied",
			"Return a concise structured result with findings, evidence, and unresolved issues. Do not claim actions you could not verify.",
		].join("\n\n"), { expandPromptTemplates: false, source: "extension" });
		const answer = lastAssistantAnswer(session.agent.state.messages);
		if (!answer) throw new Error("Sub-Agent returned no answer");
		return answer;
	} finally {
		signal.removeEventListener("abort", abort);
		session.dispose();
	}
}

function lastAssistantAnswer(messages: ReadonlyArray<{ role: string; content?: unknown }>): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		return message.content
			.filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: string }).type === "text"))
			.map((item) => item.text)
			.join("")
			.trim();
	}
	return "";
}

export function buildSubagentSystemPrompt(parentPrompt?: string): string {
	return [
		parentPrompt ?? "You are a focused BeeMax Sub-Agent working for a parent personal Agent.",
		"# Sub-Agent isolation",
		"You have a fresh context and only the task below. Work independently and return evidence to the parent Agent.",
		"You cannot contact the user, mutate long-term memory, modify files, run shell commands, change Skills, schedule work, or spawn more agents.",
	].join("\n\n");
}

function apiKeyEnv(provider: string): string {
	const map: Record<string, string> = {
		anthropic: "ANTHROPIC_API_KEY",
		openai: "OPENAI_API_KEY",
		google: "GOOGLE_GENERATIVE_AI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	};
	return map[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

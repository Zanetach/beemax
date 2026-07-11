import { type AgentControlHandler, type InteractionEventAdapter, type ProfileTaskSchedulerSnapshot } from "@beemax/core";
import type { SessionSource } from "@beemax/gateway";
import type { BeeMaxAgentRuntime } from "@beemax/core";
import type { BeeMaxConfig } from "./config.ts";
import { configureModel } from "./profile-config.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfileModelCatalog } from "./model-catalog.ts";

export interface ProfileOperationalFacts { taskScheduler?: ProfileTaskSchedulerSnapshot; }

export function renderTaskSchedulerStatus(snapshot?: ProfileTaskSchedulerSnapshot): string {
	return snapshot ? `Tasks: running=${snapshot.running}; queued=${snapshot.queued}; queued-owners=${snapshot.queuedOwners}; capacity=${snapshot.maxConcurrent}` : "Tasks: scheduler unavailable";
}

/** Profile control plane shared by local chat and every Gateway channel. */
export function createProfileControlHandler(
	runtime: BeeMaxAgentRuntime<SessionSource>,
	config: BeeMaxConfig,
	interaction?: InteractionEventAdapter<SessionSource>,
	operationalFacts?: () => ProfileOperationalFacts,
): AgentControlHandler<SessionSource> {
	return async ({ source, text }) => {
		const models = new ProfileModelCatalog(config);
		const command = text.trim().toLowerCase();
		if (command === "/new" || command === "/reset") {
			if (command === "/reset") {
				if (interaction) await interaction.dispatch({ type: "session.reset", source }); else runtime.reset(source);
			}
			const nextSource = { ...source, threadId: `conversation-${crypto.randomUUID()}` };
			if (interaction) await interaction.dispatch({ type: "session.open", source: nextSource }); else await runtime.open(nextSource);
			return { handled: true, nextSource, message: `${command === "/reset" ? "Reset and started" : "Started"} new session: ${nextSource.threadId}` };
		}
		if (command === "/sessions") {
			const sessions = await runtime.listSavedSessions(source);
			return { handled: true, message: sessions.length ? sessions.map((session) => `${session.threadId ?? "default"}  ${new Date(session.lastUsedAt).toLocaleString()}`).join("\n") : "No saved sessions." };
		}
		if (command === "/skills") {
			try {
				const entries = await readdir(join(config.paths.agentDir, "skills"), { withFileTypes: true });
				const skills = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
					const content = await readFile(join(config.paths.agentDir, "skills", entry.name, "SKILL.md"), "utf8").catch(() => "");
					const description = content.match(/^description:\s*(.+)$/m)?.[1]?.replaceAll('"', "").trim();
					return description ? `${entry.name}  ${description}` : undefined;
				}));
				return { handled: true, message: skills.filter((skill): skill is string => Boolean(skill)).sort().join("\n") || "No Profile Skills installed." };
			} catch { return { handled: true, message: "No Profile Skills installed." }; }
		}
		const resume = text.trim().match(/^\/resume\s+([^\s]+)$/i);
		if (resume) {
			const nextSource = resume[1] === "default" ? { ...source, threadId: undefined } : { ...source, threadId: resume[1] };
			if (!await runtime.hasSavedSession(nextSource)) return { handled: true, message: `Unknown session '${resume[1]}'. Use /sessions to list saved sessions.` };
			if (interaction) await interaction.dispatch({ type: "session.open", source: nextSource }); else await runtime.open(nextSource);
			return { handled: true, nextSource, message: `Restored session: ${nextSource.threadId ?? "default"}.` };
		}
		const history = command.match(/^\/history(?:\s+(\d{1,3}))?$/);
		if (history) {
			const entries = await runtime.history(source, history[1] ? Number(history[1]) : undefined);
			return { handled: true, message: entries.length ? entries.map((entry) => `[${entry.role}] ${entry.text.replaceAll("\n", " ")}`).join("\n") : "No live message history." };
		}
		if (command === "/help") return { handled: true, message: "Commands: /help /status /usage /compact /sessions /resume <id> /history [n] /skills /tasks /new /reset /model [provider/model] [--global] /stop\nCLI also supports local display, tool, and retry controls." };
		if (command === "/status" || command === "/usage") {
			const [model, usage] = await Promise.all([runtime.modelStatus(source), runtime.usage(source)]);
			const usageText = usage ? `input=${usage.inputTokens}; output=${usage.outputTokens}; context=${usage.contextTokens ?? "?"}/${usage.contextWindow ?? "?"}` : "no live session";
			return { handled: true, message: command === "/usage" ? `Usage: ${usageText}` : `Profile: ${config.profile}\nModel: ${model?.model ?? `${config.model.provider}/${config.model.model}`}\nThinking: ${model?.thinkingLevel ?? "off"}\nRun: ${runtime.isBusy() ? "running" : "idle"}\n${renderTaskSchedulerStatus(operationalFacts?.().taskScheduler)}\nUsage: ${usageText}` };
		}
		if (command === "/compact") {
			const compacted = interaction
				? await interaction.dispatch({ type: "session.compact", source })
				: { compacted: await runtime.compact(source) };
			return { handled: true, message: "compacted" in compacted && compacted.compacted ? "Context compacted." : "No idle session is available to compact." };
		}
		if (command === "/tasks") {
			const tasks = runtime.tasks(source, { limit: 50 });
			return { handled: true, message: tasks.length ? tasks.map((task) => `${task.id}  [${task.kind}/${task.status}]  ${task.title}`).join("\n") : "No durable Tasks are visible to this conversation." };
		}
		if (!command.startsWith("/model")) return undefined;
		const global = /\s--global\s*$/i.test(text);
		const requested = text.trim().slice("/model".length).replace(/\s--global\s*$/i, "").trim();
		if (!requested) {
			const current = await runtime.modelStatus(source);
			return { handled: true, message: `Profile default: ${config.model.provider}/${config.model.model}\nSession model: ${current?.model ?? "not loaded"}\nThinking: ${current?.thinkingLevel ?? "not loaded"}${current ? ` (supported: ${current.supportedThinkingLevels.join(", ")})` : ""}\nConfigured: ${models.list().map((entry) => entry.key).join(", ")}` };
		}
		const selected = models.resolve(requested);
		if (!selected) return { handled: true, message: `Model is not configured for this Profile. Available: ${models.list().map((entry) => entry.key).join(", ")}` };
		if (!selected.runtimeModel) return { handled: true, message: `Pi does not have a runtime model definition for ${requested}. Configure it as a supported Provider model first.` };
		if (!await runtime.setModel(source, selected.runtimeModel)) {
			return { handled: true, message: "No idle Agent session exists yet, or the Agent is busy. Try again after the current turn." };
		}
		const choice = config.models.find((item) => `${item.provider}/${item.model}` === selected.key)!;
		config.model = { ...choice, apiKey: config.model.apiKeys[choice.provider], apiKeys: config.model.apiKeys };
		if (global) {
			await configureModel(config.profile, { provider: choice.provider, model: choice.model, baseUrl: choice.baseUrl, customProtocol: choice.customProtocol });
			return { handled: true, message: `Switched this conversation to ${requested} and saved it as the Profile default.` };
		}
		return { handled: true, message: `Switched this conversation to ${requested}.` };
	};
}

import { getBuiltinModel, type AgentControlHandler, type Api, type Model } from "@beemax/core";
import type { SessionSource } from "@beemax/gateway";
import type { BeeMaxAgentRuntime } from "@beemax/core";
import type { BeeMaxConfig } from "./config.ts";
import { configureModel } from "./profile-config.ts";

/** Profile control plane shared by local chat and every Gateway channel. */
export function createProfileControlHandler(
	runtime: BeeMaxAgentRuntime<SessionSource>,
	config: BeeMaxConfig,
): AgentControlHandler<SessionSource> {
	return async ({ source, text }) => {
		const command = text.trim().toLowerCase();
		if (command === "/new" || command === "/reset") {
			const nextSource = { ...source, threadId: `conversation-${crypto.randomUUID()}` };
			return { handled: true, nextSource, message: `${command === "/reset" ? "Reset and started" : "Started"} new session: ${nextSource.threadId}` };
		}
		if (command === "/help") return { handled: true, message: "Commands: /help /status /usage /compact /model [provider/model] [--global] /stop\nCLI also supports local session, display, tool, and retry controls." };
		if (command === "/status" || command === "/usage") {
			const [model, usage] = await Promise.all([runtime.modelStatus(source), runtime.usage(source)]);
			const usageText = usage ? `input=${usage.inputTokens}; output=${usage.outputTokens}; context=${usage.contextTokens ?? "?"}/${usage.contextWindow ?? "?"}` : "no live session";
			return { handled: true, message: command === "/usage" ? `Usage: ${usageText}` : `Profile: ${config.profile}\nModel: ${model?.model ?? `${config.model.provider}/${config.model.model}`}\nThinking: ${model?.thinkingLevel ?? "off"}\nRun: ${runtime.isBusy() ? "running" : "idle"}\nUsage: ${usageText}` };
		}
		if (command === "/compact") {
			return { handled: true, message: await runtime.compact(source) ? "Context compacted." : "No idle session is available to compact." };
		}
		if (!command.startsWith("/model")) return undefined;
		const global = /\s--global\s*$/i.test(text);
		const requested = text.trim().slice("/model".length).replace(/\s--global\s*$/i, "").trim();
		if (!requested) {
			const current = await runtime.modelStatus(source);
			return { handled: true, message: `Profile default: ${config.model.provider}/${config.model.model}\nSession model: ${current?.model ?? "not loaded"}\nThinking: ${current?.thinkingLevel ?? "not loaded"}${current ? ` (supported: ${current.supportedThinkingLevels.join(", ")})` : ""}\nConfigured: ${config.models.map(modelName).join(", ")}` };
		}
		const choice = config.models.find((item) => modelName(item) === requested);
		if (!choice) return { handled: true, message: `Model is not configured for this Profile. Available: ${config.models.map(modelName).join(", ")}` };
		const model = (getBuiltinModel as (provider: string, id: string) => Model<Api> | undefined)(choice.provider, choice.model);
		if (!model) return { handled: true, message: `Pi does not have a runtime model definition for ${requested}. Configure it as a supported Provider model first.` };
		if (!await runtime.setModel(source, choice.baseUrl ? { ...model, baseUrl: choice.baseUrl } : model)) {
			return { handled: true, message: "No idle Agent session exists yet, or the Agent is busy. Try again after the current turn." };
		}
		config.model = { ...choice, apiKey: config.model.apiKeys[choice.provider], apiKeys: config.model.apiKeys };
		if (global) {
			await configureModel(config.profile, { provider: choice.provider, model: choice.model, baseUrl: choice.baseUrl, customProtocol: choice.customProtocol });
			return { handled: true, message: `Switched this conversation to ${requested} and saved it as the Profile default.` };
		}
		return { handled: true, message: `Switched this conversation to ${requested}.` };
	};
}

function modelName(model: { provider: string; model: string }): string { return `${model.provider}/${model.model}`; }

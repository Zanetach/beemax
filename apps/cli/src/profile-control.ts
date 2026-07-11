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
		if (!text.trim().toLowerCase().startsWith("/model")) return undefined;
		const global = /\s--global\s*$/i.test(text);
		const requested = text.trim().slice("/model".length).replace(/\s--global\s*$/i, "").trim();
		if (!requested) return {
			handled: true,
			message: `Current Profile default: ${config.model.provider}/${config.model.model}\nConfigured: ${config.models.map(modelName).join(", ")}`,
		};
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

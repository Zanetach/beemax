import { builtinProviders, getBuiltinModel, getSupportedThinkingLevels, type Api, type Model } from "@beemax/core";
import type { BeeMaxConfig } from "./config.ts";

export interface ModelProviderPreset {
	id: string;
	label: string;
	defaultModel: string;
	baseUrl?: string;
	requiresBaseUrl?: boolean;
}

export function modelProviderPresets(): readonly ModelProviderPreset[] {
	return [
		...builtinProviders().map((provider) => ({
			id: provider.id,
			label: provider.name,
			defaultModel: provider.getModels()[0]?.id ?? "",
			baseUrl: provider.baseUrl,
		})),
		{ id: "custom", label: "Custom OpenAI-compatible endpoint", defaultModel: "", requiresBaseUrl: true },
	];
}

export function presetFor(provider: string): ModelProviderPreset | undefined {
	return modelProviderPresets().find((preset) => preset.id === provider.trim().toLowerCase());
}

/** Interactive setup displays ordinal choices but persists Pi provider IDs. */
export function resolveProviderSelection(value: string): string {
	const input = value.trim().toLowerCase();
	if (!/^\d+$/.test(input)) return input;
	return modelProviderPresets()[Number(input) - 1]?.id ?? input;
}

export function renderModelProviderChoices(): string {
	return modelProviderPresets().map((preset, index) => `  ${index + 1}. ${preset.label} (${preset.id})`).join("\n");
}

/** Human-readable capabilities for the models configured in this Profile. */
export function renderConfiguredModels(config: BeeMaxConfig): string {
	return config.models.map((choice) => {
		const name = `${choice.provider}/${choice.model}`;
		const model = choice.provider === "custom" ? undefined : (getBuiltinModel as (provider: string, id: string) => Model<Api> | undefined)(choice.provider, choice.model);
		if (!model) return `${name}  configured; capability metadata unavailable`;
		const capabilities = [`input=${model.input.join("+")}`, `context=${model.contextWindow}`, `tools=${model.input.includes("text") ? "yes" : "no"}`, `thinking=${getSupportedThinkingLevels(model).join("/")}`];
		return `${name}  ${capabilities.join("; ")}`;
	}).join("\n") || "No models configured for this Profile.";
}

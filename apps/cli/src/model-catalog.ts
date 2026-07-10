import { builtinProviders } from "@beemax/core";

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

export function renderModelProviderChoices(): string {
	return modelProviderPresets().map((preset, index) => `  ${index + 1}. ${preset.label} (${preset.id})`).join("\n");
}

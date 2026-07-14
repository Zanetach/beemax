import { builtinProviders, getBuiltinModel, getSupportedThinkingLevels, MediaUnderstandingRuntime, PiVisionMediaUnderstandingAdapter, resolveRuntimeModel, type Api, type MediaUnderstandingAdapter, type Model } from "@beemax/core";
import type { BeeMaxConfig } from "./config.ts";

export interface ModelProviderPreset {
	id: string;
	label: string;
	defaultModel: string;
	baseUrl?: string;
	requiresBaseUrl?: boolean;
}

export interface ProfileModelCapability {
	key: string;
	provider: string;
	modelId: string;
	available: boolean;
	capabilities?: {
		input: string[];
		contextWindow: number;
		thinkingLevels: string[];
	};
	runtimeModel?: Model<Api>;
}

type ProfileModelConfig = Pick<BeeMaxConfig, "model" | "models">;

/** Profile-owned model facts derived once from configuration and Pi's registry. */
export class ProfileModelCatalog {
	private readonly entries: ProfileModelCapability[];

	constructor(config: ProfileModelConfig) {
		this.entries = config.models.map((choice) => {
			const key = `${choice.provider}/${choice.model}`;
			const known = choice.provider === "custom" ? undefined : (getBuiltinModel as (provider: string, id: string) => Model<Api> | undefined)(choice.provider, choice.model);
			const runtimeModel = known ? (choice.baseUrl ? { ...known, baseUrl: choice.baseUrl } : known) : undefined;
			return {
				key,
				provider: choice.provider,
				modelId: choice.model,
				available: Boolean(runtimeModel && config.model?.apiKeys?.[choice.provider]),
				capabilities: runtimeModel ? {
					input: [...runtimeModel.input],
					contextWindow: runtimeModel.contextWindow,
					thinkingLevels: [...getSupportedThinkingLevels(runtimeModel)],
				} : undefined,
				runtimeModel,
			};
		});
	}

	list(query?: string): ProfileModelCapability[] {
		const normalized = query?.trim().toLowerCase();
		return this.entries.filter((entry) => !normalized || entry.key.toLowerCase().includes(normalized)).map(copyEntry);
	}

	resolve(reference: string): ProfileModelCapability | undefined {
		const normalized = reference.trim();
		const entry = /^\d+$/.test(normalized) ? this.entries[Number(normalized) - 1] : this.entries.find((candidate) => candidate.key === normalized);
		return entry ? copyEntry(entry) : undefined;
	}

	runtimeModels(): Model<Api>[] {
		return this.entries.flatMap((entry) => entry.available && entry.runtimeModel ? [entry.runtimeModel] : []);
	}
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
	return new ProfileModelCatalog(config).list().map((entry) => {
		if (!entry.capabilities) return `${entry.key}  configured; capability metadata unavailable`;
		const capabilities = [`input=${entry.capabilities.input.join("+")}`, `context=${entry.capabilities.contextWindow}`, `tools=${entry.capabilities.input.includes("text") ? "yes" : "no"}`, `thinking=${entry.capabilities.thinkingLevels.join("/")}`];
		return `${entry.key}  ${capabilities.join("; ")}`;
	}).join("\n") || "No models configured for this Profile.";
}

/** Runtime-ready ordered model candidates; unsupported custom definitions stay out of automatic failover. */
export function configuredRuntimeModels(config: BeeMaxConfig): Model<Api>[] {
	return new ProfileModelCatalog(config).runtimeModels();
}

/** Runtime-ready text models with Profile-owned auth, including supported custom endpoints. */
export function configuredAuxiliaryTextModels(config: BeeMaxConfig): Array<{ model: Model<Api>; apiKey?: string }> {
	return config.models.flatMap((choice) => {
		try {
			const model = resolveRuntimeModel(choice.provider, choice.model, choice.baseUrl, choice.customProtocol, { contextWindow: choice.contextWindow, maxTokens: choice.maxTokens });
			if (!model.input.includes("text")) return [];
			const apiKey = config.model.apiKeys[choice.provider] ?? (choice.provider === config.model.provider ? config.model.apiKey : undefined);
			return apiKey ? [{ model, apiKey }] : [];
		} catch { return []; }
	});
}

/** Configured image-capable Pi models automatically become auxiliary perception adapters. */
export function configuredMediaUnderstanding(config: BeeMaxConfig, localAdapters: readonly MediaUnderstandingAdapter[] = []): MediaUnderstandingRuntime {
	const visionAdapters = config.mediaUnderstanding?.auxiliaryVisionEnabled === false ? [] : configuredRuntimeModels(config)
		.filter((model) => model.input.includes("image"))
		.map((model, index) => new PiVisionMediaUnderstandingAdapter({
			model,
			apiKey: config.model.apiKeys[model.provider] ?? (model.provider === config.model.provider ? config.model.apiKey : undefined),
			score: 80 - index,
		}));
	return new MediaUnderstandingRuntime([...visionAdapters, ...localAdapters]);
}

function copyEntry(entry: ProfileModelCapability): ProfileModelCapability {
	return { ...entry, capabilities: entry.capabilities ? { ...entry.capabilities, input: [...entry.capabilities.input], thinkingLevels: [...entry.capabilities.thinkingLevels] } : undefined };
}

import { builtinProviders, getBuiltinModel, getSupportedThinkingLevels, LexicalCapabilityRanker, MediaUnderstandingRuntime, PiSemanticCapabilityPort, PiVisionMediaUnderstandingAdapter, resolveRuntimeModel, SemanticCapabilityRanker, type Api, type CapabilityRanker, type MediaUnderstandingAdapter, type Model, type PiSemanticCapabilityPortOptions, type PiWorkContractModelCandidate } from "@beemax/core";
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

/**
 * Resolve the Profile's semantic-admission models without snapshotting OAuth
 * credentials. The initial lookup makes composition fail fast; each candidate
 * keeps a resolver so a long-running Gateway can refresh short-lived tokens.
 */
export async function resolveProfileCognitionModels(
	config: BeeMaxConfig,
	getCredential: (provider: string) => Promise<string | undefined>,
): Promise<PiWorkContractModelCandidate[]> {
	let mainModel: Model<Api>;
	try {
		const resolved = resolveRuntimeModel(config.model.provider, config.model.model, config.model.baseUrl, config.model.customProtocol, { contextWindow: config.model.contextWindow, maxTokens: config.model.maxTokens });
		mainModel = config.model.baseUrl ? { ...resolved, baseUrl: config.model.baseUrl } : resolved;
	} catch (error) {
		throw new Error(`Profile ${config.profile} main model ${config.model.provider}/${config.model.model} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const mainConfiguredKey = config.model.apiKeys[config.model.provider] ?? config.model.apiKey;
	const mainCredential = mainConfiguredKey || await getCredential(config.model.provider);
	if (!mainCredential) throw new Error(`Profile ${config.profile} main model ${config.model.provider}/${config.model.model} has no credential; configure its API key or run BeeMax authentication before starting this Profile`);
	if (!mainModel.input.includes("text")) throw new Error(`Profile ${config.profile} main model ${config.model.provider}/${config.model.model} does not accept text`);

	const candidates: PiWorkContractModelCandidate[] = [];
	for (const choice of config.models) {
		let model: Model<Api>;
		try {
			const resolved = resolveRuntimeModel(choice.provider, choice.model, choice.baseUrl, choice.customProtocol, { contextWindow: choice.contextWindow, maxTokens: choice.maxTokens });
			model = choice.baseUrl ? { ...resolved, baseUrl: choice.baseUrl } : resolved;
		}
		catch { continue; }
		if (!model.input.includes("text")) continue;
		const configuredKey = config.model.apiKeys[choice.provider] ?? (choice.provider === config.model.provider ? config.model.apiKey : undefined);
		const initialCredential = configuredKey || await getCredential(choice.provider);
		if (!initialCredential) continue;
		candidates.push({
			model,
			...(configuredKey ? { apiKey: configuredKey } : { getApiKey: () => getCredential(choice.provider) }),
		});
	}
	if (!candidates.length) throw new Error(`Profile ${config.profile} has no authenticated text model for semantic Work Contract cognition`);
	return candidates;
}

/** Semantic selection is the configured production path; lexical ranking is used only when this Profile has no semantic model. */
export function configuredCapabilityRanker(
	models: Array<{ model: Model<Api>; apiKey?: string }>,
	onUsage?: NonNullable<PiSemanticCapabilityPortOptions["onUsage"]>,
	options: Pick<PiSemanticCapabilityPortOptions, "maxModelAttempts" | "maxTokens" | "timeoutMs" | "maxTotalEstimatedTokens"> = {},
): CapabilityRanker {
	const lexical = new LexicalCapabilityRanker();
	return models.length ? new SemanticCapabilityRanker(new PiSemanticCapabilityPort({ models, ...options, ...(onUsage ? { onUsage } : {}) })) : lexical;
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

import { builtinProviders } from "@beemax/core";

/** The single Profile-level source of truth for model-provider metadata. */
export function providerApiKeyEnv(provider: string): string {
	const normalized = provider.trim().toLowerCase();
	const known: Record<string, string> = {
		anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_GENERATIVE_AI_API_KEY", openrouter: "OPENROUTER_API_KEY",
	};
	return known[normalized] ?? `${normalized.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

export function hasBuiltinProvider(provider: string): boolean {
	return builtinProviders().some((candidate) => candidate.id === provider);
}

export function configuredApiKey(provider: string, profileKey?: string): string | undefined {
	return profileKey || process.env.BEEMAX_API_KEY || process.env[providerApiKeyEnv(provider)];
}

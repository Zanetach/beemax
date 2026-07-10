export interface ModelProviderPreset {
	id: string;
	label: string;
	defaultModel: string;
	baseUrl?: string;
	requiresBaseUrl?: boolean;
}

export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
	{ id: "anthropic", label: "Anthropic Claude", defaultModel: "claude-sonnet-4-5" },
	{ id: "openai", label: "OpenAI API", defaultModel: "gpt-5.2" },
	{ id: "openrouter", label: "OpenRouter", defaultModel: "anthropic/claude-sonnet-4-5" },
	{ id: "google", label: "Google Gemini", defaultModel: "gemini-2.5-pro" },
	{ id: "deepseek", label: "DeepSeek", defaultModel: "deepseek-chat" },
	{ id: "ollama", label: "Ollama local", defaultModel: "qwen3:8b", baseUrl: "http://127.0.0.1:11434/v1" },
	{ id: "custom", label: "Custom OpenAI-compatible endpoint", defaultModel: "", requiresBaseUrl: true },
];

export function presetFor(provider: string): ModelProviderPreset | undefined {
	return MODEL_PROVIDER_PRESETS.find((preset) => preset.id === provider.trim().toLowerCase());
}

export function renderModelProviderChoices(): string {
	return MODEL_PROVIDER_PRESETS.map((preset, index) => `  ${index + 1}. ${preset.label} (${preset.id})`).join("\n");
}

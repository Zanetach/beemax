import { builtinImagesProviders, builtinProviders } from "@earendil-works/pi-ai/providers/all";

export interface RuntimeModelCapability {
	provider: string;
	id: string;
	name: string;
	kind: "chat" | "image";
	input: string[];
	output: string[];
	reasoning?: boolean;
}

export interface RuntimeProviderCapability {
	id: string;
	name: string;
	kind: "chat" | "image";
	models: RuntimeModelCapability[];
}

export interface RuntimeCapabilitySnapshot {
	runtime: "pi";
	providers: RuntimeProviderCapability[];
	primitives: readonly ["agent-loop", "session", "tool", "skill", "chat-provider", "image-provider"];
}

/** Neutral BeeMax view of the Provider capabilities registered by the bundled Pi runtime. */
export function getRuntimeCapabilitySnapshot(): RuntimeCapabilitySnapshot {
	const chat = builtinProviders().map((provider) => ({
		id: provider.id,
		name: provider.name,
		kind: "chat" as const,
		models: safeModels(() => provider.getModels()).map((model) => ({
			provider: provider.id,
			id: model.id,
			name: model.name,
			kind: "chat" as const,
			input: [...model.input],
			output: ["text"],
			reasoning: model.reasoning,
		})),
	}));
	const images = builtinImagesProviders().map((provider) => ({
		id: provider.id,
		name: provider.name,
		kind: "image" as const,
		models: safeModels(() => provider.getModels()).map((model) => ({
			provider: provider.id,
			id: model.id,
			name: model.name,
			kind: "image" as const,
			input: [...model.input],
			output: [...model.output],
		})),
	}));
	return {
		runtime: "pi",
		providers: [...chat, ...images].sort((a, b) => a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind)),
		primitives: ["agent-loop", "session", "tool", "skill", "chat-provider", "image-provider"],
	};
}

function safeModels<T>(getModels: () => readonly T[]): readonly T[] {
	try { return getModels(); } catch { return []; }
}

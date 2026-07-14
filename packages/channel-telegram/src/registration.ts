import type { ChannelAdapterRegistration, ChannelInstanceConfig } from "@beemax/channel-runtime";
import { TelegramAdapter, type TelegramAdapterDependencies, type TelegramCredentialConsumer, type TelegramCredentials, type TelegramSettings } from "./adapter.ts";

export interface TelegramAdapterRegistrationOptions {
	defaults: TelegramSettings | ((instance: ChannelInstanceConfig) => TelegramSettings);
	consumeCredentials<T>(instance: ChannelInstanceConfig, consumer: (credentials: Readonly<TelegramCredentials>) => T): T | undefined;
	dependencies?: TelegramAdapterDependencies;
	onCreated?: (instance: ChannelInstanceConfig, adapter: TelegramAdapter) => void;
}

const INSTANCE_KEYS = new Set<keyof TelegramSettings>(["allowedUsers", "allowedChats", "allowAllUsers", "pollingTimeoutSeconds", "retryBaseDelayMs", "apiBaseUrl", "mediaMaxBytes", "activation"]);

export function createTelegramAdapterRegistration(options: TelegramAdapterRegistrationOptions): ChannelAdapterRegistration {
	return {
		id: "telegram",
		create: (instance) => {
			if (instance.adapter !== "telegram") throw new Error(`Telegram registration cannot create Adapter '${instance.adapter}' for Channel Instance '${instance.id}'`);
			const valid = options.consumeCredentials(instance, (credentials) => Boolean(credentials.botToken.trim()));
			if (!valid) throw new Error(`Channel Instance '${instance.id}' is missing Telegram credentials for '${instance.credentialRef ?? "no Credential Ref"}'`);
			const defaults = typeof options.defaults === "function" ? options.defaults(instance) : options.defaults;
			const settings = normalizeTelegramInstanceSettings(instance.id, instance.settings, defaults);
			const consume: TelegramCredentialConsumer = (consumer) => options.consumeCredentials(instance, consumer);
			const adapter = new TelegramAdapter(settings, consume, options.dependencies);
			options.onCreated?.(instance, adapter);
			return adapter;
		},
	};
}

export function normalizeTelegramInstanceSettings(instanceId: string, value: unknown, defaults: TelegramSettings): TelegramSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Channel Instance '${instanceId}' Telegram settings must be an object`);
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) if (!INSTANCE_KEYS.has(key as keyof TelegramSettings)) throw new Error(`Channel Instance '${instanceId}' has unknown Telegram setting '${key}'`);
	for (const key of ["allowedUsers", "allowedChats"]) if (input[key] !== undefined && (!Array.isArray(input[key]) || !(input[key] as unknown[]).every((entry) => typeof entry === "string"))) throw new Error(`Channel Instance '${instanceId}' Telegram setting '${key}' must be a string array`);
	if (input.allowAllUsers !== undefined && typeof input.allowAllUsers !== "boolean") throw new Error(`Channel Instance '${instanceId}' Telegram setting 'allowAllUsers' must be boolean`);
	if (input.apiBaseUrl !== undefined && typeof input.apiBaseUrl !== "string") throw new Error(`Channel Instance '${instanceId}' Telegram setting 'apiBaseUrl' must be string`);
	for (const key of ["pollingTimeoutSeconds", "retryBaseDelayMs", "mediaMaxBytes"]) if (input[key] !== undefined && (typeof input[key] !== "number" || !Number.isFinite(input[key]))) throw new Error(`Channel Instance '${instanceId}' Telegram setting '${key}' must be a finite number`);
	if (input.activation !== undefined) validateActivation(instanceId, input.activation);
	return { ...defaults, ...input } as TelegramSettings;
}

function validateActivation(instanceId: string, value: unknown): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Channel Instance '${instanceId}' Telegram setting 'activation' must be an object`);
	const activation = value as Record<string, unknown>;
	for (const key of Object.keys(activation)) if (!["mode", "respondTo", "ambientObservation", "activeThreadTtlMs", "maxActiveThreads"].includes(key)) throw new Error(`Channel Instance '${instanceId}' has unknown Telegram activation setting '${key}'`);
	if (activation.mode !== undefined && !["disabled", "explicit", "contextual", "ambient"].includes(String(activation.mode))) throw new Error(`Channel Instance '${instanceId}' Telegram activation mode is invalid`);
	if (activation.respondTo !== undefined && (!Array.isArray(activation.respondTo) || !(activation.respondTo as unknown[]).every((signal) => ["mention", "reply", "active_thread", "command"].includes(String(signal))))) throw new Error(`Channel Instance '${instanceId}' Telegram activation respondTo is invalid`);
	if (activation.ambientObservation !== undefined && typeof activation.ambientObservation !== "boolean") throw new Error(`Channel Instance '${instanceId}' Telegram activation ambientObservation must be boolean`);
	for (const key of ["activeThreadTtlMs", "maxActiveThreads"]) if (activation[key] !== undefined && (!Number.isSafeInteger(activation[key]) || Number(activation[key]) < 1)) throw new Error(`Channel Instance '${instanceId}' Telegram activation ${key} must be a positive integer`);
}

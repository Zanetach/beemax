import type { ChannelAdapterRegistration, ChannelInstanceConfig } from "@beemax/channel-runtime";
import { TelegramAdapter, type TelegramAdapterDependencies, type TelegramSettings } from "./adapter.ts";

export interface TelegramCredentials { botToken: string; }
export interface TelegramAdapterRegistrationOptions {
	defaults: Omit<TelegramSettings, "botToken"> | ((instance: ChannelInstanceConfig) => Omit<TelegramSettings, "botToken">);
	resolveCredentials(instance: ChannelInstanceConfig): TelegramCredentials | undefined;
	dependencies?: TelegramAdapterDependencies;
	onCreated?: (instance: ChannelInstanceConfig, adapter: TelegramAdapter) => void;
}

const INSTANCE_KEYS = new Set<keyof TelegramSettings>(["allowedUsers", "allowedChats", "allowAllUsers", "pollingTimeoutSeconds", "retryBaseDelayMs", "apiBaseUrl", "mediaMaxBytes"]);

export function createTelegramAdapterRegistration(options: TelegramAdapterRegistrationOptions): ChannelAdapterRegistration {
	return {
		id: "telegram",
		create: (instance) => {
			if (instance.adapter !== "telegram") throw new Error(`Telegram registration cannot create Adapter '${instance.adapter}' for Channel Instance '${instance.id}'`);
			const credentials = options.resolveCredentials(instance);
			if (!credentials?.botToken.trim()) throw new Error(`Channel Instance '${instance.id}' is missing Telegram credentials for '${instance.credentialRef ?? "no Credential Ref"}'`);
			const defaults = typeof options.defaults === "function" ? options.defaults(instance) : options.defaults;
			const settings = normalizeTelegramInstanceSettings(instance.id, instance.settings, defaults);
			const adapter = new TelegramAdapter({ ...settings, botToken: credentials.botToken.trim() }, options.dependencies);
			options.onCreated?.(instance, adapter);
			return adapter;
		},
	};
}

export function normalizeTelegramInstanceSettings(instanceId: string, value: unknown, defaults: Omit<TelegramSettings, "botToken">): Omit<TelegramSettings, "botToken"> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Channel Instance '${instanceId}' Telegram settings must be an object`);
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) if (!INSTANCE_KEYS.has(key as keyof TelegramSettings)) throw new Error(`Channel Instance '${instanceId}' has unknown Telegram setting '${key}'`);
	for (const key of ["allowedUsers", "allowedChats"]) if (input[key] !== undefined && (!Array.isArray(input[key]) || !(input[key] as unknown[]).every((entry) => typeof entry === "string"))) throw new Error(`Channel Instance '${instanceId}' Telegram setting '${key}' must be a string array`);
	if (input.allowAllUsers !== undefined && typeof input.allowAllUsers !== "boolean") throw new Error(`Channel Instance '${instanceId}' Telegram setting 'allowAllUsers' must be boolean`);
	if (input.apiBaseUrl !== undefined && typeof input.apiBaseUrl !== "string") throw new Error(`Channel Instance '${instanceId}' Telegram setting 'apiBaseUrl' must be string`);
	for (const key of ["pollingTimeoutSeconds", "retryBaseDelayMs", "mediaMaxBytes"]) if (input[key] !== undefined && (typeof input[key] !== "number" || !Number.isFinite(input[key]))) throw new Error(`Channel Instance '${instanceId}' Telegram setting '${key}' must be a finite number`);
	return { ...defaults, ...input } as Omit<TelegramSettings, "botToken">;
}

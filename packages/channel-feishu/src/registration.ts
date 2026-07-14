import type { ChannelAdapterRegistration, ChannelInstanceConfig } from "@beemax/channel-runtime";
import { FeishuAdapter, type FeishuAdapterDependencies } from "./adapter.ts";
import type { FeishuCredentialConsumer, FeishuCredentials, FeishuRuntimeSettings } from "./settings.ts";

export interface FeishuAdapterRegistrationOptions {
	defaults: FeishuRuntimeSettings | ((instance: ChannelInstanceConfig) => FeishuRuntimeSettings);
	consumeCredentials<T>(instance: ChannelInstanceConfig, consumer: (credentials: Readonly<FeishuCredentials>) => T): T | undefined;
	dependencies?: FeishuAdapterDependencies;
	onCreated?: (instance: ChannelInstanceConfig, adapter: FeishuAdapter) => void;
}

const INSTANCE_KEYS = new Set<keyof FeishuRuntimeSettings>([
	"domain", "connectionMode", "webhookHost", "webhookPort", "webhookPath",
	"requireMention", "activation", "allowedUsers", "allowedChats", "allowAllUsers", "groupPolicy", "groupRules", "admins",
	"botOpenId", "botName", "textBatchDelayMs", "textBatchSplitDelayMs", "textBatchMaxMessages", "textBatchMaxChars",
	"mediaBatchDelayMs", "retryBaseDelayMs",
]);

export function createFeishuAdapterRegistration(options: FeishuAdapterRegistrationOptions): ChannelAdapterRegistration {
	return {
		id: "feishu",
		create: (instance) => {
			if (instance.adapter !== "feishu") throw new Error(`Feishu registration cannot create Adapter '${instance.adapter}' for Channel Instance '${instance.id}'`);
			const valid = options.consumeCredentials(instance, (credentials) => Boolean(credentials.appId.trim() && credentials.appSecret.trim()));
			if (!valid) throw new Error(`Channel Instance '${instance.id}' is missing Feishu credentials for '${instance.credentialRef ?? "no Credential Ref"}'`);
			const defaults = typeof options.defaults === "function" ? options.defaults(instance) : options.defaults;
			const settings = normalizeFeishuInstanceSettings(instance.id, instance.settings, defaults);
			const consume: FeishuCredentialConsumer = (consumer) => options.consumeCredentials(instance, consumer);
			const adapter = new FeishuAdapter(settings, consume, options.dependencies);
			options.onCreated?.(instance, adapter);
			return adapter;
		},
	};
}

export function normalizeFeishuInstanceSettings(instanceId: string, value: unknown, defaults: FeishuRuntimeSettings): FeishuRuntimeSettings {
	const input = record(value, instanceId);
	for (const key of Object.keys(input)) {
		if (!INSTANCE_KEYS.has(key as keyof FeishuRuntimeSettings)) throw new Error(`Channel Instance '${instanceId}' has unknown Feishu setting '${key}'`);
	}
	stringEnum(input, "domain", ["feishu", "lark"], instanceId);
	stringEnum(input, "connectionMode", ["websocket", "webhook"], instanceId);
	stringEnum(input, "groupPolicy", ["open", "allowlist", "disabled"], instanceId);
	for (const key of ["webhookHost", "webhookPath", "botOpenId", "botName"]) optionalType(input, key, "string", instanceId);
	for (const key of ["requireMention", "allowAllUsers"]) optionalType(input, key, "boolean", instanceId);
	for (const key of ["webhookPort", "textBatchDelayMs", "textBatchSplitDelayMs", "textBatchMaxMessages", "textBatchMaxChars", "mediaBatchDelayMs", "retryBaseDelayMs"]) optionalFiniteNumber(input, key, instanceId);
	for (const key of ["allowedUsers", "allowedChats", "admins"]) optionalStringArray(input, key, instanceId);
	for (const key of ["activation", "groupRules"]) optionalRecord(input, key, instanceId);
	return { ...defaults, ...input } as FeishuRuntimeSettings;
}

function record(value: unknown, instanceId: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Channel Instance '${instanceId}' Feishu settings must be an object`);
	return value as Record<string, unknown>;
}
function optionalType(value: Record<string, unknown>, key: string, type: "string" | "boolean", id: string): void { if (value[key] !== undefined && typeof value[key] !== type) throw new Error(`Channel Instance '${id}' Feishu setting '${key}' must be ${type}`); }
function optionalFiniteNumber(value: Record<string, unknown>, key: string, id: string): void { if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) throw new Error(`Channel Instance '${id}' Feishu setting '${key}' must be a finite number`); }
function optionalStringArray(value: Record<string, unknown>, key: string, id: string): void { if (value[key] !== undefined && (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((entry) => typeof entry === "string"))) throw new Error(`Channel Instance '${id}' Feishu setting '${key}' must be a string array`); }
function optionalRecord(value: Record<string, unknown>, key: string, id: string): void { if (value[key] !== undefined && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) throw new Error(`Channel Instance '${id}' Feishu setting '${key}' must be an object`); }
function stringEnum(value: Record<string, unknown>, key: string, allowed: readonly string[], id: string): void { if (value[key] !== undefined && (typeof value[key] !== "string" || !allowed.includes(value[key]))) throw new Error(`Channel Instance '${id}' Feishu setting '${key}' must be one of: ${allowed.join(", ")}`); }

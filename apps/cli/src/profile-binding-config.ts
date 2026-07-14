import { assertProfileBindingConfiguration, type ProfileBinding } from "@beemax/gateway";
import { mutateProfileConfig } from "./profile-config-transaction.ts";

/**
 * Atomically changes one existing Binding without ever publishing an invalid
 * routing authority. The exclusive lock prevents concurrent CLI writers from
 * validating stale snapshots and silently replacing each other.
 */
export async function setProfileBindingEnabled(
	configPath: string,
	bindingId: string,
	enabled: boolean,
	profileId: string,
): Promise<void> {
	const id = bindingId.trim();
	if (!id) throw new Error("Profile Binding id is required");
	await mutateProfileConfig(configPath, (config) => {
		const gateway = asRecord(config.gateway);
		if (!Array.isArray(gateway.bindings)) throw new Error(`Profile Binding was not found: ${id}`);
		const rawBindings = gateway.bindings.map((binding) => ({ ...asRecord(binding) }));
		const matching = rawBindings.map((binding, index) => stringValue(binding.id) === id ? index : -1).filter((index) => index >= 0);
		if (!matching.length) throw new Error(`Profile Binding was not found: ${id}`);
		if (matching.length > 1) throw new Error(`Profile Binding id is ambiguous: ${id}`);
		rawBindings[matching[0]!] = { ...rawBindings[matching[0]!]!, enabled };
		const bindings = rawBindings.map(normalizeBinding);
		assertUniqueBindingIds(bindings);
		assertProfileBindingConfiguration(bindings, {
			profileId,
			channelInstanceIds: enabledChannelInstanceIds(gateway.channels),
		});
		config.gateway = { ...gateway, bindings: rawBindings };
	});
}

function assertUniqueBindingIds(bindings: readonly ProfileBinding[]): void {
	const ids = new Set<string>();
	for (const binding of bindings) {
		if (!binding.id) throw new Error("Profile Binding requires a stable id");
		if (ids.has(binding.id)) throw new Error(`Duplicate Profile Binding id: ${binding.id}`);
		ids.add(binding.id);
	}
}

function enabledChannelInstanceIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(asRecord).filter((channel) => channel.enabled !== false).map((channel) => stringValue(channel.id)).filter(Boolean);
}

function normalizeBinding(value: unknown): ProfileBinding {
	const binding = asRecord(value);
	return {
		id: stringValue(binding.id),
		profileId: stringValue(binding.profileId),
		channelInstanceId: stringValue(binding.channelInstanceId),
		...(stringValue(binding.accountRef) ? { accountRef: stringValue(binding.accountRef) } : {}),
		...(stringValue(binding.conversationId) ? { conversationId: stringValue(binding.conversationId) } : {}),
		...(stringValue(binding.threadId) ? { threadId: stringValue(binding.threadId) } : {}),
		...(typeof binding.enabled === "boolean" ? { enabled: binding.enabled } : {}),
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

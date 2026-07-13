import type { PlatformAdapter } from "./types.ts";

export interface ChannelInstanceConfig {
	id: string;
	adapter: string;
	enabled: boolean;
	credentialRef?: string;
	settings: unknown;
}

export interface ChannelAdapterRegistration {
	id: string;
	create(instance: ChannelInstanceConfig): PlatformAdapter;
}

export type ChannelLifecycleState = "idle" | "connecting" | "connected" | "failed" | "paused" | "stopped";

export interface ChannelStatus {
	id: string;
	adapter: string;
	platform: string;
	state: ChannelLifecycleState;
	attempts: number;
	lastError?: string;
}

export interface ChannelHostSnapshot {
	channels: ChannelStatus[];
}

export interface ChannelAdapterResolver {
	resolveAdapter(platform: string): PlatformAdapter;
}

export interface ChannelHostOptions {
	connectAttempts?: number;
	retryBaseDelayMs?: number;
	retryMaxDelayMs?: number;
}

interface HostedChannel {
	config: ChannelInstanceConfig;
	adapter: PlatformAdapter;
	state: ChannelLifecycleState;
	attempts: number;
	lastError?: string;
}

/** Registry-only adapter creation keeps platform SDKs outside Core and the Agent Runtime. */
export class AdapterRegistry {
	private readonly registrations = new Map<string, ChannelAdapterRegistration>();

	register(registration: ChannelAdapterRegistration): this {
		const id = registration.id.trim();
		if (!id) throw new Error("Channel adapter id is required");
		if (this.registrations.has(id)) throw new Error(`Channel adapter is already registered: ${id}`);
		this.registrations.set(id, { ...registration, id });
		return this;
	}

	create(instance: ChannelInstanceConfig): PlatformAdapter {
		const registration = this.registrations.get(instance.adapter);
		if (!registration) throw new Error(`Unknown channel adapter: ${instance.adapter}`);
		const adapter = registration.create(instance);
		if (!adapter || typeof adapter.name !== "string" || !adapter.name.trim()) {
			throw new Error(`Channel adapter ${instance.adapter} returned an invalid platform adapter`);
		}
		return adapter;
	}

	has(id: string): boolean { return this.registrations.has(id); }
	ids(): string[] { return [...this.registrations.keys()].sort(); }
}

/**
 * Profile-scoped host for channel connection lifecycles.
 *
 * It deliberately owns no Task, Memory, Policy, Effect, Verification, or Pi
 * state. One host can attach several adapters to the same Profile Runtime.
 */
export class ChannelHost implements ChannelAdapterResolver {
	private readonly channels = new Map<string, HostedChannel>();
	private readonly platformIndex = new Map<string, HostedChannel>();
	private readonly options: Required<ChannelHostOptions>;

	constructor(registry: AdapterRegistry, instances: ChannelInstanceConfig[], options: ChannelHostOptions = {}) {
		this.options = {
			connectAttempts: boundedInteger(options.connectAttempts, 3, 1, 20),
			retryBaseDelayMs: boundedInteger(options.retryBaseDelayMs, 1_000, 0, 60_000),
			retryMaxDelayMs: boundedInteger(options.retryMaxDelayMs, 30_000, 0, 300_000),
		};
		for (const instance of instances) {
			if (!instance.enabled) continue;
			if (!instance.id.trim()) throw new Error("Channel instance id is required");
			if (this.channels.has(instance.id)) throw new Error(`Duplicate channel instance id: ${instance.id}`);
			const adapter = registry.create(instance);
			if (this.platformIndex.has(adapter.name)) throw new Error(`Duplicate active channel platform: ${adapter.name}`);
			const channel: HostedChannel = { config: instance, adapter, state: "idle", attempts: 0 };
			this.channels.set(instance.id, channel);
			this.platformIndex.set(adapter.name, channel);
		}
	}

	adapters(): PlatformAdapter[] { return [...this.channels.values()].map((channel) => channel.adapter); }

	adapter(instanceId: string): PlatformAdapter {
		const channel = this.channels.get(instanceId);
		if (!channel) throw new Error(`Unknown channel instance: ${instanceId}`);
		return channel.adapter;
	}

	resolveAdapter(platform: string): PlatformAdapter {
		const channel = this.platformIndex.get(platform);
		if (!channel) throw new Error(`No channel adapter is registered for platform: ${platform}`);
		if (channel.state === "paused") throw new Error(`Channel adapter is paused: ${platform}`);
		if (channel.state !== "connected" || !channel.adapter.isConnected) throw new Error(`Channel adapter is not connected: ${platform}`);
		return channel.adapter;
	}

	status(): ChannelHostSnapshot {
		return { channels: [...this.channels.values()].map((channel) => ({
			id: channel.config.id,
			adapter: channel.config.adapter,
			platform: channel.adapter.name,
			state: channel.state,
			attempts: channel.attempts,
			...(channel.lastError ? { lastError: channel.lastError } : {}),
		})) };
	}

	async start(): Promise<ChannelHostSnapshot> {
		if (!this.channels.size) throw new Error("No enabled channel adapters are configured");
		await Promise.all([...this.channels.values()].map((channel) => this.connectChannel(channel)));
		const snapshot = this.status();
		if (!snapshot.channels.some((channel) => channel.state === "connected")) {
			throw new Error(`All channel adapters failed to connect: ${snapshot.channels.map((channel) => `${channel.id}: ${channel.lastError ?? "connection rejected"}`).join("; ")}`);
		}
		return snapshot;
	}

	async pause(instanceId: string): Promise<void> {
		const channel = this.requireChannel(instanceId);
		await channel.adapter.disconnect();
		channel.state = "paused";
	}

	async resume(instanceId: string): Promise<ChannelStatus> {
		const channel = this.requireChannel(instanceId);
		if (channel.state !== "paused" && channel.state !== "failed" && channel.state !== "stopped") {
			throw new Error(`Channel ${instanceId} cannot resume from ${channel.state}`);
		}
		channel.attempts = 0;
		channel.lastError = undefined;
		await this.connectChannel(channel);
		return this.status().channels.find((candidate) => candidate.id === instanceId)!;
	}

	async stop(): Promise<void> {
		await Promise.allSettled([...this.channels.values()].map(async (channel) => {
			try { await channel.adapter.disconnect(); }
			finally { channel.state = "stopped"; }
		}));
	}

	private requireChannel(instanceId: string): HostedChannel {
		const channel = this.channels.get(instanceId);
		if (!channel) throw new Error(`Unknown channel instance: ${instanceId}`);
		return channel;
	}

	private async connectChannel(channel: HostedChannel): Promise<void> {
		channel.state = "connecting";
		for (let attempt = 1; attempt <= this.options.connectAttempts; attempt++) {
			channel.attempts = attempt;
			try {
				if (await channel.adapter.connect()) {
					channel.state = "connected";
					channel.lastError = undefined;
					return;
				}
				channel.lastError = "connection rejected";
			} catch (error) {
				channel.lastError = safeError(error);
			}
			if (attempt < this.options.connectAttempts) {
				const delay = Math.min(this.options.retryMaxDelayMs, this.options.retryBaseDelayMs * 2 ** (attempt - 1));
				if (delay) await wait(delay);
			}
		}
		channel.state = "failed";
	}
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value!)));
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

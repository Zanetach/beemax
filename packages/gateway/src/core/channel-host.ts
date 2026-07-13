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
	connectTimeoutMs?: number;
	retryBaseDelayMs?: number;
	retryMaxDelayMs?: number;
	supervisionIntervalMs?: number;
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
	private readonly reconnecting = new Map<HostedChannel, Promise<void>>();
	private supervisorTimer?: ReturnType<typeof setInterval>;
	private stopping = false;

	constructor(registry: AdapterRegistry, instances: ChannelInstanceConfig[], options: ChannelHostOptions = {}) {
		this.options = {
			connectAttempts: boundedInteger(options.connectAttempts, 3, 1, 20),
			connectTimeoutMs: boundedInteger(options.connectTimeoutMs, 30_000, 1, 5 * 60_000),
			retryBaseDelayMs: boundedInteger(options.retryBaseDelayMs, 1_000, 0, 60_000),
			retryMaxDelayMs: boundedInteger(options.retryMaxDelayMs, 30_000, 0, 300_000),
			supervisionIntervalMs: boundedInteger(options.supervisionIntervalMs, 5_000, 1, 60_000),
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
		this.stopping = false;
		await Promise.all([...this.channels.values()].map((channel) => this.connectChannel(channel)));
		const snapshot = this.status();
		if (!snapshot.channels.some((channel) => channel.state === "connected")) {
			throw new Error(`All channel adapters failed to connect: ${snapshot.channels.map((channel) => `${channel.id}: ${channel.lastError ?? "connection rejected"}`).join("; ")}`);
		}
		this.startSupervisor();
		return snapshot;
	}

	async pause(instanceId: string): Promise<void> {
		const channel = this.requireChannel(instanceId);
		channel.state = "paused";
		await channel.adapter.disconnect();
	}

	async resume(instanceId: string): Promise<ChannelStatus> {
		const channel = this.requireChannel(instanceId);
		if (channel.state !== "paused" && channel.state !== "failed" && channel.state !== "stopped") {
			throw new Error(`Channel ${instanceId} cannot resume from ${channel.state}`);
		}
		channel.attempts = 0;
		channel.lastError = undefined;
		channel.state = "idle";
		await this.connectChannel(channel);
		return this.status().channels.find((candidate) => candidate.id === instanceId)!;
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.supervisorTimer) clearInterval(this.supervisorTimer);
		this.supervisorTimer = undefined;
		await Promise.allSettled([...this.channels.values()].map(async (channel) => {
			try { await channel.adapter.disconnect(); }
			finally { channel.state = "stopped"; }
		}));
		if (this.reconnecting.size) await Promise.allSettled([...this.reconnecting.values()]);
	}

	private requireChannel(instanceId: string): HostedChannel {
		const channel = this.channels.get(instanceId);
		if (!channel) throw new Error(`Unknown channel instance: ${instanceId}`);
		return channel;
	}

	private async connectChannel(channel: HostedChannel): Promise<void> {
		if (this.stopping || isPaused(channel)) return;
		channel.state = "connecting";
		for (let attempt = 1; attempt <= this.options.connectAttempts; attempt++) {
			channel.attempts = attempt;
			try {
				if (await settleWithin(channel.adapter.connect(), this.options.connectTimeoutMs, `Channel ${channel.config.id} connection timed out`)) {
					if (this.stopping || isPaused(channel)) {
						await settleWithin(channel.adapter.disconnect(), Math.min(this.options.connectTimeoutMs, 5_000), `Channel ${channel.config.id} cleanup timed out`).catch(() => undefined);
						channel.state = this.stopping ? "stopped" : "paused";
						return;
					}
					channel.state = "connected";
					channel.lastError = undefined;
					return;
				}
				channel.lastError = "connection rejected";
			} catch (error) {
				if (this.stopping || isPaused(channel)) return;
				channel.lastError = safeError(error);
				await settleWithin(channel.adapter.disconnect(), Math.min(this.options.connectTimeoutMs, 5_000), `Channel ${channel.config.id} cleanup timed out`).catch(() => undefined);
			}
			if (attempt < this.options.connectAttempts) {
				const delay = Math.min(this.options.retryMaxDelayMs, this.options.retryBaseDelayMs * 2 ** (attempt - 1));
				if (delay) await wait(delay);
			}
		}
		if (!this.stopping && !isPaused(channel)) channel.state = "failed";
	}

	private startSupervisor(): void {
		if (this.supervisorTimer) clearInterval(this.supervisorTimer);
		this.supervisorTimer = setInterval(() => this.supervise(), this.options.supervisionIntervalMs);
		this.supervisorTimer.unref?.();
	}

	private supervise(): void {
		if (this.stopping) return;
		for (const channel of this.channels.values()) {
			const disconnected = channel.state === "connected" && !channel.adapter.isConnected;
			if (!disconnected && channel.state !== "failed") continue;
			if (this.reconnecting.has(channel)) continue;
			channel.attempts = 0;
			const work = this.connectChannel(channel).catch((error) => { channel.lastError = safeError(error); channel.state = "failed"; }).finally(() => this.reconnecting.delete(channel));
			this.reconnecting.set(channel, work);
		}
	}
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value!)));
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function isPaused(channel: HostedChannel): boolean { return channel.state === "paused"; }

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function settleWithin<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
		]);
	} finally { if (timer) clearTimeout(timer); }
}
